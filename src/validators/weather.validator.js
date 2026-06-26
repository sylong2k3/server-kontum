'use strict';

const Joi = require('joi');
const { WEATHER_TYPES } = require('../configs/weather');

// Bbox dạng "minLng,minLat,maxLng,maxLat".
const bboxSchema = Joi.string()
    .trim()
    .pattern(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?$/);

const layersQuerySchema = Joi.object({
    type: Joi.string().valid(...WEATHER_TYPES).optional(),
});

const pointQuerySchema = Joi.object({
    lng: Joi.number().min(106).max(109).required(),
    lat: Joi.number().min(13).max(16.5).required(),
});

const windGridQuerySchema = Joi.object({
    bbox: bboxSchema.optional(),
    grid: Joi.number().integer().min(2).max(16).optional(),
});

const tileParamsSchema = Joi.object({
    type: Joi.string().valid(...WEATHER_TYPES).required(),
    z:    Joi.number().integer().min(0).max(20).required(),
    x:    Joi.number().integer().min(0).required(),
    // y có thể kèm đuôi ".png" — chấp nhận chuỗi, controller sẽ bóc phần số.
    y:    Joi.string().pattern(/^\d+(\.png)?$/).required(),
});

module.exports = {
    layersQuerySchema,
    pointQuerySchema,
    windGridQuerySchema,
    tileParamsSchema,
};
