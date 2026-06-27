'use strict';

/**
 * Image Processing Worker
 * Chạy định kỳ (node-cron) để xử lý hàng đợi job:
 *  1. Tạo thumbnail (dùng sharp — không cần GDAL)
 *  2. Tính thống kê band min/max/mean/std (dùng geotiff.js)
 *  3. Cập nhật status image → 'completed'
 *
 * GDAL (convert COG): khi server có GDAL, uncomment phần GDAL bên dưới.
 *
 * Luồng:
 *   Poll DB → lấy job pending → download GeoTIFF buffer từ MinIO
 *   → sharp thumbnail → upload thumbnail → geotiff stats
 *   → upsert statistics → update job completed → update image completed
 */

const sharp          = require('sharp');
const cron           = require('node-cron');
const os             = require('os');
const path           = require('path');
const fs             = require('fs');
const { Worker }     = require('worker_threads');

const repo    = require('../repositories/remote-sensing.repository');
const minio   = require('../services/minio.service');
const { t }   = require('../utils/i18n.util');
const ws      = require('../realtime/websocket.server');

// ── Config ────────────────────────────────────────────────────────────────────
const WORKER_ID         = `worker-${os.hostname()}-${process.pid}`;
const POLL_INTERVAL     = process.env.WORKER_POLL_CRON || '*/30 * * * * *'; // mỗi 30 giây
const JOB_BATCH_SIZE    = Number(process.env.WORKER_BATCH_SIZE || 3);
const THUMBNAIL_WIDTH   = Number(process.env.WORKER_THUMB_WIDTH  || 800);
const THUMBNAIL_HEIGHT  = Number(process.env.WORKER_THUMB_HEIGHT || 600);
const THUMBNAIL_FORMAT  = 'png';
const WORKER_LANG       = process.env.WORKER_LANG || 'vi';

// Flag để tránh chạy đồng thời
let isRunning = false;

// ══════════════════════════════════════════════════════════════════════════════
//  THUMBNAIL — dùng sharp
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Tạo thumbnail từ buffer GeoTIFF/TIFF.
 * sharp hỗ trợ TIFF nên không cần GDAL.
 *
 * @param {Buffer} inputBuffer — Buffer GeoTIFF
 * @returns {Promise<Buffer>}  — Buffer PNG thumbnail
 */
const generateThumbnail = async (inputBuffer) => {
    return sharp(inputBuffer, { limitInputPixels: false })
        .resize(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT, {
            fit:    'inside',
            withoutEnlargement: true,
        })
        .toFormat(THUMBNAIL_FORMAT, { quality: 85 })
        .toBuffer();
};

// ══════════════════════════════════════════════════════════════════════════════
//  STATISTICS — dùng geotiff.js
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Tính thống kê pixel từ GeoTIFF buffer cho tất cả bands.
 * Dùng geotiff.js — pure JS, không cần GDAL.
 *
 * @param {Buffer} inputBuffer
 * @returns {Promise<Array<{band_index, min, max, mean, std, valid_pixels, total_pixels}>>}
 */
// Chạy calcStatistics trong worker_threads để không block event loop
const calcStatistics = (inputBuffer) => new Promise((resolve, reject) => {
    const arrayBuffer = inputBuffer.buffer.slice(
        inputBuffer.byteOffset,
        inputBuffer.byteOffset + inputBuffer.byteLength,
    );

    const worker = new Worker(path.join(__dirname, 'calcStats.thread.js'), {
        workerData: { bufferData: arrayBuffer },
        transferList: [arrayBuffer], // zero-copy transfer
    });

    worker.once('message', ({ stats, error }) => {
        if (error) { reject(new Error(error)); } else { resolve(stats); }
    });
    worker.once('error', reject);
});

// ══════════════════════════════════════════════════════════════════════════════
//  PROCESS 1 JOB
// ══════════════════════════════════════════════════════════════════════════════

