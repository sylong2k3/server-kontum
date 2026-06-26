'use strict';
const { Router } = require('express');

const ctrl = require('../controllers/remote-sensing.controller');
const {
    verifyToken,
    optionalAuth,
    requirePermission,
    requireRole,
} = require('../middlewares/auth.middleware');
const {
    uploadRasterFields,
    handleRasterUploadError,
} = require('../middlewares/uploadRaster.middleware');

const router = Router();

// ── Công khai / optional auth ─────────────────────────────────────────────────

/**
 * @route  GET /api/v1/remote-sensing/images
 * @desc   Danh sách ảnh viễn thám (phân trang + bộ lọc)
 * @access optionalAuth — citizen chỉ thấy is_public=true
 */
router.get('/images',          optionalAuth, ctrl.listImages);

/**
 * @route  GET /api/v1/remote-sensing/images/:id
 * @desc   Chi tiết 1 ảnh (kèm files, statistics, thumbnail URL)
 * @access optionalAuth
 */
router.get('/images/:id',      optionalAuth, ctrl.getImageDetail);

/**
 * @route  GET /api/v1/remote-sensing/images/:id/statistics
 * @desc   Thống kê pixel các band (min/max/mean/std)
 * @access optionalAuth
 */
router.get('/images/:id/statistics', optionalAuth, ctrl.getStatistics);

/**
 * @route  GET /api/v1/remote-sensing/images/:id/cog-url
 * @desc   Lấy presigned URL cho COG/GeoTIFF dùng với OpenLayers / Mapbox
 * @access optionalAuth (private image → phải đăng nhập)
 */
router.get('/images/:id/cog-url', optionalAuth, ctrl.getCogUrl);

/**
 * @route  GET /api/v1/remote-sensing/layers
 * @desc   Danh sách layers cho WebGIS (kèm cogUrl, bbox, metadata)
 * @access Public (chỉ trả is_public=true, status=completed)
 */
router.get('/layers', optionalAuth, ctrl.getLayers);


// ── Cần đăng nhập ────────────────────────────────────────────────────────────

/**
 * @route  POST /api/v1/remote-sensing/images
 * @desc   Upload ảnh GeoTIFF + metadata
 * @access verifyToken + requirePermission('remote_sensing', 'create')
 * @body   multipart/form-data
 *   - raster_file    (required) — GeoTIFF / COG, max 3GB
 *   - thumbnail      (optional) — PNG/JPG
 *   - metadata_json  (optional) — JSON metadata
 *   - name           (required) — Tên ảnh
 *   - satellite      (required) — landsat_8 | sentinel_2 | ...
 *   - image_type     (required) — geotiff_raw | ndvi | ...
 *   - acquisition_date (required) — YYYY-MM-DD
 *   - [các trường khác tuỳ chọn]
 */
router.post(
    '/images',
    verifyToken,
    requirePermission('remote_sensing', 'create'),
    uploadRasterFields,    // multer parse multipart
    handleRasterUploadError,
    ctrl.uploadImage,
);

/**
 * @route  GET /api/v1/remote-sensing/upload-url
 * @desc   Lấy presigned PUT URL để client upload trực tiếp lên MinIO
 *         (Dùng khi file quá lớn, tránh qua Node.js)
 * @query  file_name — tên file sẽ upload
 * @access verifyToken
 */
router.get(
    '/upload-url',
    verifyToken,
    requirePermission('remote_sensing', 'create'),
    ctrl.getPresignedUploadUrl,
);

/**
 * @route  PATCH /api/v1/remote-sensing/images/:id
 * @desc   Cập nhật metadata ảnh (owner hoặc admin)
 * @access verifyToken + requirePermission('remote_sensing', 'update')
 */
router.patch(
    '/images/:id',
    verifyToken,
    requirePermission('remote_sensing', 'update'),
    ctrl.updateImage,
);

/**
 * @route  DELETE /api/v1/remote-sensing/images/:id
 * @desc   Soft delete ảnh. Query ?hard_delete=true → xóa cả MinIO
 * @access verifyToken + requirePermission('remote_sensing', 'delete')
 */
router.delete(
    '/images/:id',
    verifyToken,
    requirePermission('remote_sensing', 'delete'),
    ctrl.deleteImage,
);

/**
 * @route  GET /api/v1/remote-sensing/images/:id/download
 * @desc   Tạo presigned download URL 15 phút + ghi log
 * @query  file_id (optional) — download file cụ thể
 * @access verifyToken + requirePermission('remote_sensing', 'download')
 */
router.get(
    '/images/:id/download',
    verifyToken,
    requirePermission('remote_sensing', 'download'),
    ctrl.getDownloadUrl,
);

/**
 * @route  POST /api/v1/remote-sensing/images/:id/process
 * @desc   Trigger job xử lý ảnh (thumbnail + stats)
 * @access Admin / so_nnmt
 */
router.post(
    '/images/:id/process',
    verifyToken,
    requireRole('system_admin', 'so_nnmt'),
    ctrl.triggerProcess,
);

module.exports = router;
