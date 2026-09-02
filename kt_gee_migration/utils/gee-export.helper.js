'use strict';

/**
 * Shared GEE export helpers: poll task status + publish raster to MinIO/GeoServer.
 * Used by fire-risk.service.js and forest-classification.service.js.
 */

const os   = require('os');
const path = require('path');
const { ee } = require('../configs/gge');
const { eeEval } = require('./gee-satellite.util');
const minioSvc   = require('../services/minio.service');
const geoserver  = require('./geoserver.client');

const GEE_POLL_INTERVAL_MS  = parseInt(process.env.GEE_POLL_INTERVAL_MS,  10) || 30_000;
const GEE_POLL_MAX_ATTEMPTS = parseInt(process.env.GEE_POLL_MAX_ATTEMPTS, 10) || 40;

/**
 * Poll a GEE export task until COMPLETED, FAILED, CANCELLED, or max attempts.
 * Returns final status string: 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'TIMEOUT'.
 *
 * Terminal states are checked BEFORE `op.done`: a cancelled task has
 * `done: true` AND `metadata.state === 'CANCELLED'`, so testing `done` first
 * would misclassify it as COMPLETED.
 */
async function pollGeeTask(taskName) {
    for (let i = 0; i < GEE_POLL_MAX_ATTEMPTS; i++) {
        await new Promise((r) => setTimeout(r, GEE_POLL_INTERVAL_MS));
        const ops   = await eeEval(ee.data.listOperations([taskName]));
        const op    = ops?.[0];
        const state = op?.metadata?.state;
        if (state === 'CANCELLED')  return 'CANCELLED';
        if (state === 'FAILED')     return 'FAILED';
        if (op?.error)              return 'FAILED';
        if (op?.done)               return 'COMPLETED';
    }
    return 'TIMEOUT';
}

/**
 * Download a GeoTIFF from GCS, upload to MinIO, and optionally harvest into GeoServer.
 * Returns { minioKey, geoserverStore, geoserverLayer } or null if GCS is not configured.
 *
 * @param {object} opts
 * @param {string} opts.gcsPath        — GCS file path (no .tif extension)
 * @param {string} opts.bucket         — GCS bucket name
 * @param {string} opts.fileName       — local/minio filename (with .tif)
 * @param {string} opts.minioKey       — path inside MinIO bucket
 * @param {string} opts.minioBucket    — MinIO bucket name
 * @param {string} opts.storeName      — GeoServer coverage store name
 * @param {string} [opts.gcsKeyFile]   — path to GCS service account JSON
 * @param {boolean} [opts.harvest]     — whether to harvest into GeoServer (default true)
 */
async function publishRasterToMinio({
    gcsPath,
    bucket,
    fileName,
    minioKey,
    minioBucket,
    storeName,
    gcsKeyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS || '',
    harvest    = true,
}) {
    if (!bucket) return null;

    const { Storage } = require('@google-cloud/storage');
    const storage     = new Storage(gcsKeyFile ? { keyFilename: gcsKeyFile } : {});
    // Use OS tmpdir so this works on Windows dev as well as Linux prod.
    const localTmp    = path.join(os.tmpdir(), fileName);

    // Download from GCS.
    await storage.bucket(bucket).file(`${gcsPath}.tif`).download({ destination: localTmp });

    // Upload to MinIO.
    await minioSvc.uploadFile(minioBucket, minioKey, localTmp, 'image/tiff');

    // Harvest into GeoServer.
    if (harvest) {
        await geoserver.harvestGeoTiff(storeName, localTmp);
    }

    // Cleanup.
    const fs = require('fs/promises');
    await fs.unlink(localTmp).catch(() => {});

    const workspace = process.env.GEOSERVER_WORKSPACE || 'kontum';
    return {
        minioKey,
        geoserverStore: storeName,
        geoserverLayer: `${workspace}:${storeName}`,
    };
}

module.exports = { pollGeeTask, publishRasterToMinio };
