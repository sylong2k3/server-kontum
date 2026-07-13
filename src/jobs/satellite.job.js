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
 */

const cron = require('node-cron');
const svc  = require('../services/satellite.service');

const POLL_CRON = process.env.SATELLITE_POLL_CRON || '*/30 * * * *';

let pollTask  = null;
let isRunning = false;

// ── Handler ──────────────────────────────────────────────────────────────────

const runPollPublishes = async () => {
    if (isRunning) {
        console.warn('[SATELLITE] pollPublishes skipped: previous run still active');
        return;
    }
    isRunning = true;
    try {
        await svc.pollPublishes();
    } catch (err) {
        console.error(`[SATELLITE] pollPublishes error: ${err.message}`);
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

    pollTask = cron.schedule(POLL_CRON, runPollPublishes, { missedExecutionTolerance: 30000 });
    console.log(`  ✓ Satellite export poll job scheduled (${POLL_CRON})`);
};

const stop = () => {
    if (pollTask) {
        pollTask.stop();
        pollTask = null;
    }
};

module.exports = { start, stop, runPollPublishes };
