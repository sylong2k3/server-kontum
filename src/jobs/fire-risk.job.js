'use strict';

/**
 * Fire Risk Cron Job (EP-06).
 *
 * Tick 1 (daily, FIRE_RISK_CRON = '0 23 * * *' → 06:00 VN):
 *   → runAnalysis(today) — tính stats từ GEE, lưu DB
 *   → nếu GCS được cấu hình: submit raster export task
 *   → auto-enqueue raster-ingest (MinIO → GeoServer), back-link snapshot
 *
 * Tick 2 (mỗi 30 phút, để poll task GEE export đang chạy):
 *   → pollExports() — kiểm tra task COMPLETED → harvest GeoServer
 *
 * Cleanup: ĐÃ BỎ. Chính sách hiện tại là "giữ toàn bộ lịch sử snapshot" —
 * không xoá bất kỳ hàng nào để đảm bảo audit + so sánh long-term. Nếu về sau
 * cần dọn, ưu tiên archive ra bảng history riêng thay vì DELETE.
 *
 * Debug: bật FIRE_RISK_DEBUG=true (hoặc NODE_ENV=development) để thấy chi tiết
 * mỗi tick + counters. Log info luôn ghi bất kể flag để trace state transitions.
 */

const cron = require('node-cron');
const cfg  = require('../configs/fire-risk');
const svc  = require('../services/fire-risk.service');
const repo = require('../repositories/fire-risk.repository');

// Daily analysis cron: mặc định 06:00 sáng VN. Cron string đọc theo TZ đã set
// ở lifecycle.start (FIRE_RISK_CRON_TZ, mặc định Asia/Ho_Chi_Minh).
// Nếu env FIRE_RISK_CRON không set, mặc định "0 6 * * *" (06:00 VN).
const ANALYSIS_CRON = process.env.FIRE_RISK_CRON || cfg.CRON || '0 6 * * *';

// Poll export tasks every 30 min.
const POLL_CRON     = process.env.FIRE_RISK_POLL_CRON || '*/30 * * * *';

const DEBUG = process.env.FIRE_RISK_DEBUG === 'true'
    || process.env.NODE_ENV === 'development';
const dbg = (msg) => { if (DEBUG) console.debug(`[FIRE-RISK-JOB] ${msg}`); };

let analysisTask = null;
let pollTask     = null;

// Overlap protection cho poll (30-min tick nhưng GCS→MinIO→GeoServer harvest
// đôi khi mất > 30 min khi có nhiều task cùng lúc).
let pollRunning     = false;
let analysisRunning = false;

// Counters — log định kỳ khi idle để chứng minh cron vẫn chạy.
let pollTicks     = 0;
let pollIdleTicks = 0;

// ── Handlers ──────────────────────────────────────────────────────────────────

const runDailyAnalysis = async () => {
    if (analysisRunning) {
        console.warn('[FIRE RISK] Daily analysis skipped: previous run still active');
        return;
    }
    analysisRunning = true;
    const t0 = Date.now();
    const today = svc.todayUtc();
    console.log(`[FIRE RISK] Daily analysis START date=${today} gcs=${cfg.isGcsConfigured() ? 'on' : 'off'}`);
    try {
        const snap = await svc.runAnalysis(today);
        const riskDist = snap.province_summary?.riskLevelDist || {};
        console.log(
            `[FIRE RISK] Daily analysis DONE date=${today} status=${snap.status} ` +
            `snapshotId=${snap.id || '-'} ` +
            `riskLevel5Ha=${Math.round(riskDist[5] || 0)} riskLevel4Ha=${Math.round(riskDist[4] || 0)} ` +
            `gtZones=${snap.gt_zone_count ?? 0} gtPoints=${snap.gt_point_count ?? 0} ` +
            (snap.gee_task_id ? `geeTask=${snap.gee_task_id} ` : 'no export ') +
            `elapsed=${Date.now() - t0}ms`,
        );
        dbg(`riskDist=${JSON.stringify(riskDist)}`);
    } catch (err) {
        console.error(`[FIRE RISK] Daily analysis FAILED date=${today} elapsed=${Date.now() - t0}ms — ${err.code || err.name || 'ERR'}: ${err.message}`);
        if (DEBUG && err.stack) console.debug(err.stack);
    } finally {
        analysisRunning = false;
    }
};

const runPollExports = async () => {
    if (pollRunning) {
        console.warn('[FIRE RISK] pollExports SKIPPED: previous run still active');
        return;
    }
    pollRunning = true;
    pollTicks  += 1;
    const t0    = Date.now();
    try {
        const pending = await repo.listExporting().catch(() => []);
        dbg(`pollExports tick ${pollTicks} — ${pending.length} exporting snapshot(s)`);

        await svc.pollExports();

        if (pending.length === 0) {
            pollIdleTicks += 1;
            if (pollIdleTicks % 24 === 0) {
                console.log(`[FIRE RISK] pollExports IDLE ${pollIdleTicks}/${pollTicks} ticks (no exports pending)`);
            }
        } else {
            console.log(`[FIRE RISK] pollExports DONE processed=${pending.length} elapsed=${Date.now() - t0}ms`);
        }
    } catch (err) {
        console.error(`[FIRE RISK] pollExports ERROR elapsed=${Date.now() - t0}ms — ${err.code || err.name || 'ERR'}: ${err.message}`);
        if (DEBUG && err.stack) console.debug(err.stack);
    } finally {
        pollRunning = false;
    }
};

// ── Lifecycle ─────────────────────────────────────────────────────────────────

const start = () => {
    if (analysisTask) { return; }

    if (!cron.validate(ANALYSIS_CRON)) {
        console.warn(`[FIRE RISK] Invalid cron "${ANALYSIS_CRON}" — daily job not started`);
        return;
    }
    if (!cron.validate(POLL_CRON)) {
        console.warn(`[FIRE RISK] Invalid poll cron "${POLL_CRON}" — poll job not started`);
        return;
    }

    // Timezone: mặc định Asia/Ho_Chi_Minh — cron string "0 6 * * *" nghĩa là
    // 06:00 sáng VN thực. Override bằng FIRE_RISK_CRON_TZ nếu triển khai đa
    // region cần tz khác.
    const cronOpts = { timezone: process.env.FIRE_RISK_CRON_TZ || 'Asia/Ho_Chi_Minh' };

    analysisTask = cron.schedule(ANALYSIS_CRON, runDailyAnalysis, cronOpts);
    pollTask     = cron.schedule(POLL_CRON,     runPollExports,   cronOpts);

    console.log(
        `[FIRE RISK] STARTED analysis="${ANALYSIS_CRON}" poll="${POLL_CRON}" ` +
        `timezone=${cronOpts.timezone} ` +
        `gcsConfigured=${cfg.isGcsConfigured() ? 'yes' : 'NO — raster export skipped'} ` +
        `debug=${DEBUG} snapshot_retention=UNLIMITED (cleanup disabled)`,
    );
    console.log(`  ✓ Fire risk analysis job scheduled (${ANALYSIS_CRON} @ ${cronOpts.timezone})`);
    console.log(`  ✓ Fire risk export poll job scheduled (${POLL_CRON})`);
};

const stop = () => {
    [analysisTask, pollTask].forEach((t) => { if (t) t.stop(); });
    analysisTask = null;
    pollTask     = null;
    console.log(`[FIRE RISK] STOPPED — pollTicks=${pollTicks} pollIdle=${pollIdleTicks}`);
};

module.exports = { start, stop, runDailyAnalysis, runPollExports };