const processJob = async (job) => {
    console.info(t('worker_job_started', WORKER_LANG, { id: job.id, type: job.job_type, image: job.image_name }));

    // Đánh dấu đang xử lý
    await repo.updateJobStatus(job.id, 'processing', { worker_id: WORKER_ID, progress: 0 });
    await repo.updateImage(job.image_id, { status: 'processing' }, null);

    let inputBuffer = null;

    try {
        // ── Bước 1: Lấy danh sách files của ảnh ─────────────────────────────
        const files       = await repo.findFilesByImageId(job.image_id);
        const primaryFile = files.find((f) => f.file_role === 'primary');

        if (!primaryFile) {
            throw new Error(t('remote_sensing_primary_file_not_found', WORKER_LANG));
        }

        // ── Bước 2: Download buffer từ MinIO ─────────────────────────────────
        console.info(t('worker_downloading_from_minio', WORKER_LANG, { objectKey: primaryFile.object_key }));

        // CẢNH BÁO: downloadToBuffer nạp toàn bộ file vào RAM.
        // Với file > 500MB trên server RAM thấp, cần xử lý theo chunk.
        inputBuffer = await minio.downloadToBuffer(primaryFile.object_key, primaryFile.bucket_name);
        console.info(`[Worker] Downloaded ${(inputBuffer.length / 1024 / 1024).toFixed(1)} MB`);

        await repo.updateJobStatus(job.id, 'processing', { progress: 30 });

        const imageUuid = job.id; // dùng job ID làm prefix để unique

        // ── Bước 3: Tạo thumbnail ─────────────────────────────────────────────
        const hasThumbnail = files.some((f) => f.file_role === 'thumbnail');
        if (!hasThumbnail || job.job_type === 'gen_thumbnail' || job.job_type === 'full_pipeline') {
            try {
                console.info(t('worker_thumbnail_creating', WORKER_LANG));
                const thumbBuffer    = await generateThumbnail(inputBuffer);
                const thumbObjectKey = minio.buildObjectKey(
                    `job-${job.id}`,
                    `thumbnail_${primaryFile.original_name.replace(/\.[^.]+$/, '')}.${THUMBNAIL_FORMAT}`,
                    'thumbnails',
                );

                await minio.uploadBuffer({
                    buffer:    thumbBuffer,
                    objectKey: thumbObjectKey,
                    mimeType:  `image/${THUMBNAIL_FORMAT}`,
                });

                // Ghi file record cho thumbnail
                await repo.createFile({
                    image_id:        job.image_id,
                    bucket_name:     minio.BUCKET_REMOTE_SENSING,
                    object_key:      thumbObjectKey,
                    original_name:   `thumbnail.${THUMBNAIL_FORMAT}`,
                    file_role:       'thumbnail',
                    mime_type:       `image/${THUMBNAIL_FORMAT}`,
                    file_size_bytes: thumbBuffer.length,
                });

                console.info(t('worker_thumbnail_created', WORKER_LANG), thumbObjectKey);
            } catch (thumbErr) {
                // Không fail toàn bộ job nếu thumbnail lỗi
                console.warn(t('worker_thumbnail_failed', WORKER_LANG), thumbErr.message);
            }
        }

        await repo.updateJobStatus(job.id, 'processing', { progress: 60 });

        // ── Bước 4: Tính thống kê band ────────────────────────────────────────
        let statsArr = [];
        if (job.job_type === 'calc_statistics' || job.job_type === 'full_pipeline') {
            try {
                console.info(t('worker_stats_calculating', WORKER_LANG));
                statsArr = await calcStatistics(inputBuffer);

                for (const s of statsArr) {
                    await repo.upsertStatistics(job.image_id, primaryFile.id, s);
                }
                console.info(t('worker_stats_calculated', WORKER_LANG, { count: statsArr.length }));

                // Notify thống kê xong ngay (không chờ job hoàn tất)
                ws.notifyChannel(`remote_sensing:${job.image_id}`, 'remote_sensing:statistics_ready', {
                    imageId:    job.image_id,
                    bandCount:  statsArr.length,
                    statistics: statsArr.map((s) => ({
                        bandIndex: s.band_index,
                        min:       s.min,
                        max:       s.max,
                        mean:      s.mean,
                        std:       s.std,
                    })),
                });
            } catch (statsErr) {
                console.warn(t('worker_stats_failed', WORKER_LANG), statsErr.message);
            }
        }

        await repo.updateJobStatus(job.id, 'processing', { progress: 90 });

        // ── Bước 5: Cập nhật trạng thái hoàn tất ─────────────────────────────
        await repo.updateJobStatus(job.id, 'completed', {
            progress:    100,
            result_data: { processed_at: new Date().toISOString(), worker_id: WORKER_ID },
        });
        await repo.updateImage(job.image_id, { status: 'completed' }, null);

        // Thông báo realtime cho user đang chờ
        const completedPayload = {
            jobId:       job.id,
            imageId:     job.image_id,
            imageName:   job.image_name,
            status:      'completed',
            bandCount:   statsArr.length,
            processedAt: new Date().toISOString(),
        };
        if (job.created_by) {
            ws.notifyUser(job.created_by, 'remote_sensing:job_completed', completedPayload);
        }
        ws.notifyChannel(`remote_sensing:${job.image_id}`, 'remote_sensing:job_completed', completedPayload);

        console.info(t('worker_job_completed', WORKER_LANG, { id: job.id }));

    } catch (err) {
        console.error(t('worker_job_failed', WORKER_LANG, { id: job.id }), err.message);

        const nextRetryAt = new Date(Date.now() + 5 * 60 * 1000); // retry sau 5 phút

        await repo.updateJobStatus(job.id, 'failed', {
            error_message: err.message,
            error_stack:   err.stack,
        });

        // Nếu hết lần retry → đánh dấu image failed
        if (job.attempt_count + 1 >= job.max_attempts) {
            await repo.updateImage(job.image_id, { status: 'failed' }, null);
            ws.notifyChannel(`remote_sensing:${job.image_id}`, 'remote_sensing:job_failed', {
                jobId:        job.id,
                imageId:      job.image_id,
                status:       'failed',
                errorMessage: err.message,
            });
            console.error(`[Worker] Image #${job.image_id} marked as failed.`);
        } else {
            // Reset về pending để retry
            await repo.updateJobStatus(job.id, 'pending', {});
        }
    } finally {
        // Giải phóng RAM
        inputBuffer = null;
    }
};

