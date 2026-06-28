'use strict';

const { Router } = require('express');
const asyncHandler = require('../helpers/async-handler');
const ctrl = require('../controllers/statistics.controller');
const { validate } = require('../middlewares/validate.middleware');
const { optionalAuth, verifyToken, requirePermission } = require('../middlewares/auth.middleware');
const {
    unitsQuerySchema,
    landcoverQuerySchema,
    dashboardQuerySchema,
} = require('../validators/statistics.validator');

const router = Router();

// ── Public/đọc (optionalAuth) — số liệu công bố ──────────────────────────────
router.get('/administrative-units', optionalAuth, validate(unitsQuerySchema, 'query'), asyncHandler(ctrl.getAdministrativeUnits));
router.get('/landcover', optionalAuth, validate(landcoverQuerySchema, 'query'), asyncHandler(ctrl.getLandcover));

// ── Dashboard điều hành — cần quyền ──────────────────────────────────────────
router.get(
    '/dashboard',
    verifyToken,
    requirePermission('statistics', 'dashboard'),
    validate(dashboardQuerySchema, 'query'),
    asyncHandler(ctrl.getDashboard),
);

module.exports = router;
