const Joi = require('joi');

const measurementStatuses = ['draft', 'submitted', 'verified', 'rejected'];

const idParamsSchema = Joi.object({
    id: Joi.number().integer().positive().required(),
});

const pointSchema = Joi.object({
    lng: Joi.number().min(106).max(109).required(),
    lat: Joi.number().min(13).max(16.5).required(),
    accuracy_m: Joi.number().min(0).max(9999).optional().allow(null),
    recorded_at: Joi.date().iso().optional(),
});

const createMeasurementSchema = Joi.object({
    points: Joi.array().items(pointSchema).min(3).required(),
    areaId: Joi.number().integer().positive().optional().allow(null),
    layerCode: Joi.string().trim().max(60).optional().allow('', null),
    landUseField: Joi.string().trim().pattern(/^[a-zA-Z_][a-zA-Z0-9_]*$/).max(60).optional().allow('', null),
    oldLandUse: Joi.string().trim().max(100).optional().allow('', null),
    newLandUse: Joi.string().trim().max(100).optional().allow('', null),
    note: Joi.string().trim().max(2000).optional().allow('', null),
    deviceInfo: Joi.object().optional(),
    startedAt: Joi.date().iso().optional().allow(null),
    finishedAt: Joi.date().iso().optional().allow(null),
    clientUuid: Joi.string().trim().guid({ version: 'uuidv4' }).optional().allow('', null),
});

const updateMeasurementSchema = Joi.object({
    areaId: Joi.number().integer().positive().optional().allow(null),
    oldLandUse: Joi.string().trim().max(100).optional().allow('', null),
    newLandUse: Joi.string().trim().max(100).optional().allow('', null),
    note: Joi.string().trim().max(2000).optional().allow('', null),
});

const listMeasurementsSchema = Joi.object({
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(100).default(20),
    status: Joi.string().valid(...measurementStatuses).optional(),
    commune_code: Joi.string().trim().max(20).optional(),
    area_id: Joi.number().integer().positive().optional(),
    from: Joi.date().iso().optional(),
    to: Joi.date().iso().min(Joi.ref('from')).optional(),
});

const rejectMeasurementSchema = Joi.object({
    reviewNote: Joi.string().trim().min(3).max(1000).required(),
});

const exportMeasurementsSchema = Joi.object({
    format: Joi.string().valid('geojson', 'xlsx').default('geojson'),
    commune_code: Joi.string().trim().max(20).optional(),
    from: Joi.date().iso().optional(),
    to: Joi.date().iso().min(Joi.ref('from')).optional(),
});

const geoJsonPolygonSchema = Joi.object({
    type: Joi.string().valid('Polygon').required(),
    coordinates: Joi.array().items(Joi.array().items(Joi.array().items(Joi.number()).length(2)).min(4)).length(1).required(),
});

const createAreaSchema = Joi.object({
    name: Joi.string().trim().max(200).optional().allow('', null),
    geom: geoJsonPolygonSchema.required(),
    communeCode: Joi.string().trim().max(20).optional().allow('', null),
    note: Joi.string().trim().max(2000).optional().allow('', null),
});

const listAreasSchema = Joi.object({
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(100).default(20),
    commune_code: Joi.string().trim().max(20).optional(),
});

const suggestByPointSchema = Joi.object({
    lng: Joi.number().min(106).max(109).required(),
    lat: Joi.number().min(13).max(16.5).required(),
    radius_m: Joi.number().min(1).max(5000).default(50),
});

const suggestByGeomSchema = Joi.object({
    geom: Joi.string().trim().required(), // GeoJSON polygon serialized as query string
});

module.exports = {
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
};
