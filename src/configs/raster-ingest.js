'use strict';

/**
 * Cấu hình pipeline ingest GeoTIFF từ GEE download URL vào MinIO
 * và publish sang GeoServer qua S3GeoTiff CoverageStore.
 *
 * Nguồn env — xem `.env.example` block "GEE Raster Ingest".
 */

const os   = require('os');
const path = require('path');

const MB = 1024 * 1024;

// ── Feature flag ─────────────────────────────────────────────────────────────
const ENABLED = String(process.env.RASTER_INGEST_ENABLED || 'true').toLowerCase() === 'true';

// ── Buckets & path ───────────────────────────────────────────────────────────
const MINIO_BUCKET = process.env.MINIO_BUCKET_GEE_RASTER || 'gee-rasters';

// Thư mục tạm cho unzip. Mặc định OS tmpdir → tự dọn khi reboot.
const TMP_DIR = process.env.RASTER_INGEST_TMP_DIR
    || path.join(os.tmpdir(), 'kontum_gee_ingest');

// ── Limits ───────────────────────────────────────────────────────────────────
// Đơn vị MB để đồng bộ với UPLOAD_RASTER_MAX_MB — nội bộ đổi bytes 1 lần.
const MAX_BYTES = Number(process.env.RASTER_INGEST_MAX_MB || 3072) * MB;

const FETCH_TIMEOUT_MS = Number(process.env.RASTER_INGEST_FETCH_TIMEOUT_MS || 900_000);
const MAX_RETRIES      = Number(process.env.RASTER_INGEST_MAX_RETRIES || 3);
// Earth Engine Restricted Mode chỉ cho phép rất ít request getPixels đồng thời.
// Chạy tuần tự mặc định để các URL forest/fire không tự tranh quota với nhau.
const CONCURRENCY      = Math.max(1, Number(process.env.RASTER_INGEST_CONCURRENCY || 1));

// GDAL cache khi merge band GEE zip → RGB GeoTIFF (MB).
const GDAL_CACHEMAX_MB = Number(process.env.GDAL_CACHEMAX_MB || 512);

// ── GeoServer S3 config (cho gs-s3-geotiff extension) ────────────────────────
// GeoServer đọc trực tiếp từ MinIO S3 → không cần shared filesystem.
// URL dạng `s3://bucket/key?awsRegion=...&useAnonymous=false` (theo docs
// gs-s3-geotiff — actual endpoint config bằng system property JVM).
const S3_ENDPOINT   = process.env.MINIO_S3_ENDPOINT
    || (process.env.MINIO_ENDPOINT && process.env.MINIO_PORT
        ? `${process.env.MINIO_USE_SSL === 'true' ? 'https' : 'http'}://${process.env.MINIO_ENDPOINT}:${process.env.MINIO_PORT}`
        : '');
const S3_REGION     = process.env.MINIO_REGION || 'us-east-1';
const S3_ACCESS_KEY = process.env.MINIO_ACCESS_KEY || '';
const S3_SECRET_KEY = process.env.MINIO_SECRET_KEY || '';

// ── Worker ───────────────────────────────────────────────────────────────────
const WORKER_POLL_CRON = process.env.RASTER_INGEST_WORKER_POLL_CRON || '*/15 * * * * *';

// Kon Tum province defaults (@ 100m). Client override được nhưng đây là mặc
// định cho ingest ảnh cả tỉnh — dùng cho preview / thử pipeline.
const KONTUM_BBOX      = [107.28, 13.83, 108.94, 15.55];
const DEFAULT_SCALE_M  = 100;

// ── Helpers ──────────────────────────────────────────────────────────────────

const isS3Configured = () =>
    Boolean(S3_ENDPOINT && S3_ACCESS_KEY && S3_SECRET_KEY);

module.exports = {
    ENABLED,
    MINIO_BUCKET,
    TMP_DIR,
    MAX_BYTES,
    FETCH_TIMEOUT_MS,
    MAX_RETRIES,
    CONCURRENCY,
    GDAL_CACHEMAX_MB,
    S3_ENDPOINT,
    S3_REGION,
    S3_ACCESS_KEY,
    S3_SECRET_KEY,
    WORKER_POLL_CRON,
    KONTUM_BBOX,
    DEFAULT_SCALE_M,
    isS3Configured,
};
