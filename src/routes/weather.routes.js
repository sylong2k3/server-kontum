'use strict';

const { Router } = require('express');
const asyncHandler = require('../helpers/async-handler');
const ctrl = require('../controllers/weather.controller');
const { validate } = require('../middlewares/validate.middleware');
const { optionalAuth, verifyToken, requirePermission } = require('../middlewares/auth.middleware');
const {
    layersQuerySchema,
    pointQuerySchema,
    windGridQuerySchema,
    tileParamsSchema,
} = require('../validators/weather.validator');

const router = Router();

// ── Public/đọc (optionalAuth) ───────────────────────────────────────────────
router.get('/layers', optionalAuth, validate(layersQuerySchema, 'query'), asyncHandler(ctrl.getLayers));
router.get('/point', optionalAuth, validate(pointQuerySchema, 'query'), asyncHandler(ctrl.getPoint));
router.get('/wind-grid', optionalAuth, validate(windGridQuerySchema, 'query'), asyncHandler(ctrl.getWindGrid));

// Proxy tile raster (giữ API key ở server). Public — không gate quyền.
router.get('/tiles/:type/:z/:x/:y', validate(tileParamsSchema, 'params'), asyncHandler(ctrl.proxyTile));

// ── Admin ────────────────────────────────────────────────────────────────────
router.post('/refresh', verifyToken, requirePermission('weather', 'manage'), asyncHandler(ctrl.refresh));

module.exports = router;
