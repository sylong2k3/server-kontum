'use strict';

const Joi = require('joi');

const bboxSchema = Joi.string()
    .trim()
    .pattern(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?$/);

const scopeSchema = Joi.object({
    read:         Joi.boolean().default(true),
    rate_per_min: Joi.number().integer().min(1).max(6000).default(60),
    bbox_limit:   Joi.number().positive().max(360).optional(), // diện tích bbox tối đa (độ vuông)
}).default({ read: true, rate_per_min: 60 });

const createKeySchema = Joi.object({
    name:       Joi.string().trim().min(3).max(150).required(),
    layer_id:   Joi.number().integer().positive().required(),
    scope:      scopeSchema,
    is_active:  Joi.boolean().default(true),
    expires_at: Joi.date().iso().greater('now').optional().allow(null),
});

const updateKeySchema = Joi.object({
    name:       Joi.string().trim().min(3).max(150).optional(),
    scope:      Joi.object({
        read:         Joi.boolean(),
        rate_per_min: Joi.number().integer().min(1).max(6000),
        bbox_limit:   Joi.number().positive().max(360),
    }).optional(),
    is_active:  Joi.boolean().optional(),
    expires_at: Joi.date().iso().optional().allow(null),
}).min(1);

const listKeysSchema = Joi.object({
    page:      Joi.number().integer().min(1).default(1),
    limit:     Joi.number().integer().min(1).max(100).default(20),
    q:         Joi.string().trim().max(255).optional().allow(''),
    layer_id:  Joi.number().integer().positive().optional(),
    is_active: Joi.boolean().optional(),
});

const idParamsSchema = Joi.object({
    id: Joi.number().integer().positive().required(),
});

const featuresQuerySchema = Joi.object({
    bbox:   bboxSchema.optional(),
    limit:  Joi.number().integer().min(1).max(5000).default(500),
    offset: Joi.number().integer().min(0).default(0),
});

module.exports = {
    createKeySchema,
    updateKeySchema,
    listKeysSchema,
    idParamsSchema,
    featuresQuerySchema,
};
