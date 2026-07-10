'use strict';

/**
 * Forest Classification Cron Job.
 *
 * Tick 1 (monthly, FC_CRON = '0 0 1 * *' → ngày 1 hàng tháng 00:00 UTC = 07:00 VN):
 *   → runAnalysis(currentYear, currentMonth)
 *   → saves district area stats, sends area-change alert if needed
 *   → optionally submits GEE raster export task
 *
 * Tick 2 (every 30 min): poll pending GEE export tasks → publish to GeoServer.
 */

const cron = require('node-cron');
const cfg  = require('../configs/forest-classification');
const svc  = require('../services/forest-classification.service');

const ANALYSIS_CRON = cfg.CRON;
const POLL_CRON     = process.env.FC_POLL_CRON || '*/30 * * * *';

let analysisTask = null;
let pollTask     = null;

// ── Handlers ──────────────────────────────────────────────────────────────────

const runMonthlyAnalysis = async () => {
    const now   = new Date();
    // Run for the previous month — e.g. on July 1 we classify June.
    const d     = new Date(now.getUTCFullYear(), now.getUTCMonth() - 1, 1);
    const year  = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;

    console.log(`[FOREST] Starting monthly classification for ${year}/${month}`);
    try {
        const snap = await svc.runAnalysis(year, month);
        const summary = snap.province_summary || {};
        let forestHa = 0;
        for (const id of cfg.FOREST_CLASS_IDS) {
            forestHa += summary.byClass?.[id] || 0;
        }
        console.log(
            `[FOREST] Classification done ${year}/${month}. ` +
            `OOB=${snap.oob_accuracy}% forestHa=${Math.round(forestHa).toLocaleString('vi')}` +
            (snap.gee_task_id ? ` geeTask=${snap.gee_task_id}` : ''),
        );
    } catch (err) {
        console.error(`[FOREST] Monthly classification failed ${year}/${month}:`, err.message);
    }
};

const runPollExports = async () => {
    try {
        await svc.pollExports();
    } catch (err) {
        console.error('[FOREST] pollExports error:', err.message);
    }
};

// ── Lifecycle ─────────────────────────────────────────────────────────────────

const start = () => {
    if (analysisTask) return;

    if (!cron.validate(ANALYSIS_CRON)) {
        console.warn(`[FOREST] Invalid cron "${ANALYSIS_CRON}" — monthly job not started`);
        return;
    }

    analysisTask = cron.schedule(ANALYSIS_CRON, runMonthlyAnalysis, { missedExecutionTolerance: 30000 });
    pollTask     = cron.schedule(POLL_CRON,     runPollExports,     { missedExecutionTolerance: 30000 });

    console.log(`  ✓ Forest classification job scheduled (${ANALYSIS_CRON})`);
    console.log(`  ✓ Forest classification export poll scheduled (${POLL_CRON})`);
};

const stop = () => {
    if (analysisTask) { analysisTask.stop(); analysisTask = null; }
    if (pollTask)     { pollTask.stop();     pollTask     = null; }
};

module.exports = { start, stop, runMonthlyAnalysis, runPollExports };
