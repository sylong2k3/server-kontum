'use strict';

const Joi = require('joi');

const FOREST_TYPES = ['total', 'natural', 'planted'];

const forestChangeQuerySchema = Joi.object({
    from_year:   Joi.number().integer().min(2000).max(2100).required(),
    to_year:     Joi.number().integer().min(2000).max(2100).required(),
    forest_type: Joi.string().valid(...FOREST_TYPES).optional(),
    unit_code:   Joi.string().trim().max(10).optional(),
});

const residentialDistanceQuerySchema = Joi.object({
    residential_code: Joi.string().trim().max(60).required(),
    forest_code:      Joi.string().trim().max(60).required(),
    threshold_m:      Joi.number().min(1).max(50000).optional(),
    limit:            Joi.number().integer().min(1).max(5000).optional(),
});

module.exports = {
    forestChangeQuerySchema,
    residentialDistanceQuerySchema,
};
