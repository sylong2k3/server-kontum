'use strict';

const Joi = require('joi');

const FOREST_TYPES = ['total', 'natural', 'planted', 'non_forest'];
const LEVELS = ['province', 'district', 'commune'];

const unitsQuerySchema = Joi.object({
    level: Joi.string().valid(...LEVELS).optional(),
});

const landcoverQuerySchema = Joi.object({
    year:        Joi.number().integer().min(2000).max(2100).optional(),
    forest_type: Joi.string().valid(...FOREST_TYPES).optional(),
    // chấp nhận by=district cho tương thích spec (chỉ district được hỗ trợ hiện tại)
    by:          Joi.string().valid('district').optional(),
    from:        Joi.number().integer().min(2000).max(2100).optional(),
    to:          Joi.number().integer().min(2000).max(2100).optional(),
});

const dashboardQuerySchema = Joi.object({
    force: Joi.string().valid('true', 'false').optional(),
});

module.exports = {
    unitsQuerySchema,
    landcoverQuerySchema,
    dashboardQuerySchema,
};
