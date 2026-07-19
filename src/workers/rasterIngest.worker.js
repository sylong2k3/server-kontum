'use strict';

/**
 * Worker cho pipeline GEE Raster Ingest.
 *
 * Pattern: cron poll (node-cron) + claim `FOR UPDATE SKIP LOCKED` — giống
 * geoImport.worker.js — cho phép chạy nhiều instance Node cùng lúc mà không
 * nuốt trùng job.
 *
 * Concurrency: mỗi tick claim batch, xử lý song song với Promise.allSettled.
 * `isRunning` chống overlap giữa 2 tick liên tiếp trong cùng process.
 */

const cron = require('node-cron');
const os   = require('os');

const cfg          = require('../configs/raster-ingest');
const rasterRepo   = require('../repositories/raster-ingest.repository');
const ingestSvc    = require('../services/raster-ingest.service');

const WORKER_ID = `raster-ingest-${os.hostname()}-${process.pid}`;
const DEBUG     = process.env.RASTER_INGEST_DEBUG === 'true'
    || process.env.NODE_ENV === 'development';

let cronJob   = null;
let isRunning = false;
let ticksTotal = 0;    // Debug counter — 0 job ticks đôi khi quá nhiều để log per-tick
let ticksIdle  = 0;

const tick = async () => {
    // Overlap protection: nếu tick trước còn xử lý (job GDAL lâu) → skip.
    if (isRunning) {
        if (DEBUG) console.debug(`[${WORKER_ID}] tick SKIPPED — previous still running`);
        return;
    }
    isRunning  = true;
    ticksTotal += 1;
    const t0   = Date.now();

    try {
        const jobs = await rasterRepo.claimPending({
            batchSize:  cfg.CONCURRENCY,
            maxRetries: cfg.MAX_RETRIES,
        });

        if (!jobs.length) {
            ticksIdle += 1;
            // Log định kỳ mỗi 60 tick idle (~15 phút với poll 15s) để chứng minh
            // worker vẫn sống, tránh log flood khi queue trống.
            if (DEBUG && ticksIdle % 60 === 0) {
                console.debug(`[${WORKER_ID}] IDLE — ${ticksIdle}/${ticksTotal} ticks empty`);
            }
            return;
        }

        console.log(`[${WORKER_ID}] CLAIMED ${jobs.length} job(s): [${jobs.map((j) => j.id).join(', ')}]`);

        const results = await Promise.allSettled(
            jobs.map(async (job) => {
                try {
                    await ingestSvc.runJob(job);
                    return { id: job.id, ok: true };
                } catch (err) {
                    // Service đã ghi status; ở đây chỉ log để có audit log worker.
                    console.error(`[${WORKER_ID}] job=${job.id} THREW: ${err.code || err.name}: ${err.message}`);
                    return { id: job.id, ok: false, error: err.message };
                }
            }),
        );

        const ok = results.filter((r) => r.value?.ok).length;
        console.log(`[${WORKER_ID}] TICK done ${ok}/${jobs.length} ok in ${Date.now() - t0}ms`);
    } catch (err) {
        console.error(`[${WORKER_ID}] TICK ERROR: ${err.code || err.name}: ${err.message}`);
    } finally {
        isRunning = false;
    }
};

const startWorker = () => {
    if (!cfg.ENABLED) {
        console.log(`[${WORKER_ID}] DISABLED (RASTER_INGEST_ENABLED=false)`);
        return;
    }
    if (cronJob) {
        console.warn(`[${WORKER_ID}] start called twice — ignored`);
        return;
    }
    const s3ok = cfg.isS3Configured();
    console.log(
        `[${WORKER_ID}] STARTED — poll="${cfg.WORKER_POLL_CRON}" ` +
        `concurrency=${cfg.CONCURRENCY} maxRetries=${cfg.MAX_RETRIES} ` +
        `bucket=${cfg.MINIO_BUCKET} s3Endpoint=${cfg.S3_ENDPOINT || '(inferred)'} ` +
        `s3Configured=${s3ok ? 'yes' : 'NO — worker sẽ từ chối job'} debug=${DEBUG}`,
    );
    // suppressMissedWarning: ẩn log spam khi GC pause block event loop ~25s.
    // missedExecutionTolerance không đủ vì node-cron v4 yêu cầu lateBy < gap (15s).
    cronJob = cron.schedule(cfg.WORKER_POLL_CRON, tick, { suppressMissedWarning: true });
};

const stopWorker = () => {
    if (cronJob) {
        cronJob.stop();
        cronJob = null;
        console.log(`[${WORKER_ID}] STOPPED — total ticks=${ticksTotal} idle=${ticksIdle}`);
    }
};

module.exports = { startWorker, stopWorker };
