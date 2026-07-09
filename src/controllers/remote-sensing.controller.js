'use strict';

/**
 * Remote Sensing Controller
 * Nhận HTTP request → validate → gọi service → trả response chuẩn.
 *
 * Response format:
 *   Success: { success: true,  message: "...", data: {...}, meta?: {...} }
 *   Error:   { success: false, message: "...", error_code: "..." }
 */

const svc = require('../services/remote-sensing.service');
const {
    createImageSchema, commitUploadSchema, listImagesSchema, updateImageSchema,
    deleteImageSchema, downloadSchema, layersQuerySchema,
    triggerProcessSchema, publishImageSchema,
} = require('../validators/remote-sensing.validator');
const { Api400Error } = require('../core/error.response');
const { t } = require('../utils/i18n.util');

// ── Helper validation ─────────────────────────────────────────────────────────
const validate = (schema, data, lang = 'vi', options = {}) => {
    const { error, value } = schema.validate(data, {
        abortEarly: false,
        stripUnknown: true,
        ...options,
    });
    if (error) {
        const messages = error.details.map((detail) => {
            const path = detail.path.join('.');
            const type = detail.type;
            const context = detail.context || {};

            const specificKey = `${path}.${type}`;
            const generalKey = type;

            let translated = t(specificKey, lang, context);
            if (translated === specificKey) {
                translated = t(generalKey, lang, context);
            }
            return translated === generalKey ? detail.message : translated;
        });
        throw new Api400Error(t('invalid_data', lang), messages);
    }
    return value;
};

// ── IP helper ─────────────────────────────────────────────────────────────────
const getClientIp = (req) =>
    req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.connection?.remoteAddress
    || req.ip;

// ══════════════════════════════════════════════════════════════════════════════
//  POST /api/v1/remote-sensing/images
// ══════════════════════════════════════════════════════════════════════════════
const uploadImage = async (req, res, next) => {
    try {
        // Lấy file từ multer fields
        const rasterFile    = req.files?.raster_file?.[0]   || req.file;
        const thumbnailFile = req.files?.thumbnail?.[0]     || null;
        const metaJsonFile  = req.files?.metadata_json?.[0] || null;

        if (!rasterFile) {
            throw new Api400Error(t('remote_sensing_file_required', req.lang), ['RASTER_FILE_REQUIRED']);
        }

        // Validate metadata từ body
        const metadata = validate(createImageSchema, req.body, req.lang);

        const result = await svc.uploadImage({
            metadata,
            rasterFile,
            thumbnailFile,
            metaJsonFile,
            user: req.user,
            lang: req.lang,
        });

        res.status(201).json({
            success: true,
            message: t('remote_sensing_upload_success', req.lang),
            data: {
                image:  result.image,
                file:   result.file,
                job_id: result.job?.id,
            },
        });
    } catch (err) {
        next(err);
    }
};

// ══════════════════════════════════════════════════════════════════════════════
//  GET /api/v1/remote-sensing/images
// ══════════════════════════════════════════════════════════════════════════════
const listImages = async (req, res, next) => {
    try {
        const filters = validate(listImagesSchema, req.query, req.lang);
        const result  = await svc.listImages(filters, req.user, req.lang);

        res.json({
            success: true,
            message: t('remote_sensing_list_success', req.lang),
            data:    result.rows,
            meta: {
                total:       result.total,
                page:        result.page,
                limit:       result.limit,
                total_pages: Math.ceil(result.total / result.limit),
            },
        });
    } catch (err) {
        next(err);
    }
};

// ══════════════════════════════════════════════════════════════════════════════
//  GET /api/v1/remote-sensing/images/:id
// ══════════════════════════════════════════════════════════════════════════════
const getImageDetail = async (req, res, next) => {
    try {
        const { id }  = req.params;
        const detail  = await svc.getImageDetail(id, req.user, req.lang);

        res.json({
            success: true,
            message: t('remote_sensing_get_success', req.lang),
            data: {
                ...detail.image,
                files:        detail.files,
                statistics:   detail.statistics,
                thumbnail_url: detail.thumbnailUrl,
            },
        });
    } catch (err) {
        next(err);
    }
};

// ══════════════════════════════════════════════════════════════════════════════
//  PATCH /api/v1/remote-sensing/images/:id
// ══════════════════════════════════════════════════════════════════════════════
const updateImage = async (req, res, next) => {
    try {
        const { id } = req.params;
        const data   = validate(updateImageSchema, req.body, req.lang);
        const result = await svc.updateImage(id, data, req.user, req.lang);

        if (!result) {
            throw new Api400Error(t('remote_sensing_no_change', req.lang), ['NOT_FOUND_OR_NO_CHANGE']);
        }

        res.json({
            success: true,
            message: t('remote_sensing_update_success', req.lang),
            data:    result,
        });
    } catch (err) {
        next(err);
    }
};

// ══════════════════════════════════════════════════════════════════════════════
//  DELETE /api/v1/remote-sensing/images/:id
// ══════════════════════════════════════════════════════════════════════════════
const deleteImage = async (req, res, next) => {
    try {
        const { id } = req.params;
        const query  = validate(deleteImageSchema, req.query, req.lang);

        const result = await svc.deleteImage(id, {
            hardDelete: query.hard_delete,
            user:       req.user,
            lang:       req.lang,
        });

        res.json({
            success: true,
            message: query.hard_delete
                ? t('remote_sensing_delete_hard_success', req.lang)
                : t('remote_sensing_delete_soft_success', req.lang),
            data: result,
        });
    } catch (err) {
        next(err);
    }
};