// ══════════════════════════════════════════════════════════════════════════════
//  MAIN POLL LOOP
// ══════════════════════════════════════════════════════════════════════════════

const runWorkerCycle = async () => {
    if (isRunning) {
        return; // Tránh chạy đồng thời
    }
    isRunning = true;

    try {
        const jobs = await repo.findPendingJobs(JOB_BATCH_SIZE);
        if (jobs.length === 0) { return; }

        console.info(t('worker_jobs_found', WORKER_LANG, { count: jobs.length }));

        // Xử lý tuần tự (tránh OOM với nhiều file lớn đồng thời)
        for (const job of jobs) {
            await processJob(job);
        }
    } catch (err) {
        console.error(t('worker_cycle_error', WORKER_LANG), err.message);
    } finally {
        isRunning = false;
    }
};

// ══════════════════════════════════════════════════════════════════════════════
//  EXPORTS
// ══════════════════════════════════════════════════════════════════════════════

let cronTask = null;

/**
 * Khởi động worker với node-cron.
 * Gọi hàm này trong server.js sau khi DB và MinIO đã sẵn sàng.
 */
const startWorker = () => {
    if (cronTask) { return; }
    cronTask = cron.schedule(POLL_INTERVAL, runWorkerCycle, {
        scheduled: true,
        timezone:  'Asia/Ho_Chi_Minh',
    });
    console.info(t('worker_started', WORKER_LANG, { interval: POLL_INTERVAL }));
};

/**
 * Dừng worker (dùng khi graceful shutdown).
 */
const stopWorker = () => {
    if (cronTask) {
        cronTask.stop();
        cronTask = null;
        console.info(t('worker_stopped', WORKER_LANG));
    }
};

/**
 * Chạy thủ công 1 lần (dùng để test hoặc trigger từ API).
 */
const runOnce = () => runWorkerCycle();

module.exports = { startWorker, stopWorker, runOnce };
