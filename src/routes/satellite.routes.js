'use strict';

const { Router }   = require('express');
const asyncHandler = require('../helpers/async-handler');
const ctrl         = require('../controllers/satellite.controller');
const { optionalAuth, verifyToken, requirePermission } = require('../middlewares/auth.middleware');

const router = Router();

// On-demand imagery — public (results are ephemeral, non-sensitive).
router.post('/rgb',        optionalAuth, asyncHandler(ctrl.getRgb));
router.post('/ndvi',       optionalAuth, asyncHandler(ctrl.getNdvi));
router.post('/heat-map',   optionalAuth, asyncHandler(ctrl.getHeatmap));
router.post('/classified', optionalAuth, asyncHandler(ctrl.getClassified));
router.post('/compare',    optionalAuth, asyncHandler(ctrl.getCompare));

// Tile proxy — public. Hides raw GEE token from client; enables CORS.
// Pattern mirrors /weather/tiles/:type/:z/:x/:y
router.get('/tiles/:resultId/:z/:x/:y', asyncHandler(ctrl.proxyTile));

// GeoServer publish — admin only. Submits async GEE→MinIO→GeoServer export task.
router.post('/publish', verifyToken, requirePermission('satellite', 'manage'),
    asyncHandler(ctrl.publishToGeoServer));

module.exports = router;
