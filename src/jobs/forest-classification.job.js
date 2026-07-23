'use strict';

/**
 * Forest Classification Cron Job (v3 — lite mode, no GCS poll).
 *
 * Tick 1 (daily, FC_CRON = '0 6 * * *' — 06:00 theo TZ):
 *   → guard: skip nếu snapshot completed gần nhất còn trong khoảng
 *     FC_MIN_INTERVAL_DAYS (default 45) ngày.
 *   → nếu đến hạn: runAnalysis(prevYear, prevMonth) — luôn phân tích tháng
 *     TRƯỚC (dữ liệu tháng hiện tại chưa đủ ảnh sạch).
 *   → save district area stats + top-3 changes alert + auto-ingest raster
 *     vào MinIO/GeoServer (như fire-risk, dùng gee_download_url + queue).
 *
 * V3 changes:
 *   - Bỏ hoàn toàn poll cron (svc.pollExports đã xoá) — flow mới không dùng
 *     GCS export path, chỉ dùng getDownloadURL + raster-ingest queue.
 *   - Pipeline chuyển sang liteMode + skipStats để tránh 5-phút timeout ở
 *     stage OOB accuracy evaluate() (root cause fail trước đây).
 *
 * Vì sao dùng daily + guard thay vì cron 45 ngày cứng? Cron pattern không
 * biểu diễn được "every 45 days" nhất quán (day-of-month max 31). Nếu server
 * down đúng ngày cron, snapshot bị skip. Daily guard tự bù: khi restart,
 * handler nhìn last snapshot vẫn nhận biết quá hạn và chạy ngay.
 *
 * Debug: bật FC_DEBUG=true (hoặc NODE_ENV=development) để thấy chi tiết
 * mỗi tick + counters. Log info luôn ghi bất kể flag để trace state.
 */

const cron = require('node-cron');
const cfg  = require('../configs/forest-classification');
const svc  = require('../services/forest-classification.service');
const repo = require('../repositories/forest-classification.repository');

const ANALYSIS_CRON = cfg.CRON;

const DEBUG = process.env.FC_DEBUG === 'true'
    || process.env.NODE_ENV === 'development';
const dbg = (msg) => { if (DEBUG) console.debug(`[FOREST-JOB] ${msg}`); };

let analysisTask = null;

// Overlap protection — daily tick với 45-day guard nên overlap rất hiếm, nhưng
// vẫn giữ flag để phòng edge case (server restart giữa run).
let analysisRunning = false;

// ── Handlers ──────────────────────────────────────────────────────────────────

// Query latest completed snapshot's computed_at → compare với now. Trả số
// ngày kể từ lần chạy gần nhất, hoặc Infinity nếu chưa có snapshot.
async function _daysSinceLastCompleted() {
    try {
        const snap = await repo.getLatestCompleted();
        if (!snap?.computed_at) return Infinity;
        const last = new Date(snap.computed_at).getTime();
        return (Date.now() - last) / (1000 * 60 * 60 * 24);
    } catch (err) {
        console.warn(`[FOREST] getLatestCompleted failed (treat as no snapshot): ${err.message}`);
        return Infinity;
    }
}

const runScheduledAnalysis = async () => {
    if (analysisRunning) {
        console.warn('[FOREST] scheduled classification skipped: previous run still active');
        return;
    }
    const t0 = Date.now();

    // Guard 45-day interval — cron chạy daily nhưng chỉ trigger analysis khi
    // đến hạn. Cho phép ép chạy bằng FC_FORCE_ANALYSIS=true (dev/test).
    const daysSince = await _daysSinceLastCompleted();
    const minInterval = cfg.MIN_INTERVAL_DAYS;
    const force = process.env.FC_FORCE_ANALYSIS === 'true';
    if (!force && daysSince < minInterval) {
        dbg(`skip — daysSince=${daysSince.toFixed(1)} < minInterval=${minInterval}. Next run ≈ ${(minInterval - daysSince).toFixed(1)}d`);
        return;
    }

    analysisRunning = true;
    const now   = new Date();
    // Run for the previous month — e.g. on July 1 we classify June.
    // Build the anchor in UTC so year/month reads back consistently regardless
    // of the host timezone. `new Date(y, m, 1)` (local) → getUTC*() mixes clocks.
    const d     = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const year  = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;

    console.log(
        `[FOREST] scheduled classification START period=${year}/${month} ` +
        `daysSinceLast=${daysSince === Infinity ? '∞' : daysSince.toFixed(1)} ` +
        `minInterval=${minInterval}${force ? ' (forced)' : ''} ` +
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
    const cronOpts = { timezone: process.env.FC_CRON_TZ || 'Asia/Ho_Chi_Minh' };
    analysisTask = cron.schedule(ANALYSIS_CRON, runScheduledAnalysis, cronOpts);

    console.log(
        `[FOREST] STARTED analysis="${ANALYSIS_CRON}" (interval=${cfg.MIN_INTERVAL_DAYS}d) ` +
        `bucket=${cfg.MINIO_BUCKET || '(default)'} alertPct=${cfg.ALERT_CHANGE_PCT ?? '(default)'} debug=${DEBUG}`,
    );
    console.log(`  ✓ Forest classification job scheduled (${ANALYSIS_CRON}, min interval ${cfg.MIN_INTERVAL_DAYS}d)`);
};

const stop = () => {
    if (analysisTask) { analysisTask.stop(); analysisTask = null; }
    console.log('[FOREST] STOPPED');
};

module.exports = { start, stop, runScheduledAnalysis };
