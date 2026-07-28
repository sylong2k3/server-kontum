'use strict';

const { Router } = require('express');
const asyncHandler = require('../helpers/async-handler');
const layerSeriesController = require('../controllers/layer-series.controller');
const { uploadSingleRaster, requireRasterFile } = require('../middlewares/uploadRaster.middleware');
const { optionalAuth, verifyToken, requirePermission } = require('../middlewares/auth.middleware');

const router = Router();

router.get('/', optionalAuth, asyncHandler(layerSeriesController.listGroups));
router.get('/:group/timesteps', optionalAuth, asyncHandler(layerSeriesController.listTimesteps));
router.post('/:group/granules',
    verifyToken, requirePermission('map_layers', 'ingest_raster'),
    uploadSingleRaster, requireRasterFile,
    asyncHandler(layerSeriesController.ingestGranule));

module.exports = router;
