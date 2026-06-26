'use strict';

const { Router } = require('express');
const asyncHandler = require('../helpers/async-handler');
const mapController = require('../controllers/map.controller');
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

router.get('/layers/:code/features', optionalAuth, asyncHandler(mapController.listFeatures));
router.get('/layers/:code/feature-info', optionalAuth, asyncHandler(mapController.getFeatureInfo));
router.get('/layers/:code/features/:featureId', optionalAuth, asyncHandler(mapController.getFeature));
router.post('/layers/:code/features', verifyToken, requirePermission('map_layers', 'feature_create'), asyncHandler(mapController.createFeature));
router.patch('/layers/:code/features/:featureId', verifyToken, requirePermission('map_layers', 'feature_update'), asyncHandler(mapController.updateFeature));
router.delete('/layers/:code/features/:featureId', verifyToken, requirePermission('map_layers', 'feature_delete'), asyncHandler(mapController.deleteFeature));

router.post('/layers/import-file', verifyToken, requirePermission('map_layers', 'import'), uploadGeoFile, asyncHandler(mapController.importGeoFile));
router.post('/layers/:code/import', verifyToken, requirePermission('map_layers', 'import'), asyncHandler(mapController.importFeatures));
router.get('/layers/:code/import-jobs', verifyToken, requirePermission('map_layers', 'import'), asyncHandler(mapController.listImportJobs));
router.get('/import-jobs/:jobId', verifyToken, requirePermission('map_layers', 'import'), asyncHandler(mapController.getImportJob));

router.post('/rasters/:coverageStore/harvest', verifyToken, requirePermission('map_layers', 'harvest'), asyncHandler(mapController.harvestRaster));

module.exports = router;

