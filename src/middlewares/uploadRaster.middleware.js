'use strict';

/**
 * Upload Middleware cho file Raster / Viễn thám
 * Dùng multer với memory storage (buffer → pipe lên MinIO stream).
 * Giới hạn: 3 GB mỗi file.
 *
 * QUAN TRỌNG: Với file > ~500MB trên server RAM thấp, nên dùng
 * presigned PUT URL (client upload thẳng lên MinIO) thay vì qua Node.js.
 */

const path    = require('path');
const multer  = require('multer');
const { Api400Error } = require('../core/error.response');
const { t } = require('../utils/i18n.util');

const MB = 1024 * 1024;
const GB = 1024 * MB;

// Giới hạn file (bytes)
const RASTER_MAX_SIZE = Number(process.env.UPLOAD_RASTER_MAX_MB || 3072) * MB;

// ── Định nghĩa các loại file được phép ────────────────────────────────────────

/** MIME types cho file raster GeoTIFF */
const RASTER_MIME_TYPES = new Set([
    'image/tiff',
    'image/geotiff',
    'application/octet-stream', // Một số client gửi GeoTIFF dưới dạng này
    'image/x-tiff',
]);

/** Extension hợp lệ cho file raster */
const RASTER_EXTENSIONS = new Set([
    '.tif',
    '.tiff',
    '.geotiff',
]);

/** MIME types cho thumbnail */
const THUMBNAIL_MIME_TYPES = new Set([
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/webp',
]);

/** Extension hợp lệ cho thumbnail */
const THUMBNAIL_EXTENSIONS = new Set([
    '.jpg', '.jpeg', '.png', '.webp',
]);

/** MIME types cho metadata JSON */
const JSON_MIME_TYPES = new Set([
    'application/json',
    'text/plain',
]);

// ── Validators ────────────────────────────────────────────────────────────────

const isRasterFile = (file) => {
    const ext = path.extname(file.originalname).toLowerCase();
    return RASTER_MIME_TYPES.has(file.mimetype) || RASTER_EXTENSIONS.has(ext);
};

const isThumbnailFile = (file) => {
    const ext = path.extname(file.originalname).toLowerCase();
    return THUMBNAIL_MIME_TYPES.has(file.mimetype) && THUMBNAIL_EXTENSIONS.has(ext);
};

const isJsonFile = (file) => {
    const ext = path.extname(file.originalname).toLowerCase();
    return JSON_MIME_TYPES.has(file.mimetype) && ext === '.json';
};

// ── Multer Instances ──────────────────────────────────────────────────────────

/**
 * Uploader cho GeoTIFF/COG chính — giới hạn 3GB, memory storage.
 * Buffer được pipe thẳng lên MinIO sau khi multer parse xong.
 */
const rasterUploader = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: RASTER_MAX_SIZE,
        files: 1,           // Mỗi request chỉ 1 file raster chính
    },
    fileFilter: (req, file, cb) => {
        if (isRasterFile(file)) {
            cb(null, true);
        } else {
            const ext = path.extname(file.originalname).toLowerCase();
            cb(
                new Api400Error(
                    t('upload_invalid_type_with_ext', req.lang, { mime: file.mimetype, ext }),
                    ['INVALID_RASTER_FILE_TYPE'],
                ),
                false,
            );
        }
    },
});

/**
 * Uploader cho ảnh đa tệp (GeoTIFF + thumbnail + JSON metadata).
 * Dùng trong POST /images — nhận nhiều field file cùng lúc.
 *
 * Fields:
 *   - raster_file  (bắt buộc): 1 file GeoTIFF/COG
 *   - thumbnail    (tuỳ chọn): 1 file PNG/JPG
 *   - metadata_json(tuỳ chọn): 1 file JSON
 */
const multiRasterUploader = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: RASTER_MAX_SIZE, // Áp dụng cho file lớn nhất trong request
        files: 3,
    },
    fileFilter: (req, file, cb) => {
        if (isRasterFile(file) || isThumbnailFile(file) || isJsonFile(file)) {
            cb(null, true);
        } else {
            const ext = path.extname(file.originalname).toLowerCase();
            cb(
                new Api400Error(
                    t('upload_invalid_file_name_ext', req.lang, { name: file.originalname, ext }),
                    ['INVALID_FILE_TYPE'],
                ),
                false,
            );
        }
    },
});

// ── Middleware functions ───────────────────────────────────────────────────────

/**
 * Middleware upload 1 field "raster_file"
 */
const uploadSingleRaster = (req, res, next) => {
    rasterUploader.single('raster_file')(req, res, (err) => {
        if (err) { return handleRasterUploadError(err, req, res, next); }
        next();
    });
};

/**
 * Middleware upload đa field: raster_file + thumbnail + metadata_json
 */
const uploadRasterFields = (req, res, next) => {
    multiRasterUploader.fields([
        { name: 'raster_file',   maxCount: 1 },
        { name: 'thumbnail',     maxCount: 1 },
        { name: 'metadata_json', maxCount: 1 },
    ])(req, res, (err) => {
        if (err) { return handleRasterUploadError(err, req, res, next); }
        next();
    });
};

/**
 * Validate raster_file bắt buộc phải tồn tại sau khi multer parse.
 */
const requireRasterFile = (req, _res, next) => {
    const file = req.file || (req.files && req.files.raster_file?.[0]);
    if (!file) {
        return next(new Api400Error(t('remote_sensing_file_required', req.lang), ['RASTER_FILE_REQUIRED']));
    }
    next();
};

// ── Error Handler ─────────────────────────────────────────────────────────────

const handleRasterUploadError = (err, req, _res, next) => {
    if (err instanceof multer.MulterError) {
        switch (err.code) {
            case 'LIMIT_FILE_SIZE': {
                const maxMB = Math.round(RASTER_MAX_SIZE / MB);
                return next(new Api400Error(
                    t('upload_file_too_large_limit', req.lang, { max: maxMB, gb: Math.round(maxMB / 1024) }),
                    ['FILE_TOO_LARGE'],
                ));
            }
            case 'LIMIT_FILE_COUNT':
                return next(new Api400Error(t('upload_too_many_files_limit', req.lang), ['TOO_MANY_FILES']));
            case 'LIMIT_UNEXPECTED_FILE':
                return next(new Api400Error(t('upload_invalid_field', req.lang, { field: err.field }), ['UNEXPECTED_FIELD']));
            default:
                return next(new Api400Error(t('upload_failed_msg', req.lang, { msg: err.message }), [err.code]));
        }
    }
    next(err);
};

module.exports = {
    uploadSingleRaster,
    uploadRasterFields,
    requireRasterFile,
    handleRasterUploadError,
    isRasterFile,
    isThumbnailFile,
    RASTER_MAX_SIZE,
};
