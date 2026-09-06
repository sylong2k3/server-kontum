'use strict';

const Joi = require('joi');

const polygonGeom = Joi.object({
    type: Joi.string().valid('Polygon', 'MultiPolygon').required(),
    coordinates: Joi.array().required(),
}).unknown(true);

// Schema v5.3: 0=no-data, 1-11=lớp phủ, 12=không xác định.
const classId = Joi.number().integer().min(0).max(12);

const zoneCreate = Joi.object({
    name:        Joi.string().max(200).allow('', null),
    observedAt:  Joi.date().iso().required(),
    classId:     classId.required(),
    source:      Joi.string().max(64).default('field_survey'),
    geom:        polygonGeom.required(),
    notes:       Joi.string().max(2000).allow('', null),
});

const featureCollection = Joi.object({
    type:     Joi.string().valid('FeatureCollection').required(),
    features: Joi.array().items(Joi.object({
        type: Joi.string().valid('Feature').required(),
        geometry: polygonGeom.required(),
        properties: Joi.object().unknown(true).default({}),
    })).min(1).required(),
});

const pointCreate = Joi.object({
    observedAt:   Joi.date().iso().required(),
    classId:      classId.required(),
    lng:          Joi.number().min(106).max(109).required(),
    lat:          Joi.number().min(13).max(16.5).required(),
    source:       Joi.string().max(64).default('field_report'),
    photoUrl:     Joi.string().uri().max(2000).allow('', null),
    reporterName: Joi.string().max(200).allow('', null),
    notes:        Joi.string().max(2000).allow('', null),
});

const pointBulk = Joi.object({
    points: Joi.array().items(pointCreate).min(1).max(1000).required(),
});

const listQuery = Joi.object({
    page:     Joi.number().integer().min(1).default(1),
    limit:    Joi.number().integer().min(1).max(200).default(50),
    from:     Joi.date().iso(),
    to:       Joi.date().iso(),
    classId:  classId,
});

// Bulk delete: cùng trần 1000 với bulk insert để giới hạn kích thước payload.
const idList = Joi.object({
    ids: Joi.array()
        .items(Joi.number().integer().positive().required())
        .min(1).max(1000).required(),
});

module.exports = { zoneCreate, featureCollection, pointCreate, pointBulk, listQuery, idList };
