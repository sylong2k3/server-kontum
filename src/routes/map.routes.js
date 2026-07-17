'use strict';

const { Router } = require('express');
const asyncHandler = require('../helpers/async-handler');
const mapController = require('../controllers/map.controller');
const rasterIngestController = require('../controllers/raster-ingest.controller');
const { uploadGeoFile } = require('../middlewares/uploadGeoFile.middleware');
const { verifyToken, optionalAuth, requirePermission } = require('../middlewares/auth.middleware');

const router = Router();

router.get('/layers', optionalAuth, asyncHandler(mapController.listLayers));
router.get('/layers/:code', optionalAuth, asyncHandler(mapController.getLayer));
router.post('/layers', verifyToken, requirePermission('map_layers', 'create'), asyncHandler(mapController.createLayer));
router.patch('/layers/:code', verifyToken, requirePermission('map_layers', 'update'), asyncHandler(mapController.updateLayer));
router.delete('/layers/:code', verifyToken, requirePermission('map_layers', 'delete'), asyncHandler(mapController.deleteLayer));

router.post('/layers/:code/publish', verifyToken, requirePermission('map_layers', 'publish'), asyncHandler(mapController.publishLayer));
router.delete('/layers/:code/publish', verifyToken, requirePermission('map_layers', 'unpublish'), asyncHandler(mapController.unpublishLayer));
router.patch('/layers/:code/active', verifyToken, requirePermission('map_layers', 'update'), asyncHandler(mapController.setLayerActive));
router.post('/layers/import-file', verifyToken, requirePermission('map_layers', 'import'), uploadGeoFile, asyncHandler(mapController.importGeoFile));
router.get('/layers/:code/import-jobs', verifyToken, requirePermission('map_layers', 'import'), asyncHandler(mapController.listImportJobs));
router.get('/import-jobs/:jobId', verifyToken, requirePermission('map_layers', 'import'), asyncHandler(mapController.getImportJob));

router.post('/rasters/:coverageStore/harvest', verifyToken, requirePermission('map_layers', 'harvest'), asyncHandler(mapController.harvestRaster));

// ── GEE Raster Ingest pipeline (migration 031) ──────────────────────────────
router.post('/rasters/ingest-gee',
    verifyToken, requirePermission('map_layers', 'ingest_raster'),
    asyncHandler(rasterIngestController.enqueueGeeIngest));
router.get('/rasters/ingest-jobs/:id',
    verifyToken, requirePermission('map_layers', 'ingest_raster'),
    asyncHandler(rasterIngestController.getIngestJob));
router.get('/layers/:code/ingest-jobs',
    verifyToken, requirePermission('map_layers', 'ingest_raster'),
    asyncHandler(rasterIngestController.listIngestJobsByLayer));

module.exports = router;

