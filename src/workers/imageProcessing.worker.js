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

const sharp   = require('sharp');
const cron    = require('node-cron');
const os      = require('os');
const path    = require('path');
const fs      = require('fs');

const repo    = require('../repositories/remoteSensing.repository');
const minio   = require('../services/minioStorage.service');

// ── Config ────────────────────────────────────────────────────────────────────
const WORKER_ID         = `worker-${os.hostname()}-${process.pid}`;
const POLL_INTERVAL     = process.env.WORKER_POLL_CRON || '*/30 * * * * *'; // mỗi 30 giây
const JOB_BATCH_SIZE    = Number(process.env.WORKER_BATCH_SIZE || 3);
const THUMBNAIL_WIDTH   = Number(process.env.WORKER_THUMB_WIDTH  || 800);
const THUMBNAIL_HEIGHT  = Number(process.env.WORKER_THUMB_HEIGHT || 600);
const THUMBNAIL_FORMAT  = 'png';

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
const calcStatistics = async (inputBuffer) => {
    // geotiff.js là ESM module — dùng dynamic import
    const { fromArrayBuffer } = await import('geotiff');

    const arrayBuffer = inputBuffer.buffer.slice(
        inputBuffer.byteOffset,
        inputBuffer.byteOffset + inputBuffer.byteLength,
    );

    const tiff  = await fromArrayBuffer(arrayBuffer);
    const image = await tiff.getImage();

    const bandCount = image.getSamplesPerPixel();
    const stats     = [];

    for (let b = 1; b <= bandCount; b++) {
        try {
            // Đọc từng band (0-indexed trong geotiff.js)
            const rasters    = await image.readRasters({ samples: [b - 1] });
            const data       = rasters[0];

            let min = Infinity, max = -Infinity, sum = 0, sumSq = 0;
            let validCount = 0;
            const total = data.length;

            for (let i = 0; i < total; i++) {
                const v = data[i];
                // Loại bỏ NaN và các giá trị nodata phổ biến
                if (v === null || v === undefined || isNaN(v) || !isFinite(v)) { continue; }
                if (min > v) { min = v; }
                if (max < v) { max = v; }
                sum   += v;
                sumSq += v * v;
                validCount++;
            }

            if (validCount === 0) {
                stats.push({ band_index: b, min: null, max: null, mean: null, std: null, valid_pixels: 0, total_pixels: total });
                continue;
            }

            const mean = sum / validCount;
            const std  = Math.sqrt(sumSq / validCount - mean * mean);

            stats.push({
                band_index:   b,
                min:          Math.round(min * 10000) / 10000,
                max:          Math.round(max * 10000) / 10000,
                mean:         Math.round(mean * 10000) / 10000,
                std:          Math.round(Math.abs(std) * 10000) / 10000,
                valid_pixels: validCount,
                total_pixels: total,
            });
        } catch (bandErr) {
            console.warn(`[Worker] Không thể đọc band ${b}:`, bandErr.message);
        }
    }

    return stats;
};

// ══════════════════════════════════════════════════════════════════════════════
//  PROCESS 1 JOB
// ══════════════════════════════════════════════════════════════════════════════

const processJob = async (job) => {
    console.info(`[Worker] Bắt đầu job #${job.id} | type=${job.job_type} | image=${job.image_name}`);

    // Đánh dấu đang xử lý
    await repo.updateJobStatus(job.id, 'processing', { worker_id: WORKER_ID, progress: 0 });
    await repo.updateImage(job.image_id, { status: 'processing' }, null);

    let inputBuffer = null;

    try {
        // ── Bước 1: Lấy danh sách files của ảnh ─────────────────────────────
        const files       = await repo.findFilesByImageId(job.image_id);
        const primaryFile = files.find((f) => f.file_role === 'primary');

        if (!primaryFile) {
            throw new Error('Không tìm thấy file GeoTIFF chính.');
        }

        // ── Bước 2: Download buffer từ MinIO ─────────────────────────────────
        console.info(`[Worker] Downloading ${primaryFile.object_key} từ MinIO...`);

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
                console.info('[Worker] Tạo thumbnail...');
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

                console.info('[Worker] Thumbnail tạo thành công:', thumbObjectKey);
            } catch (thumbErr) {
                // Không fail toàn bộ job nếu thumbnail lỗi
                console.warn('[Worker] Tạo thumbnail thất bại (non-fatal):', thumbErr.message);
            }
        }

        await repo.updateJobStatus(job.id, 'processing', { progress: 60 });

        // ── Bước 4: Tính thống kê band ────────────────────────────────────────
        if (job.job_type === 'calc_statistics' || job.job_type === 'full_pipeline') {
            try {
                console.info('[Worker] Tính thống kê band...');
                const statsArr = await calcStatistics(inputBuffer);

                for (const s of statsArr) {
                    await repo.upsertStatistics(job.image_id, primaryFile.id, s);
                }
                console.info(`[Worker] Đã tính ${statsArr.length} band statistics.`);
            } catch (statsErr) {
                console.warn('[Worker] Tính stats thất bại (non-fatal):', statsErr.message);
            }
        }

        await repo.updateJobStatus(job.id, 'processing', { progress: 90 });

        // ── Bước 5: Cập nhật trạng thái hoàn tất ─────────────────────────────
        await repo.updateJobStatus(job.id, 'completed', {
            progress:    100,
            result_data: { processed_at: new Date().toISOString(), worker_id: WORKER_ID },
        });
        await repo.updateImage(job.image_id, { status: 'completed' }, null);

        console.info(`[Worker] Job #${job.id} hoàn tất ✓`);

    } catch (err) {
        console.error(`[Worker] Job #${job.id} thất bại:`, err.message);

        const nextRetryAt = new Date(Date.now() + 5 * 60 * 1000); // retry sau 5 phút

        await repo.updateJobStatus(job.id, 'failed', {
            error_message: err.message,
            error_stack:   err.stack,
        });

        // Nếu hết lần retry → đánh dấu image failed
        if (job.attempt_count + 1 >= job.max_attempts) {
            await repo.updateImage(job.image_id, { status: 'failed' }, null);
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

        console.info(`[Worker] Tìm thấy ${jobs.length} job(s) cần xử lý.`);

        // Xử lý tuần tự (tránh OOM với nhiều file lớn đồng thời)
        for (const job of jobs) {
            await processJob(job);
        }
    } catch (err) {
        console.error('[Worker] Lỗi trong worker cycle:', err.message);
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
    console.info(`[Worker] Image Processing Worker khởi động. Poll interval: ${POLL_INTERVAL}`);
};

/**
 * Dừng worker (dùng khi graceful shutdown).
 */
const stopWorker = () => {
    if (cronTask) {
        cronTask.stop();
        cronTask = null;
        console.info('[Worker] Image Processing Worker đã dừng.');
    }
};

/**
 * Chạy thủ công 1 lần (dùng để test hoặc trigger từ API).
 */
const runOnce = () => runWorkerCycle();

module.exports = { startWorker, stopWorker, runOnce };
