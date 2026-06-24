'use strict';

/**
 * Remote Sensing Controller
 * Nhận HTTP request → validate → gọi service → trả response chuẩn.
 *
 * Response format:
 *   Success: { success: true,  message: "...", data: {...}, meta?: {...} }
 *   Error:   { success: false, message: "...", error_code: "..." }
 */

const svc = require('../services/remoteSensing.service');
const {
    createImageSchema, listImagesSchema, updateImageSchema,
    deleteImageSchema, downloadSchema, layersQuerySchema,
    triggerProcessSchema,
} = require('../validators/remoteSensing.validator');
const { Api400Error } = require('../core/error.response');

// ── Helper validation ─────────────────────────────────────────────────────────
const validate = (schema, data, options = {}) => {
    const { error, value } = schema.validate(data, {
        abortEarly: false,
        stripUnknown: true,
        ...options,
    });
    if (error) {
        const messages = error.details.map((d) => d.message).join('; ');
        throw new Api400Error(messages, error.details.map((d) => d.type));
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
            throw new Api400Error('Vui lòng đính kèm file GeoTIFF (field: raster_file).', ['RASTER_FILE_REQUIRED']);
        }

        // Validate metadata từ body
        const metadata = validate(createImageSchema, req.body);

        const result = await svc.uploadImage({
            metadata,
            rasterFile,
            thumbnailFile,
            metaJsonFile,
            user: req.user,
        });

        res.status(201).json({
            success: true,
            message: 'Upload ảnh viễn thám thành công.',
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
        const filters = validate(listImagesSchema, req.query);
        const result  = await svc.listImages(filters, req.user);

        res.json({
            success: true,
            message: 'Lấy danh sách ảnh thành công.',
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
        const detail  = await svc.getImageDetail(id, req.user);

        res.json({
            success: true,
            message: 'Lấy chi tiết ảnh thành công.',
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
        const data   = validate(updateImageSchema, req.body);
        const result = await svc.updateImage(id, data, req.user);

        if (!result) {
            throw new Api400Error('Không tìm thấy ảnh hoặc không có thay đổi.', ['NOT_FOUND_OR_NO_CHANGE']);
        }

        res.json({
            success: true,
            message: 'Cập nhật ảnh viễn thám thành công.',
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
        const query  = validate(deleteImageSchema, req.query);

        const result = await svc.deleteImage(id, {
            hardDelete: query.hard_delete,
            user:       req.user,
        });

        res.json({
            success: true,
            message: query.hard_delete
                ? 'Đã xóa ảnh và file MinIO thành công.'
                : 'Đã xóa ảnh thành công (soft delete).',
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
        const query   = validate(downloadSchema, req.query);
        const result  = await svc.getDownloadUrl(id, {
            fileId:    query.file_id,
            user:      req.user,
            ip:        getClientIp(req),
            userAgent: req.headers['user-agent'],
        });

        res.json({
            success: true,
            message: 'Tạo link tải thành công. Link hết hạn sau 15 phút.',
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
        const result = await svc.getCogUrl(id, req.user);

        res.json({
            success: true,
            message: 'Lấy COG URL thành công.',
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
        const filters = validate(layersQuerySchema, req.query);
        const layers  = await svc.getLayersForWebGIS(filters);

        res.json({
            success: true,
            message: 'Lấy danh sách layers thành công.',
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
        const body   = validate(triggerProcessSchema, req.body);
        const result = await svc.triggerProcessingJob(id, {
            ...body,
            user: req.user,
        });

        res.status(202).json({
            success: true,
            message: 'Đã tạo job xử lý ảnh. Kết quả sẽ được cập nhật sau.',
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
        const result = await svc.getStatistics(id, req.user);

        res.json({
            success: true,
            message: 'Lấy thống kê band thành công.',
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
            throw new Api400Error('Vui lòng cung cấp tên file (query: file_name).', ['FILE_NAME_REQUIRED']);
        }
        const result = await svc.getPresignedUploadUrl({
            fileName: file_name,
            user:     req.user,
        });

        res.json({
            success: true,
            message: 'Tạo presigned upload URL thành công.',
            data: {
                ...result,
                instructions: 'Dùng HTTP PUT với URL này để upload file trực tiếp lên MinIO. Đính kèm header: Content-Type: image/tiff',
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
    triggerProcess,
    getStatistics,
    getPresignedUploadUrl,
};
