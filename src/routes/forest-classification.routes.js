'use strict';

const { Router }   = require('express');
const asyncHandler = require('../helpers/async-handler');
const ctrl         = require('../controllers/forest-classification.controller');
const { optionalAuth, verifyToken, requirePermission } = require('../middlewares/auth.middleware');

const router = Router();

// ── Public / optionalAuth ─────────────────────────────────────────────────────

// Latest completed snapshot.
router.get('/latest',  optionalAuth, asyncHandler(ctrl.getLatest));

// On-demand user query: cache-hit returns immediately; miss triggers async run.
// optionalAuth so authenticated users are logged as requester.
router.post('/query',  optionalAuth, asyncHandler(ctrl.queryPeriod));

// Poll a specific snapshot (for clients waiting on computing=true results).
router.get('/snapshot/:id', optionalAuth, asyncHandler(ctrl.getSnapshot));

// ── Admin only ────────────────────────────────────────────────────────────────

// Completed runs (existing public-facing history).
router.get('/history', verifyToken, requirePermission('forest_classification', 'manage'),
    asyncHandler(ctrl.getHistory));

// Full audit log — all runs, all statuses, timing, trigger, errors.
router.get('/logs', verifyToken, requirePermission('forest_classification', 'manage'),
    asyncHandler(ctrl.getLogs));

// Manually trigger a run for a specific period.
router.post('/refresh', verifyToken, requirePermission('forest_classification', 'manage'),
    asyncHandler(ctrl.refresh));

module.exports = router;
