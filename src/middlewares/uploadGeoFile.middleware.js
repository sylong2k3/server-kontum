'use strict';

/**
 * Upload Middleware cho file GIS vector (Shapefile, GeoJSON, KML/KMZ, FileGDB)
 * Dùng multer disk storage — ogr2ogr cần đường dẫn file, không thể dùng memory buffer.
 * File được lưu vào thư mục tạm; worker/service xóa sau khi xử lý xong.
 *
 * Raster GeoTIFF không đi qua đây — upload vào kho viễn thám
 * (POST /remote-sensing/images) rồi publish lên GeoServer.
 */

const path   = require('path');
const os     = require('os');
const fs     = require('fs');
const multer = require('multer');
const { Api400Error } = require('../core/error.response');
const { t } = require('../utils/i18n.util');

const MB = 1024 * 1024;

const GEO_MAX_SIZE = Number(process.env.UPLOAD_GEO_MAX_MB || 500) * MB;

// ── Thư mục tạm ───────────────────────────────────────────────────────────────

const GEO_TEMP_DIR = process.env.GEO_UPLOAD_TEMP_DIR
    || path.join(os.tmpdir(), 'kontum_geo_uploads');

if (!fs.existsSync(GEO_TEMP_DIR)) {
    fs.mkdirSync(GEO_TEMP_DIR, { recursive: true });
}

// ── Định nghĩa loại file hợp lệ ──────────────────────────────────────────────

const ALLOWED_EXTENSIONS = new Set([
    '.zip',      // Shapefile đóng gói zip, FileGDB zip, KMZ
    '.geojson',
    '.json',
    '.kml',
    '.kmz',
    '.gdb',
]);

const ALLOWED_MIME_TYPES = new Set([
    'application/zip',
    'application/x-zip-compressed',
    'application/octet-stream',
    'application/json',
    'application/geo+json',
    'application/vnd.google-earth.kml+xml',
    'application/vnd.google-earth.kmz',
    'text/xml',
    'application/xml',
]);

const SOURCE_FORMAT_EXTENSIONS = {
    shapefile: ['.zip'],
    geojson:   ['.geojson', '.json'],
    kml:       ['.kml', '.kmz', '.zip'],
    filegdb:   ['.zip', '.gdb'],
};

// ── Multer disk storage ───────────────────────────────────────────────────────

const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, GEO_TEMP_DIR),
    filename: (_req, file, cb) => {
        const ext  = path.extname(file.originalname).toLowerCase();
        const base = `geo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
        cb(null, base);
    },
});

const fileFilter = (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
        return cb(new Api400Error(
            t('upload_geo_unsupported_format_with_ext', req.lang, { ext }),
            ['GEO_UNSUPPORTED_FORMAT'],
        ), false);
    }
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
        // Không từ chối hoàn toàn — một số client gửi mime không chuẩn
        console.warn(t('upload_geo_non_standard_mime', req.lang, { mime: file.mimetype, name: file.originalname }));
    }
    cb(null, true);
};

const upload = multer({
    storage,
    fileFilter,
    limits: { fileSize: GEO_MAX_SIZE, files: 1 },
});

// ── Middleware export ─────────────────────────────────────────────────────────

/**
 * Middleware nhận đúng 1 field 'file' (multipart/form-data).
 * Gắn req.geoFile = req.file sau khi multer xử lý.
 */
const uploadGeoFile = (req, res, next) => {
    upload.single('file')(req, res, (err) => {
        if (err) {
            if (err instanceof multer.MulterError) {
                if (err.code === 'LIMIT_FILE_SIZE') {
                    return next(new Api400Error(
                        t('upload_geo_file_too_large_limit', req.lang, { max: GEO_MAX_SIZE / MB }),
                        ['GEO_FILE_TOO_LARGE'],
                    ));
                }
                return next(new Api400Error(err.message, ['GEO_UPLOAD_ERROR']));
            }
            return next(err);
        }
        if (!req.file) {
            return next(new Api400Error(t('upload_geo_file_required', req.lang), ['GEO_FILE_REQUIRED']));
        }
        req.geoFile = req.file;
        next();
    });
};

module.exports = { uploadGeoFile, GEO_TEMP_DIR, ALLOWED_EXTENSIONS, SOURCE_FORMAT_EXTENSIONS };
