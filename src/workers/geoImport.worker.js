'use strict';

/**
 * GeoImport Worker
 * Poll job pending từ gis.layer_import_jobs (source_format = geo file)
 * và gọi geo-import.service.runImportJob để xử lý bất đồng bộ.
 *
 * Thiết kế giống imageProcessing.worker.js:
 *  - Dùng node-cron để poll định kỳ
 *  - Flag isRunning tránh overlap
 *  - Graceful stop qua stopWorker()
 */

const cron = require('node-cron');
const os   = require('os');
const db   = require('../configs/database');
const geoImportService = require('../services/geo-import.service');

const { t } = require('../utils/i18n.util');

const WORKER_ID      = `geo-worker-${os.hostname()}-${process.pid}`;
const POLL_INTERVAL  = process.env.GEO_WORKER_POLL_CRON || '*/15 * * * * *';
const JOB_BATCH_SIZE = Number(process.env.GEO_WORKER_BATCH_SIZE || 2);
const WORKER_LANG    = process.env.APP_LANG || process.env.LANG || 'vi';

// Format geo file (phân biệt với remote-sensing jobs)
const GEO_FORMATS = ['shapefile', 'geojson', 'kml', 'filegdb'];

let cronJob    = null;
let isRunning  = false;

// ── Poll + claim pending jobs ────────────────────────────────────────────────
// SELECT ... FOR UPDATE SKIP LOCKED and the status flip must happen in the
// same statement — otherwise the row lock is released as soon as the SELECT's
// implicit transaction ends, and two worker instances can both pick up and
// process the same 'pending' job before either UPDATE lands.

const claimPendingJobs = async () => {
    const placeholders = GEO_FORMATS.map((_, i) => `$${i + 2}`).join(', ');
    const { rows } = await db.query(
        `UPDATE gis.layer_import_jobs
         SET status = 'processing', started_at = NOW()
         WHERE id IN (
             SELECT id FROM gis.layer_import_jobs
             WHERE status = 'pending'
               AND source_format IN (${placeholders})
             ORDER BY created_at ASC
             LIMIT $1
             FOR UPDATE SKIP LOCKED
         )
         RETURNING id, source_info`,
        [JOB_BATCH_SIZE, ...GEO_FORMATS]
    );
    return rows;
};

// ── Worker tick ───────────────────────────────────────────────────────────────

const tick = async () => {
    if (isRunning) { return; }
    isRunning = true;

    let jobs;
    try {
        jobs = await claimPendingJobs();
    } catch (err) {
        console.error(t('geo_worker_query_failed', WORKER_LANG, { workerId: WORKER_ID }), err.message);
        isRunning = false;
        return;
    }

    if (!jobs.length) {
        isRunning = false;
        return;
    }

    console.log(t('geo_worker_jobs_processing', WORKER_LANG, { workerId: WORKER_ID, count: jobs.length }));

    await Promise.allSettled(
        jobs.map(async (job) => {
            try {
                await geoImportService.runImportJob(job.id, WORKER_LANG);
                console.log(t('geo_worker_job_completed', WORKER_LANG, { workerId: WORKER_ID, id: job.id }));
            } catch (err) {
                console.error(t('geo_worker_job_failed', WORKER_LANG, { workerId: WORKER_ID, id: job.id }), err.message);
            }
        })
    );

    isRunning = false;
};

// ── Start / Stop ──────────────────────────────────────────────────────────────

const startWorker = () => {
    if (cronJob) { return; }
    console.log(t('geo_worker_started', WORKER_LANG, { workerId: WORKER_ID, cron: POLL_INTERVAL }));
    cronJob = cron.schedule(POLL_INTERVAL, tick);
};

const stopWorker = () => {
    if (cronJob) {
        cronJob.stop();
        cronJob = null;
        console.log(t('geo_worker_stopped', WORKER_LANG, { workerId: WORKER_ID }));
    }
};

module.exports = { startWorker, stopWorker };
