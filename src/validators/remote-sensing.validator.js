'use strict';

/**
 * Joi Validators — Remote Sensing Images
 * Validate input cho tất cả API remote sensing.
 */

const Joi = require('joi');

// ── Danh sách hợp lệ ──────────────────────────────────────────────────────────

const SATELLITE_TYPES = [
    'landsat_8', 'landsat_9',
    'sentinel_1', 'sentinel_2', 'sentinel_3',
    'modis', 'viirs', 'planet', 'spot', 'vnredsat', 'other',
];

const IMAGE_TYPES = [
    'geotiff_raw', 'cog', 'ndvi', 'ndwi', 'nbr', 'lst',
    'land_cover', 'forest_cover', 'rgb_composite',
    'thumbnail', 'metadata_json', 'other',
];

const PROCESSING_STATUSES = ['pending', 'processing', 'completed', 'failed', 'cancelled'];

// ── Reusable sub-schemas ──────────────────────────────────────────────────────

/** Bbox GeoJSON Polygon [minX, minY, maxX, maxY] hoặc GeoJSON object */
const bboxSchema = Joi.alternatives().try(
    // Dạng array [minLon, minLat, maxLon, maxLat]
    Joi.array().items(Joi.number()).length(4),
    // Dạng GeoJSON Polygon string
    Joi.string().max(2000),
    // Dạng GeoJSON object
    Joi.object({
        type:        Joi.string().valid('Polygon').required(),
        coordinates: Joi.array().required(),
    }),
);

// ── API Schemas ───────────────────────────────────────────────────────────────

/**
 * POST /api/v1/remote-sensing/images
 * Tạo ảnh mới kèm upload file
 */
const createImageSchema = Joi.object({
    // Thông tin bắt buộc
    name:             Joi.string().trim().min(2).max(500).required(),
    satellite:        Joi.string().valid(...SATELLITE_TYPES).required(),
    image_type:       Joi.string().valid(...IMAGE_TYPES).required(),
    acquisition_date: Joi.date().iso().max('now').required(),

    // Không gian địa lý
    bbox:             bboxSchema.optional(),
    province_code:    Joi.string().trim().max(20).optional(),
    district_code:    Joi.string().trim().max(20).optional(),
    location_name:    Joi.string().trim().max(255).optional(),

    // Đặc tính kỹ thuật
    cloud_percent:    Joi.number().min(0).max(100).optional(),
    resolution_m:     Joi.number().positive().optional(),
    epsg_code:        Joi.number().integer().positive().optional(),
    band_count:       Joi.number().integer().positive().optional(),
    nodata_value:     Joi.number().optional(),

    // Metadata và hiển thị
    description:      Joi.string().trim().max(5000).allow('', null).optional(),
    is_public:        Joi.boolean().default(false),
    is_featured:      Joi.boolean().default(false),
    extra_metadata:   Joi.object().default({}),

    // Thời gian chụp (tuỳ chọn)
    acquisition_time: Joi.string().pattern(/^\d{2}:\d{2}(:\d{2})?(\+\d{2}:\d{2})?$/).optional(),
});

/**
 * GET /api/v1/remote-sensing/images
 * Query params cho danh sách ảnh
 */
const listImagesSchema = Joi.object({
    // Text search
    keyword:       Joi.string().trim().max(200).optional(),

    // Bộ lọc
    satellite:     Joi.string().valid(...SATELLITE_TYPES).optional(),
    image_type:    Joi.string().valid(...IMAGE_TYPES).optional(),
    status:        Joi.string().valid(...PROCESSING_STATUSES).optional(),
    is_public:     Joi.boolean().optional(),
    province_code: Joi.string().trim().max(20).optional(),
    district_code: Joi.string().trim().max(20).optional(),

    // Lọc theo năm
    year:          Joi.number().integer().min(1970).max(new Date().getFullYear() + 1).optional(),

    // Lọc theo khoảng ngày
    date_from:     Joi.date().iso().optional(),
    date_to:       Joi.date().iso().min(Joi.ref('date_from')).optional(),

    // Bộ lọc không gian (bbox: "minLon,minLat,maxLon,maxLat")
    bbox:          Joi.string()
                      .pattern(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?$/)
                      .optional(),

    // Phân trang
    page:          Joi.number().integer().min(1).default(1),
    limit:         Joi.number().integer().min(1).max(100).default(20),

    // Sắp xếp
    sort_by:       Joi.string().valid('acquisition_date', 'created_at', 'name', 'cloud_percent').default('acquisition_date'),
    sort_order:    Joi.string().valid('asc', 'desc').default('desc'),
});

