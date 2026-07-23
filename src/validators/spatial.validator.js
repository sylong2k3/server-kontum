'use strict';

const Joi = require('joi');

const residentialDistanceQuerySchema = Joi.object({
    residential_code: Joi.string().trim().max(60).required(),
    forest_code:      Joi.string().trim().max(60).required(),
    threshold_m:      Joi.number().min(1).max(50000).optional(),
    limit:            Joi.number().integer().min(1).max(5000).optional(),
});

module.exports = {
    residentialDistanceQuerySchema,
};
