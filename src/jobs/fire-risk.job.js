'use strict';

/**
 * Fire Risk Cron Job (EP-06).
 *
 * Tick 1 (daily, FIRE_RISK_CRON = '0 23 * * *' → 06:00 VN):
 *   → runAnalysis(today) — tính stats từ GEE, lưu DB
 *   → nếu GCS được cấu hình: submit raster export task
 *
 * Tick 2 (mỗi 30 phút, để poll task GEE export đang chạy):
 *   → pollExports() — kiểm tra task COMPLETED → harvest GeoServer
 *
 * Cleanup: mỗi tuần xóa snapshot cũ hơn SNAPSHOT_GRACE_DAYS ngày.
 */

const cron = require('node-cron');
const cfg  = require('../configs/fire-risk');
const svc  = require('../services/fire-risk.service');
const repo = require('../repositories/fire-risk.repository');

// Daily analysis cron (default 23:00 UTC = 06:00 VN +7).
const ANALYSIS_CRON = cfg.CRON;

// Poll export tasks every 30 min.
const POLL_CRON     = process.env.FIRE_RISK_POLL_CRON || '*/30 * * * *';

// Weekly cleanup: Sunday 01:00 UTC.
const CLEANUP_CRON  = '0 1 * * 0';

let analysisTask = null;
let pollTask     = null;
let cleanupTask  = null;

// ── Handlers ──────────────────────────────────────────────────────────────────

const runDailyAnalysis = async () => {
    const today = svc.todayUtc();
    console.log(`[FIRE RISK] Starting daily analysis for ${today}`);
    try {
        const snap = await svc.runAnalysis(today);
        console.log(
            `[FIRE RISK] Analysis done. status=${snap.status} ` +
            `riskLevel5Ha=${snap.province_summary?.riskLevelDist?.[5] || 0} ` +
            (snap.gee_task_id ? `geeTask=${snap.gee_task_id}` : 'no export'),
        );
    } catch (err) {
        console.error(`[FIRE RISK] Daily analysis failed: ${err.message}`);
    }
};

const runPollExports = async () => {
    try {
        await svc.pollExports();
    } catch (err) {
        console.error(`[FIRE RISK] pollExports error: ${err.message}`);
    }
};

const runCleanup = async () => {
    try {
        const deleted = await repo.deleteOld(cfg.SNAPSHOT_GRACE_DAYS);
        if (deleted > 0) {
            console.log(`[FIRE RISK] Cleanup: deleted ${deleted} old snapshots`);
        }
    } catch (err) {
        console.error(`[FIRE RISK] Cleanup error: ${err.message}`);
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

    analysisTask = cron.schedule(ANALYSIS_CRON, runDailyAnalysis, { missedExecutionTolerance: 30000 });
    pollTask     = cron.schedule(POLL_CRON,     runPollExports,   { missedExecutionTolerance: 30000 });
    cleanupTask  = cron.schedule(CLEANUP_CRON,  runCleanup,       { missedExecutionTolerance: 30000 });

    console.log(`  ✓ Fire risk analysis job scheduled (${ANALYSIS_CRON})`);
    console.log(`  ✓ Fire risk export poll job scheduled (${POLL_CRON})`);
};

const stop = () => {
    [analysisTask, pollTask, cleanupTask].forEach((t) => { if (t) t.stop(); });
    analysisTask = null;
    pollTask     = null;
    cleanupTask  = null;
};

module.exports = { start, stop, runDailyAnalysis, runPollExports };
