'use strict';

/**
 * Forest Classification Cron Job (v3 — lite mode, no GCS poll).
 *
 * Tick ngày 1 hàng tháng (FC_CRON = '0 0 1 * * *' theo TZ):
 *   → runAnalysis(prevYear, prevMonth) — luôn phân tích tháng vừa kết thúc.
 *   → guard theo đúng year/month, không dựa vào số ngày 28/29/30/31.
 *   → save district area stats + top-3 changes alert + auto-ingest raster
 *     vào MinIO/GeoServer (như fire-risk, dùng gee_download_url + queue).
 *
 * V3 changes:
 *   - Bỏ hoàn toàn poll cron (svc.pollExports đã xoá) — flow mới không dùng
 *     GCS export path, chỉ dùng getDownloadURL + raster-ingest queue.
 *   - Pipeline chuyển sang liteMode + skipStats để tránh 5-phút timeout ở
 *     stage OOB accuracy evaluate() (root cause fail trước đây).
 *
 * Nếu server down đúng ngày 1, startup catch-up kiểm tra kỳ đầy đủ mới nhất và
 * chạy bù. Snapshot completed/published của cùng kỳ sẽ được bỏ qua.
 *
 * Debug: bật FC_DEBUG=true (hoặc NODE_ENV=development) để thấy chi tiết
 * mỗi tick + counters. Log info luôn ghi bất kể flag để trace state.
 */

const cron = require('node-cron');
const cfg  = require('../configs/forest-classification');
const svc  = require('../services/forest-classification.service');
const repo = require('../repositories/forest-classification.repository');

const ANALYSIS_CRON = cfg.CRON;
const CRON_TZ = process.env.FC_CRON_TZ || 'Asia/Ho_Chi_Minh';
const CATCHUP_ENABLED = process.env.FC_CATCHUP_ENABLED !== 'false';
const CATCHUP_DELAY_MS = Math.max(0, Number(process.env.FC_CATCHUP_DELAY_MS) || 60_000);

const DEBUG = process.env.FC_DEBUG === 'true'
    || process.env.NODE_ENV === 'development';
const dbg = (msg) => { if (DEBUG) console.debug(`[FOREST-JOB] ${msg}`); };

let analysisTask = null;
let catchupTimer = null;

// Overlap protection — daily tick với 45-day guard nên overlap rất hiếm, nhưng
// vẫn giữ flag để phòng edge case (server restart giữa run).
let analysisRunning = false;

// ── Handlers ──────────────────────────────────────────────────────────────────

// Kỳ đầy đủ mới nhất theo timezone cron. Ví dụ mọi thời điểm trong tháng 3
// đều trả tháng 2, bất kể tháng 2 có 28 hay 29 ngày.
const resolveTargetPeriod = (now = new Date(), timezone = CRON_TZ) => {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
    }).formatToParts(now);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const currentYear = Number(values.year);
    const currentMonth = Number(values.month);
    const previous = new Date(Date.UTC(currentYear, currentMonth - 2, 1));
    return { year: previous.getUTCFullYear(), month: previous.getUTCMonth() + 1 };
};

const runScheduledAnalysis = async () => {
    if (analysisRunning) {
        console.warn('[FOREST] scheduled classification skipped: previous run still active');
        return;
    }
    const t0 = Date.now();

    const force = process.env.FC_FORCE_ANALYSIS === 'true';
    const { year, month } = resolveTargetPeriod();
    const existing = await repo.getByYearMonth(year, month);
    if (!force && existing && ['completed', 'published'].includes(existing.status)) {
        dbg(`skip — period=${year}/${month} already ${existing.status} snapshotId=${existing.id}`);
        return;
    }
    if (!force && existing && ['pending', 'computing', 'exporting'].includes(existing.status)) {
        console.warn(`[FOREST] scheduled classification skipped: period=${year}/${month} is ${existing.status}`);
        return;
    }

    analysisRunning = true;

    console.log(
        `[FOREST] scheduled classification START period=${year}/${month} ` +
        `timezone=${CRON_TZ}${force ? ' (forced)' : ''} ` +
        `bucket=${cfg.MINIO_BUCKET || '(default)'}`,
    );
    try {
        const snap = await svc.runAnalysis(year, month);
        const summary = snap.province_summary || {};
        let forestHa = 0;
        for (const id of cfg.FOREST_CLASS_IDS) {
            forestHa += summary.byClass?.[id] || 0;
        }
        console.log(
            `[FOREST] scheduled classification DONE period=${year}/${month} ` +
            `snapshotId=${snap.id || '-'} status=${snap.status} ` +
            `forestHa=${Math.round(forestHa).toLocaleString('vi')} ` +
            `hasDlUrl=${Boolean(snap.gee_download_url)} elapsed=${Date.now() - t0}ms`,
        );
        dbg(`byClass=${JSON.stringify(summary.byClass || {})}`);
    } catch (err) {
        console.error(`[FOREST] scheduled classification FAILED period=${year}/${month} elapsed=${Date.now() - t0}ms — ${err.code || err.name || 'ERR'}: ${err.message}`);
        if (DEBUG && err.stack) console.debug(err.stack);
    } finally {
        analysisRunning = false;
    }
};

// ── Lifecycle ─────────────────────────────────────────────────────────────────

const start = () => {
    if (analysisTask) return;

    if (!cron.validate(ANALYSIS_CRON)) {
        console.warn(`[FOREST] Invalid cron "${ANALYSIS_CRON}" — analysis job not started`);
        return;
    }

    // Cùng nguyên tắc như fire-risk: cron string theo VN tz.
    const cronOpts = { timezone: CRON_TZ };
    analysisTask = cron.schedule(ANALYSIS_CRON, runScheduledAnalysis, cronOpts);

    if (CATCHUP_ENABLED) {
        catchupTimer = setTimeout(() => {
            catchupTimer = null;
            runScheduledAnalysis().catch((err) => {
                console.error(`[FOREST] startup catch-up failed: ${err.message}`);
            });
        }, CATCHUP_DELAY_MS);
    }

    console.log(
        `[FOREST] STARTED analysis="${ANALYSIS_CRON}" timezone=${CRON_TZ} ` +
        `catchup=${CATCHUP_ENABLED ? `on/${CATCHUP_DELAY_MS}ms` : 'off'} ` +
        `bucket=${cfg.MINIO_BUCKET || '(default)'} alertPct=${cfg.ALERT_CHANGE_PCT ?? '(default)'} debug=${DEBUG}`,
    );
    console.log(`  ✓ Forest classification job scheduled (${ANALYSIS_CRON} @ ${CRON_TZ}, previous calendar month)`);
};

const stop = () => {
    if (analysisTask) { analysisTask.stop(); analysisTask = null; }
    if (catchupTimer) { clearTimeout(catchupTimer); catchupTimer = null; }
    console.log('[FOREST] STOPPED');
};

module.exports = { start, stop, runScheduledAnalysis, resolveTargetPeriod };
