'use strict';

const { Router } = require('express');
const asyncHandler = require('../helpers/async-handler');
const ctrl = require('../controllers/spatial.controller');
const { validate } = require('../middlewares/validate.middleware');
const { verifyToken, requirePermission } = require('../middlewares/auth.middleware');
const {
    forestChangeQuerySchema,
    residentialDistanceQuerySchema,
} = require('../validators/spatial.validator');

const router = Router();

// US-061 — Thay đổi rừng giữa 2 mốc. Quyền: spatial.read.
router.get(
    '/forest-change',
    verifyToken,
    requirePermission('spatial', 'read'),
    validate(forestChangeQuerySchema, 'query'),
    asyncHandler(ctrl.getForestChange),
);

// US-062 — Khoảng cách dân cư – rừng. Quyền: spatial.analyze.
router.get(
    '/residential-distance',
    verifyToken,
    requirePermission('spatial', 'analyze'),
    validate(residentialDistanceQuerySchema, 'query'),
    asyncHandler(ctrl.getResidentialDistance),
);

module.exports = router;
