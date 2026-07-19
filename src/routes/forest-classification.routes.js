'use strict';

const { Router }   = require('express');
const asyncHandler = require('../helpers/async-handler');
const ctrl         = require('../controllers/forest-classification.controller');
const gtCtrl       = require('../controllers/forest-gt.controller');
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

// ── Ground truth ─────────────────────────────────────────────────────────────
// Quyền `forest_classification.ground_truth` (migration 033).
const gt = (h) => [verifyToken, requirePermission('forest_classification', 'ground_truth'), asyncHandler(h)];

// Zones (polygon labels)
router.post  ('/ground-truth/zones',       ...gt(gtCtrl.createZone));
router.post  ('/ground-truth/zones/bulk',  ...gt(gtCtrl.bulkZone));
router.get   ('/ground-truth/zones',       ...gt(gtCtrl.listZones));
router.delete('/ground-truth/zones/:id',   ...gt(gtCtrl.deleteZone));

// Points (single field samples)
router.post  ('/ground-truth/points',      ...gt(gtCtrl.createPoint));
router.post  ('/ground-truth/points/bulk', ...gt(gtCtrl.bulkPoint));
router.get   ('/ground-truth/points',      ...gt(gtCtrl.listPoints));
router.delete('/ground-truth/points/:id',  ...gt(gtCtrl.deletePoint));

module.exports = router;
