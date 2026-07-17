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
 *
 * Debug: bật FIRE_RISK_DEBUG=true (hoặc NODE_ENV=development) để thấy chi tiết
 * mỗi tick + counters. Log info luôn ghi bất kể flag để trace state transitions.
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

const DEBUG = process.env.FIRE_RISK_DEBUG === 'true'
    || process.env.NODE_ENV === 'development';
const dbg = (msg) => { if (DEBUG) console.debug(`[FIRE-RISK-JOB] ${msg}`); };

let analysisTask = null;
let pollTask     = null;
let cleanupTask  = null;

// Overlap protection cho poll (30-min tick nhưng GCS→MinIO→GeoServer harvest
// đôi khi mất > 30 min khi có nhiều task cùng lúc).
let pollRunning     = false;
let analysisRunning = false;
let cleanupRunning  = false;

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
        // Peek trước khi poll để biết còn task đang exporting không — service
        // hiện trả undefined nên phải tự đếm ở đây để có metric.
        const pending = await repo.listExporting().catch(() => []);
        dbg(`pollExports tick ${pollTicks} — ${pending.length} exporting snapshot(s)`);

        await svc.pollExports();

        if (pending.length === 0) {
            pollIdleTicks += 1;
            // Log định kỳ mỗi 24 tick idle (~12h) để chứng minh cron còn sống.
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

const runCleanup = async () => {
    if (cleanupRunning) {
        console.warn('[FIRE RISK] Cleanup skipped: previous run still active');
        return;
    }
    cleanupRunning = true;
    const t0 = Date.now();
    try {
        const deleted = await repo.deleteOld(cfg.SNAPSHOT_GRACE_DAYS);
        if (deleted > 0) {
            console.log(`[FIRE RISK] Cleanup DONE deleted=${deleted} olderThan=${cfg.SNAPSHOT_GRACE_DAYS}d elapsed=${Date.now() - t0}ms`);
        } else {
            dbg(`Cleanup idle (nothing older than ${cfg.SNAPSHOT_GRACE_DAYS}d) elapsed=${Date.now() - t0}ms`);
        }
    } catch (err) {
        console.error(`[FIRE RISK] Cleanup ERROR — ${err.code || err.name || 'ERR'}: ${err.message}`);
        if (DEBUG && err.stack) console.debug(err.stack);
    } finally {
        cleanupRunning = false;
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

    console.log(
        `[FIRE RISK] STARTED analysis="${ANALYSIS_CRON}" poll="${POLL_CRON}" cleanup="${CLEANUP_CRON}" ` +
        `gcsConfigured=${cfg.isGcsConfigured() ? 'yes' : 'NO — raster export skipped'} ` +
        `snapshotGrace=${cfg.SNAPSHOT_GRACE_DAYS}d debug=${DEBUG}`,
    );
    console.log(`  ✓ Fire risk analysis job scheduled (${ANALYSIS_CRON})`);
    console.log(`  ✓ Fire risk export poll job scheduled (${POLL_CRON})`);
};

const stop = () => {
    [analysisTask, pollTask, cleanupTask].forEach((t) => { if (t) t.stop(); });
    analysisTask = null;
    pollTask     = null;
    cleanupTask  = null;
    console.log(`[FIRE RISK] STOPPED — pollTicks=${pollTicks} pollIdle=${pollIdleTicks}`);
};

module.exports = { start, stop, runDailyAnalysis, runPollExports };
