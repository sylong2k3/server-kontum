'use strict';

/**
 * Fire Risk URL Refresh Job.
 *
 * Cron 5-phút (mặc định): quét gis.raster_ingest_jobs có status='url_expired'
 * (do PM2 restart giữa lúc worker chưa kịp tải → HTTP 401), gom nhóm theo
 * analysis_date, chạy lại pipeline để tái sinh liên kết tải + tile URL mới.
 *
 * activeRuns trong fire-risk.service đã dedupe theo analysis_date — nhiều
 * tick cron gọi cùng ngày sẽ dùng chung Promise.
 *
 * Toggle: FIRE_RISK_URL_REFRESH=false để tắt.
 */

const cron = require('node-cron');
const svc  = require('../services/fire-risk.service');

const REFRESH_CRON = process.env.FIRE_RISK_URL_REFRESH_CRON || '*/5 * * * *';
const ENABLED      = process.env.FIRE_RISK_URL_REFRESH !== 'false';

let task = null;
let running = false;
let ticks = 0;
let refreshedCount = 0;

const runTick = async () => {
    if (running) {
        console.warn('[FIRE-RISK-URL-REFRESH] tick SKIPPED — previous still running');
        return;
    }
    running = true;
    ticks += 1;
    const t0 = Date.now();
    try {
        const results = await svc.refreshExpiredDistrictUrls();
        if (results.length > 0) {
            refreshedCount += results.length;
            console.log(
                `[FIRE-RISK-URL-REFRESH] tick ${ticks} refreshed=${results.length} ` +
                `dates=[${results.map((r) => r.analysisDate).join(',')}] ` +
                `errors=${results.filter((r) => r.error).length} ` +
                `elapsed=${Date.now() - t0}ms`,
            );
        }
    } catch (err) {
        console.error(`[FIRE-RISK-URL-REFRESH] tick ${ticks} ERROR — ${err.message}`);
    } finally {
        running = false;
    }
};

const start = () => {
    if (task || !ENABLED) {
        if (!ENABLED) console.log('[FIRE-RISK-URL-REFRESH] disabled (FIRE_RISK_URL_REFRESH=false)');
        return;
    }
    if (!cron.validate(REFRESH_CRON)) {
        console.warn(`[FIRE-RISK-URL-REFRESH] Invalid cron "${REFRESH_CRON}" — job not started`);
        return;
    }
    const cronOpts = { timezone: process.env.FIRE_RISK_CRON_TZ || 'Asia/Ho_Chi_Minh' };
    task = cron.schedule(REFRESH_CRON, runTick, cronOpts);
    console.log(`  ✓ Fire risk URL refresh job scheduled (${REFRESH_CRON} @ ${cronOpts.timezone})`);
};

const stop = () => {
    if (task) task.stop();
    task = null;
    console.log(`[FIRE-RISK-URL-REFRESH] STOPPED — ticks=${ticks} refreshed=${refreshedCount}`);
};

module.exports = { start, stop, runTick };
