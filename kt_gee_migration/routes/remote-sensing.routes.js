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
router.get('/images',          optionalAuth, ctrl.listImages);
router.get('/images/:id',      optionalAuth, ctrl.getImageDetail);
router.get('/images/:id/statistics', optionalAuth, ctrl.getStatistics);
router.get('/images/:id/cog-url', optionalAuth, ctrl.getCogUrl);
router.get('/layers', optionalAuth, ctrl.getLayers);
router.post(
    '/images',
    verifyToken,
    requirePermission('remote_sensing', 'create'),
    uploadRasterFields,    // multer parse multipart
    handleRasterUploadError,
    ctrl.uploadImage,
);

router.get(
    '/upload-url',
    verifyToken,
    requirePermission('remote_sensing', 'create'),
    ctrl.getPresignedUploadUrl,
);

router.post(
    '/upload-commit',
    verifyToken,
    requirePermission('remote_sensing', 'create'),
    ctrl.commitPresignedUpload,
);

router.patch(
    '/images/:id',
    verifyToken,
    requirePermission('remote_sensing', 'update'),
    ctrl.updateImage,
);

router.delete(
    '/images/:id',
    verifyToken,
    requirePermission('remote_sensing', 'delete'),
    ctrl.deleteImage,
);
router.get(
    '/images/:id/download',
    verifyToken,
    requirePermission('remote_sensing', 'download'),
    ctrl.getDownloadUrl,
);
router.post(
    '/images/:id/process',
    verifyToken,
    requireRole('system_admin', 'so_nnmt'),
    ctrl.triggerProcess,
);

// Publish ảnh lên GeoServer (tạo layer WMS) — dùng chung quyền publish của map_layers
router.post(
    '/images/:id/publish',
    verifyToken,
    requirePermission('map_layers', 'publish'),
    ctrl.publishImage,
);

module.exports = router;
