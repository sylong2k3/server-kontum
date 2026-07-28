'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const multer = require('multer');
const { Api400Error } = require('../core/error.response');
const { t } = require('../utils/i18n.util');

const MB = 1024 * 1024;
const maxBytes = Number(process.env.LAYER_SERIES_MAX_MB || 500) * MB;
const tempDir = process.env.LAYER_SERIES_TEMP_DIR || path.join(os.tmpdir(), 'kontum_layer_series');
fs.mkdirSync(tempDir, { recursive: true });

const upload = multer({
    storage: multer.diskStorage({
        destination: (_req, _file, cb) => cb(null, tempDir),
        filename: (_req, file, cb) => cb(
            null,
            `granule_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${path.extname(file.originalname).toLowerCase()}`
        ),
    }),
    limits: { fileSize: maxBytes, files: 1 },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (!new Set(['.tif', '.tiff']).has(ext)) {
            return cb(new Api400Error(t('layer_series_tiff_required', req.lang), ['TIFF_REQUIRED']), false);
        }
        cb(null, true);
    },
});

const uploadLayerGranule = (req, res, next) => {
    upload.single('file')(req, res, (error) => {
        if (error) { return next(error); }
        if (!req.file) {
            return next(new Api400Error(t('layer_series_file_required', req.lang), ['FILE_REQUIRED']));
        }
        next();
    });
};

module.exports = { uploadLayerGranule };
