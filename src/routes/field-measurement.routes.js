const { Router } = require('express');
const asyncHandler = require('../helpers/async-handler');
const controller = require('../controllers/field-measurement.controller');
const { verifyToken, enforcePasswordChange, requirePermission } = require('../middlewares/auth.middleware');
const { validate } = require('../middlewares/validate.middleware');
const { uploadFieldPhotos, handleUploadError } = require('../middlewares/upload.middleware');
const {
    idParamsSchema,
    createMeasurementSchema,
    updateMeasurementSchema,
    listMeasurementsSchema,
    rejectMeasurementSchema,
    exportMeasurementsSchema,
    createAreaSchema,
    listAreasSchema,
    suggestByPointSchema,
    suggestByGeomSchema,
} = require('../validators/field-measurement.validator');

const measurementRouter = Router();
const areaRouter = Router();

measurementRouter.use(verifyToken, enforcePasswordChange);

// ─── Phiên đo — mounted at /field-measurements ───────────────────────────────

measurementRouter.post(
    '/',
    requirePermission('field_measurements', 'create'),
    validate(createMeasurementSchema),
    asyncHandler(controller.createMeasurement)
);

measurementRouter.get(
    '/',
    requirePermission('field_measurements', 'read'),
    validate(listMeasurementsSchema, 'query'),
    asyncHandler(controller.listMeasurements)
);

// /export đặt trước /:id để không bị route param ":id" nuốt mất.
measurementRouter.get(
    '/export',
    requirePermission('field_measurements', 'export'),
    validate(exportMeasurementsSchema, 'query'),
    asyncHandler(controller.exportMeasurements)
);

measurementRouter.get(
    '/:id',
    requirePermission('field_measurements', 'read'),
    validate(idParamsSchema, 'params'),
    asyncHandler(controller.getMeasurementById)
);

measurementRouter.patch(
    '/:id',
    requirePermission('field_measurements', 'update'),
    validate(idParamsSchema, 'params'),
    validate(updateMeasurementSchema),
    asyncHandler(controller.updateMeasurement)
);

measurementRouter.delete(
    '/:id',
    requirePermission('field_measurements', 'delete'),
    validate(idParamsSchema, 'params'),
    asyncHandler(controller.deleteMeasurement)
);

measurementRouter.post(
    '/:id/photos',
    requirePermission('field_measurements', 'update'),
    validate(idParamsSchema, 'params'),
    uploadFieldPhotos.array('photos', Number(process.env.FIELD_MEASUREMENT_MAX_PHOTOS || 10)),
    handleUploadError,
    asyncHandler(controller.addPhotos)
);

measurementRouter.post(
    '/:id/submit',
    requirePermission('field_measurements', 'submit'),
    validate(idParamsSchema, 'params'),
    asyncHandler(controller.submitMeasurement)
);

measurementRouter.post(
    '/:id/verify',
    requirePermission('field_measurements', 'verify'),
    validate(idParamsSchema, 'params'),
    asyncHandler(controller.verifyMeasurement)
);

measurementRouter.post(
    '/:id/reject',
    requirePermission('field_measurements', 'verify'),
    validate(idParamsSchema, 'params'),
    validate(rejectMeasurementSchema),
    asyncHandler(controller.rejectMeasurement)
);

// ─── Khu vực theo dõi — mounted at /monitored-areas ──────────────────────────

areaRouter.use(verifyToken, enforcePasswordChange);

areaRouter.post(
    '/',
    requirePermission('field_measurements', 'create'),
    validate(createAreaSchema),
    asyncHandler(controller.createArea)
);

areaRouter.get(
    '/',
    requirePermission('field_measurements', 'read'),
    validate(listAreasSchema, 'query'),
    asyncHandler(controller.listAreas)
);

// Mốc 1 (§1.3.1): gợi ý theo điểm GPS — đặt trước "/:id" để không bị nuốt route.
areaRouter.get(
    '/suggest/by-point',
    requirePermission('field_measurements', 'read'),
    validate(suggestByPointSchema, 'query'),
    asyncHandler(controller.suggestAreasByPoint)
);

// Mốc 2 (§1.3.1): gợi ý theo polygon vừa đo.
areaRouter.get(
    '/suggest/by-geom',
    requirePermission('field_measurements', 'read'),
    validate(suggestByGeomSchema, 'query'),
    asyncHandler(controller.suggestAreasByGeom)
);

areaRouter.get(
    '/:id',
    requirePermission('field_measurements', 'read'),
    validate(idParamsSchema, 'params'),
    asyncHandler(controller.getAreaById)
);

module.exports = {
    measurementRouter,
    areaRouter,
};
