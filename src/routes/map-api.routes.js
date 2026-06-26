'use strict';

const { Router } = require('express');
const asyncHandler = require('../helpers/async-handler');
const ctrl = require('../controllers/map-api.controller');
const { validate } = require('../middlewares/validate.middleware');
const { verifyToken, enforcePasswordChange, requirePermission } = require('../middlewares/auth.middleware');
const {
    authenticateMapApiKey,
    mapApiRateLimit,
    mapApiReadOnly,
} = require('../middlewares/mapApiKey.middleware');
const {
    createKeySchema,
    updateKeySchema,
    listKeysSchema,
    idParamsSchema,
    featuresQuerySchema,
} = require('../validators/map-api.validator');

// ── Admin router — mounted at /api/v1/map-apis ───────────────────────────────
const adminRouter = Router();

adminRouter.use(verifyToken, enforcePasswordChange);

adminRouter.post(
    '/',
    requirePermission('map_apis', 'create'),
    validate(createKeySchema),
    asyncHandler(ctrl.createKey),
);

adminRouter.get(
    '/',
    requirePermission('map_apis', 'read'),
    validate(listKeysSchema, 'query'),
    asyncHandler(ctrl.listKeys),
);

adminRouter.get(
    '/:id',
    requirePermission('map_apis', 'read'),
    validate(idParamsSchema, 'params'),
    asyncHandler(ctrl.getKey),
);

adminRouter.patch(
    '/:id',
    requirePermission('map_apis', 'update'),
    validate(idParamsSchema, 'params'),
    validate(updateKeySchema),
    asyncHandler(ctrl.updateKey),
);

adminRouter.post(
    '/:id/regenerate',
    requirePermission('map_apis', 'update'),
    validate(idParamsSchema, 'params'),
    asyncHandler(ctrl.regenerateKey),
);

adminRouter.delete(
    '/:id',
    requirePermission('map_apis', 'delete'),
    validate(idParamsSchema, 'params'),
    asyncHandler(ctrl.deleteKey),
);

// ── Data router — mounted at /api/v1/map-data (xác thực bằng X-Map-Api-Key) ──
const dataRouter = Router();

dataRouter.use(mapApiReadOnly, authenticateMapApiKey, mapApiRateLimit);

dataRouter.get('/layer', asyncHandler(ctrl.getLayerMeta));
dataRouter.get('/features', validate(featuresQuerySchema, 'query'), asyncHandler(ctrl.getFeatures));

module.exports = { adminRouter, dataRouter };
