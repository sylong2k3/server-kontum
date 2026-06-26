'use strict';

/**
 * Upload Middleware cho file GIS (Shapefile, GeoJSON, KML/KMZ, GeoTIFF, FileGDB)
 * Dùng multer disk storage — ogr2ogr cần đường dẫn file, không thể dùng memory buffer.
 * File được lưu vào thư mục tạm; worker/service xóa sau khi xử lý xong.
 */

const path   = require('path');
const os     = require('os');
const fs     = require('fs');
const multer = require('multer');
const { Api400Error } = require('../core/error.response');

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
    '.tif',
    '.tiff',
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
    'image/tiff',
    'image/geotiff',
    'image/x-tiff',
]);

const SOURCE_FORMAT_EXTENSIONS = {
    shapefile: ['.zip'],
    geojson:   ['.geojson', '.json'],
    kml:       ['.kml', '.kmz', '.zip'],
    geotiff:   ['.tif', '.tiff'],
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

const fileFilter = (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
        return cb(new Api400Error(
            `Định dạng file không được hỗ trợ: ${ext}. Chấp nhận: .zip, .geojson, .json, .kml, .kmz, .tif, .tiff`,
            ['GEO_UNSUPPORTED_FORMAT'],
        ), false);
    }
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
        // Không từ chối hoàn toàn — một số client gửi mime không chuẩn
        console.warn(`[uploadGeoFile] MIME không chuẩn: ${file.mimetype} (${file.originalname}) — tiếp tục xử lý.`);
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
                        `File quá lớn. Giới hạn: ${GEO_MAX_SIZE / MB} MB`,
                        ['GEO_FILE_TOO_LARGE'],
                    ));
                }
                return next(new Api400Error(err.message, ['GEO_UPLOAD_ERROR']));
            }
            return next(err);
        }
        if (!req.file) {
            return next(new Api400Error('Vui lòng đính kèm file GIS (field: file).', ['GEO_FILE_REQUIRED']));
        }
        req.geoFile = req.file;
        next();
    });
};

module.exports = { uploadGeoFile, GEO_TEMP_DIR, ALLOWED_EXTENSIONS, SOURCE_FORMAT_EXTENSIONS };