// ══════════════════════════════════════════════════════════════════════════════
//  GET /api/v1/remote-sensing/images/:id/download
// ══════════════════════════════════════════════════════════════════════════════
const getDownloadUrl = async (req, res, next) => {
    try {
        const { id }  = req.params;
        const query   = validate(downloadSchema, req.query, req.lang);
        const result  = await svc.getDownloadUrl(id, {
            fileId:    query.file_id,
            user:      req.user,
            ip:        getClientIp(req),
            userAgent: req.headers['user-agent'],
            lang:      req.lang,
        });

        res.json({
            success: true,
            message: t('remote_sensing_download_success', req.lang),
            data:    result,
        });
    } catch (err) {
        next(err);
    }
};

// ══════════════════════════════════════════════════════════════════════════════
//  GET /api/v1/remote-sensing/images/:id/cog-url
// ══════════════════════════════════════════════════════════════════════════════
const getCogUrl = async (req, res, next) => {
    try {
        const { id } = req.params;
        const result = await svc.getCogUrl(id, req.user, req.lang);

        res.json({
            success: true,
            message: t('remote_sensing_cog_url_success', req.lang),
            data:    result,
        });
    } catch (err) {
        next(err);
    }
};

// ══════════════════════════════════════════════════════════════════════════════
//  GET /api/v1/remote-sensing/layers
// ══════════════════════════════════════════════════════════════════════════════
const getLayers = async (req, res, next) => {
    try {
        const filters = validate(layersQuerySchema, req.query, req.lang);
        const layers  = await svc.getLayersForWebGIS(filters, req.lang);

        res.json({
            success: true,
            message: t('remote_sensing_layers_success', req.lang),
            data:    layers,
            meta:    { count: layers.length },
        });
    } catch (err) {
        next(err);
    }
};

// ══════════════════════════════════════════════════════════════════════════════
//  POST /api/v1/remote-sensing/images/:id/process
// ══════════════════════════════════════════════════════════════════════════════
const triggerProcess = async (req, res, next) => {
    try {
        const { id } = req.params;
        const body   = validate(triggerProcessSchema, req.body, req.lang);
        const result = await svc.triggerProcessingJob(id, {
            ...body,
            user: req.user,
            lang: req.lang,
        });

        res.status(202).json({
            success: true,
            message: t('remote_sensing_process_queued', req.lang),
            data:    result,
        });
    } catch (err) {
        next(err);
    }
};

// ══════════════════════════════════════════════════════════════════════════════
//  GET /api/v1/remote-sensing/images/:id/statistics
// ══════════════════════════════════════════════════════════════════════════════
const getStatistics = async (req, res, next) => {
    try {
        const { id } = req.params;
        const result = await svc.getStatistics(id, req.user, req.lang);

        res.json({
            success: true,
            message: t('remote_sensing_stats_success', req.lang),
            data:    result,
        });
    } catch (err) {
        next(err);
    }
};

// ══════════════════════════════════════════════════════════════════════════════
//  POST /api/v1/remote-sensing/images/:id/publish (đưa ảnh lên GeoServer/WMS)
// ══════════════════════════════════════════════════════════════════════════════
const publishImage = async (req, res, next) => {
    try {
        const { id } = req.params;
        const options = validate(publishImageSchema, req.body || {}, req.lang);
        const result  = await svc.publishImageToGeoServer(id, options, req.user, req.lang);

        res.json({
            success: true,
            message: t('remote_sensing_publish_success', req.lang),
            data:    result,
        });
    } catch (err) {
        next(err);
    }
};

// ══════════════════════════════════════════════════════════════════════════════
//  GET /api/v1/remote-sensing/upload-url (presigned PUT cho client)
// ══════════════════════════════════════════════════════════════════════════════
const getPresignedUploadUrl = async (req, res, next) => {
    try {
        const { file_name } = req.query;
        if (!file_name) {
            throw new Api400Error(t('remote_sensing_filename_required', req.lang), ['FILE_NAME_REQUIRED']);
        }
        const result = await svc.getPresignedUploadUrl({
            fileName: file_name,
            user:     req.user,
            lang:     req.lang,
        });

        res.json({
            success: true,
            message: t('remote_sensing_presigned_success', req.lang),
            data: {
                ...result,
                instructions: req.lang === 'en'
                    ? 'Use HTTP PUT with this URL to upload file directly to MinIO. Attach header: Content-Type: image/tiff'
                    : 'Dùng HTTP PUT với URL này để upload file trực tiếp lên MinIO. Đính kèm header: Content-Type: image/tiff',
            },
        });
    } catch (err) {
        next(err);
    }
};

// ══════════════════════════════════════════════════════════════════════════════
//  POST /api/v1/remote-sensing/upload-commit (tạo DB record sau presigned PUT)
// ══════════════════════════════════════════════════════════════════════════════
const commitPresignedUpload = async (req, res, next) => {
    try {
        const data = validate(commitUploadSchema, req.body, req.lang);
        const result = await svc.commitPresignedUpload({
            data,
            user: req.user,
            lang: req.lang,
        });

        res.status(201).json({
            success: true,
            message: t('remote_sensing_upload_commit_success', req.lang),
            data: {
                image:  result.image,
                file:   result.file,
                job_id: result.job?.id,
            },
        });
    } catch (err) {
        next(err);
    }
};

module.exports = {
    uploadImage,
    listImages,
    getImageDetail,
    updateImage,
    deleteImage,
    getDownloadUrl,
    getCogUrl,
    getLayers,
    publishImage,
    triggerProcess,
    getStatistics,
    getPresignedUploadUrl,
    commitPresignedUpload,
};
