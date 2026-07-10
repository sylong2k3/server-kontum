'use strict';

const cron = require('node-cron');
const cfg = require('../configs/weather');
const weatherService = require('../services/weather.service');
const weatherRepository = require('../repositories/weather.repository');

// Mặc định: đầu mỗi giờ (WEATHER_CRON=0 * * * *).
const WEATHER_CRON = cfg.CRON;
const CACHE_GRACE_DAYS = parseInt(process.env.WEATHER_CACHE_GRACE_DAYS, 10) || 7;

let task = null;

let isRunning = false;

const runRefresh = async () => {
    if (isRunning) {
        console.warn('[WEATHER REFRESH] Skipped: previous run still active');
        return;
    }

    isRunning = true;
    try {
        let result;
        try {
            result = await weatherService.refreshCache({ lang: 'vi' });
        } catch (err) {
            console.error('[WEATHER REFRESH] Failed:', err.message);
            return;
        }

        let deleted = null;
        try {
            deleted = await weatherRepository.deleteExpired(CACHE_GRACE_DAYS);
        } catch (err) {
            console.error('[WEATHER REFRESH] Cache purge failed (ignored):', err.message);
        }

        const errs = result.errors.length ? ` errors=[${result.errors.join('; ')}]` : '';
        console.log(
            `[WEATHER REFRESH] point=${result.point} windGrid=${result.windGrid} ` +
            `purged=${deleted === null ? 'n/a' : deleted}${errs}`
        );
    } finally {
        isRunning = false;
    }
};

const start = () => {
    if (task) { return; }
    if (!cron.validate(WEATHER_CRON)) {
        console.warn(`[WEATHER REFRESH] Invalid cron expression "${WEATHER_CRON}" — job not started`);
        return;
    }
    task = cron.schedule(WEATHER_CRON, runRefresh);
    console.log(`  ✓ Weather refresh job scheduled (${WEATHER_CRON})`);
    // Làm nóng cache ngay khi khởi động (không chặn startup).
    runRefresh();
};

const stop = () => {
    if (task) {
        task.stop();
        task = null;
    }
};

module.exports = { start, stop, runRefresh };
