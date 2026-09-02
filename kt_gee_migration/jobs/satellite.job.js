'use strict';

/**
 * Satellite Cron Job — GeoServer publish poller.
 *
 * The satellite service is on-demand (users call POST /satellite/{type}),
 * so there is NO scheduled analysis tick. Only one tick is needed:
 *
 *   Tick (every SATELLITE_POLL_CRON, default 30 min):
 *     → svc.pollPublishes() — checks all `image_results` rows stuck in
 *       status='exporting'. When their GEE export task finishes, harvests
 *       the GeoTIFF from GCS → MinIO → GeoServer coverage store and
 *       updates status='published' + geoserver_store/geoserver_layer.
 *
 * Design notes:
 *   - No cleanup of old rows: GEE mapId tokens for on-demand tile URLs
 *     expire on their side after ~24h — nothing to purge on ours. Rows
 *     with published GeoServer layers stay indefinitely as they represent
 *     durable exported rasters.
 *   - No tile URL is (re)persisted here. `tile_url` was written at the
 *     time of the original request and becomes stale; the proxy that
 *     serves /satellite/tiles/:id/:z/:x/:y is expected to detect expired
 *     upstream responses on its own.
 *   - Skips concurrent runs — if a poll is still in flight when the next
 *     tick fires, log and bail (matches weather.job pattern).
 *
 * Debug: bật SATELLITE_DEBUG=true (hoặc NODE_ENV=development) để thấy chi tiết
 * mỗi tick. Log info luôn ghi khi có việc để làm.
 */

const cron = require('node-cron');
const svc  = require('../services/satellite.service');
const repo = require('../repositories/satellite.repository');

const POLL_CRON = process.env.SATELLITE_POLL_CRON || '*/30 * * * *';

const DEBUG = process.env.SATELLITE_DEBUG === 'true'
    || process.env.NODE_ENV === 'development';
const dbg = (msg) => { if (DEBUG) console.debug(`[SATELLITE-JOB] ${msg}`); };

let pollTask  = null;
let isRunning = false;

let pollTicks     = 0;
let pollIdleTicks = 0;

// ── Handler ──────────────────────────────────────────────────────────────────

const runPollPublishes = async () => {
    if (isRunning) {
        console.warn('[SATELLITE] pollPublishes SKIPPED: previous run still active');
        return;
    }
    isRunning = true;
    pollTicks += 1;
    const t0   = Date.now();
    try {
        // Peek trước khi poll — service pollPublishes không trả số nên tự đếm.
        const pending = await repo.listExporting().catch(() => []);
        dbg(`pollPublishes tick ${pollTicks} — ${pending.length} exporting result(s)`);

        await svc.pollPublishes();

        if (pending.length === 0) {
            pollIdleTicks += 1;
            // Log định kỳ mỗi 24 tick idle (~12h) để chứng minh cron còn sống.
            if (pollIdleTicks % 24 === 0) {
                console.log(`[SATELLITE] pollPublishes IDLE ${pollIdleTicks}/${pollTicks} ticks (no exports pending)`);
            }
        } else {
            console.log(`[SATELLITE] pollPublishes DONE processed=${pending.length} elapsed=${Date.now() - t0}ms`);
        }
    } catch (err) {
        console.error(`[SATELLITE] pollPublishes ERROR elapsed=${Date.now() - t0}ms — ${err.code || err.name || 'ERR'}: ${err.message}`);
        if (DEBUG && err.stack) console.debug(err.stack);
    } finally {
        isRunning = false;
    }
};

// ── Lifecycle ─────────────────────────────────────────────────────────────────

const start = () => {
    if (pollTask) return;

    if (!cron.validate(POLL_CRON)) {
        console.warn(`[SATELLITE] Invalid poll cron "${POLL_CRON}" — job not started`);
        return;
    }

    pollTask = cron.schedule(POLL_CRON, runPollPublishes,
        { timezone: process.env.SATELLITE_CRON_TZ || 'Asia/Ho_Chi_Minh' });
    console.log(`[SATELLITE] STARTED poll="${POLL_CRON}" debug=${DEBUG}`);
    console.log(`  ✓ Satellite export poll job scheduled (${POLL_CRON})`);
};

const stop = () => {
    if (pollTask) {
        pollTask.stop();
        pollTask = null;
        console.log(`[SATELLITE] STOPPED — pollTicks=${pollTicks} pollIdle=${pollIdleTicks}`);
    }
};

module.exports = { start, stop, runPollPublishes };