/**
 * PATCH /api/v1/remote-sensing/images/:id
 * Cập nhật metadata ảnh
 */
const updateImageSchema = Joi.object({
    name:             Joi.string().trim().min(2).max(500).optional(),
    description:      Joi.string().trim().max(5000).allow('', null).optional(),
    satellite:        Joi.string().valid(...SATELLITE_TYPES).optional(),
    image_type:       Joi.string().valid(...IMAGE_TYPES).optional(),
    acquisition_date: Joi.date().iso().max('now').optional(),
    acquisition_time: Joi.string().pattern(/^\d{2}:\d{2}(:\d{2})?(\+\d{2}:\d{2})?$/).optional(),

    bbox:             bboxSchema.optional(),
    province_code:    Joi.string().trim().max(20).allow('', null).optional(),
    district_code:    Joi.string().trim().max(20).allow('', null).optional(),
    location_name:    Joi.string().trim().max(255).allow('', null).optional(),

    cloud_percent:    Joi.number().min(0).max(100).optional(),
    resolution_m:     Joi.number().positive().optional(),
    epsg_code:        Joi.number().integer().positive().optional(),
    band_count:       Joi.number().integer().positive().optional(),
    nodata_value:     Joi.number().allow(null).optional(),

    is_public:        Joi.boolean().optional(),
    is_featured:      Joi.boolean().optional(),
    status:           Joi.string().valid(...PROCESSING_STATUSES).optional(),
    extra_metadata:   Joi.object().optional(),
    // Optimistic locking (optional): nếu client gửi, backend chỉ update khi updated_at khớp.
    expectedUpdatedAt: Joi.date().iso().optional(),
}).min(1);

/**
 * DELETE /api/v1/remote-sensing/images/:id
 * Query params cho delete
 */
const deleteImageSchema = Joi.object({
    hard_delete: Joi.boolean().default(false), // true = xóa cả object trên MinIO
});

/**
 * GET /api/v1/remote-sensing/images/:id/download
 */
const downloadSchema = Joi.object({
    file_id: Joi.number().integer().positive().optional(), // Cụ thể 1 file, mặc định lấy primary
});

/**
 * GET /api/v1/remote-sensing/layers
 */
const layersQuerySchema = Joi.object({
    satellite:     Joi.string().valid(...SATELLITE_TYPES).optional(),
    image_type:    Joi.string().valid(...IMAGE_TYPES).optional(),
    province_code: Joi.string().trim().max(20).optional(),
    bbox:          Joi.string()
                      .pattern(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?$/)
                      .optional(),
    limit:         Joi.number().integer().min(1).max(500).default(100),
});

/**
 * POST /api/v1/remote-sensing/images/:id/process
 */
const triggerProcessSchema = Joi.object({
    job_type: Joi.string().valid('convert_cog', 'gen_thumbnail', 'calc_statistics', 'full_pipeline').default('full_pipeline'),
    priority: Joi.number().integer().min(1).max(10).default(5),
});

// ── Validate ID param ─────────────────────────────────────────────────────────
const idParamSchema = Joi.object({
    id: Joi.alternatives().try(
        Joi.number().integer().positive(),
        Joi.string().uuid(),
    ).required(),
});

module.exports = {
    createImageSchema,
    listImagesSchema,
    updateImageSchema,
    deleteImageSchema,
    downloadSchema,
    layersQuerySchema,
    triggerProcessSchema,
    idParamSchema,
    SATELLITE_TYPES,
    IMAGE_TYPES,
    PROCESSING_STATUSES,
};
