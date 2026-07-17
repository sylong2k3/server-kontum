'use strict';

const { Router }   = require('express');
const asyncHandler = require('../helpers/async-handler');
const ctrl         = require('../controllers/satellite.controller');
const { optionalAuth, verifyToken, requirePermission } = require('../middlewares/auth.middleware');

const router = Router();

// On-demand imagery — public (results are ephemeral, non-sensitive).
// Response chỉ có `geeTileUrl` (Earth Engine CDN trực tiếp) — client gọi thẳng
// tile từ Google, không đi qua Node.js. Proxy `/tiles/:id/:z/:x/:y` cũ đã gỡ
// theo yêu cầu vì client không cần Node trung chuyển nữa.
router.post('/rgb',        optionalAuth, asyncHandler(ctrl.getRgb));
router.post('/ndvi',       optionalAuth, asyncHandler(ctrl.getNdvi));
router.post('/heat-map',   optionalAuth, asyncHandler(ctrl.getHeatmap));
router.post('/classified', optionalAuth, asyncHandler(ctrl.getClassified));
router.post('/fire-risk',  optionalAuth, asyncHandler(ctrl.getFireRisk));

// GeoServer publish — admin only. Submits async GEE→MinIO→GeoServer export task.
router.post('/publish', verifyToken, requirePermission('satellite', 'manage'),
    asyncHandler(ctrl.publishToGeoServer));

module.exports = router;
