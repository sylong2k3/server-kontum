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
 *
 * Debug: bật FC_DEBUG=true (hoặc NODE_ENV=development) để thấy chi tiết
 * mỗi tick + counters. Log info luôn ghi bất kể flag để trace state.
 */

const cron = require('node-cron');
const cfg  = require('../configs/forest-classification');
const svc  = require('../services/forest-classification.service');
const repo = require('../repositories/forest-classification.repository');

const ANALYSIS_CRON = cfg.CRON;
const POLL_CRON     = process.env.FC_POLL_CRON || '*/30 * * * *';

const DEBUG = process.env.FC_DEBUG === 'true'
    || process.env.NODE_ENV === 'development';
const dbg = (msg) => { if (DEBUG) console.debug(`[FOREST-JOB] ${msg}`); };

let analysisTask = null;
let pollTask     = null;

// Overlap protection — monthly analysis rất hiếm khi overlap, nhưng poll
// (30 min) có thể overlap khi có nhiều task đang export.
let analysisRunning = false;
let pollRunning     = false;

let pollTicks     = 0;
let pollIdleTicks = 0;

// ── Handlers ──────────────────────────────────────────────────────────────────

const runMonthlyAnalysis = async () => {
    if (analysisRunning) {
        console.warn('[FOREST] Monthly classification skipped: previous run still active');
        return;
    }
    analysisRunning = true;
    const t0 = Date.now();

    const now   = new Date();
    // Run for the previous month — e.g. on July 1 we classify June.
    // Build the anchor in UTC so year/month reads back consistently regardless
    // of the host timezone. `new Date(y, m, 1)` (local) → getUTC*() mixes clocks.
    const d     = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const year  = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;

    console.log(`[FOREST] Monthly classification START period=${year}/${month} bucket=${cfg.MINIO_BUCKET || '(default)'}`);
    try {
        const snap = await svc.runAnalysis(year, month);
        const summary = snap.province_summary || {};
        let forestHa = 0;
        for (const id of cfg.FOREST_CLASS_IDS) {
            forestHa += summary.byClass?.[id] || 0;
        }
        console.log(
            `[FOREST] Monthly classification DONE period=${year}/${month} ` +
            `snapshotId=${snap.id || '-'} status=${snap.status} ` +
            `OOB=${snap.oob_accuracy}% forestHa=${Math.round(forestHa).toLocaleString('vi')} ` +
            (snap.gee_task_id ? `geeTask=${snap.gee_task_id} ` : 'no export ') +
            `elapsed=${Date.now() - t0}ms`,
        );
        dbg(`byClass=${JSON.stringify(summary.byClass || {})}`);
    } catch (err) {
        console.error(`[FOREST] Monthly classification FAILED period=${year}/${month} elapsed=${Date.now() - t0}ms — ${err.code || err.name || 'ERR'}: ${err.message}`);
        if (DEBUG && err.stack) console.debug(err.stack);
    } finally {
        analysisRunning = false;
    }
};

const runPollExports = async () => {
    if (pollRunning) {
        console.warn('[FOREST] pollExports SKIPPED: previous run still active');
        return;
    }
    pollRunning = true;
    pollTicks  += 1;
    const t0    = Date.now();
    try {
        // Peek trước để có metric (service pollExports không trả số).
        const pending = await repo.listExporting().catch(() => []);
        dbg(`pollExports tick ${pollTicks} — ${pending.length} exporting snapshot(s)`);

        await svc.pollExports();

        if (pending.length === 0) {
            pollIdleTicks += 1;
            // Log định kỳ mỗi 24 tick idle (~12h) — chứng minh cron còn sống.
            if (pollIdleTicks % 24 === 0) {
                console.log(`[FOREST] pollExports IDLE ${pollIdleTicks}/${pollTicks} ticks`);
            }
        } else {
            console.log(`[FOREST] pollExports DONE processed=${pending.length} elapsed=${Date.now() - t0}ms`);
        }
    } catch (err) {
        console.error(`[FOREST] pollExports ERROR elapsed=${Date.now() - t0}ms — ${err.code || err.name || 'ERR'}: ${err.message}`);
        if (DEBUG && err.stack) console.debug(err.stack);
    } finally {
        pollRunning = false;
    }
};

// ── Lifecycle ─────────────────────────────────────────────────────────────────

const start = () => {
    if (analysisTask) return;

    if (!cron.validate(ANALYSIS_CRON)) {
        console.warn(`[FOREST] Invalid cron "${ANALYSIS_CRON}" — monthly job not started`);
        return;
    }
    if (!cron.validate(POLL_CRON)) {
        console.warn(`[FOREST] Invalid poll cron "${POLL_CRON}" — poll job not started`);
        return;
    }

    // Cùng nguyên tắc như fire-risk: cron string theo VN tz.
    const cronOpts = { timezone: process.env.FC_CRON_TZ || 'Asia/Ho_Chi_Minh' };
    analysisTask = cron.schedule(ANALYSIS_CRON, runMonthlyAnalysis, cronOpts);
    pollTask     = cron.schedule(POLL_CRON,     runPollExports,     cronOpts);

    console.log(
        `[FOREST] STARTED analysis="${ANALYSIS_CRON}" poll="${POLL_CRON}" ` +
        `bucket=${cfg.MINIO_BUCKET || '(default)'} ` +
        `alertPct=${cfg.ALERT_CHANGE_PCT ?? '(default)'} debug=${DEBUG}`,
    );
    console.log(`  ✓ Forest classification job scheduled (${ANALYSIS_CRON})`);
    console.log(`  ✓ Forest classification export poll scheduled (${POLL_CRON})`);
};

const stop = () => {
    if (analysisTask) { analysisTask.stop(); analysisTask = null; }
    if (pollTask)     { pollTask.stop();     pollTask     = null; }
    console.log(`[FOREST] STOPPED — pollTicks=${pollTicks} pollIdle=${pollIdleTicks}`);
};

module.exports = { start, stop, runMonthlyAnalysis, runPollExports };
