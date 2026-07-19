'use strict';

const Joi = require('joi');

// GeoJSON geometry (Polygon/MultiPolygon)
const polygonGeom = Joi.object({
    type: Joi.string().valid('Polygon', 'MultiPolygon').required(),
    coordinates: Joi.array().required(),
}).unknown(true);

const zoneCreate = Joi.object({
    name:        Joi.string().max(200).allow('', null),
    occurredAt:  Joi.date().iso().required(),
    severity:    Joi.number().integer().min(1).max(5).default(3),
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
    occurredAt:   Joi.date().iso().required(),
    severity:     Joi.number().integer().min(1).max(5).default(3),
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
    severity: Joi.number().integer().min(1).max(5),
});

module.exports = { zoneCreate, featureCollection, pointCreate, pointBulk, listQuery };
