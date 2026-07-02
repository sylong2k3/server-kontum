const Joi = require('joi');

const createFieldUpdateSchema = Joi.object({
    layerCode: Joi.string().trim().max(60).required(),
    featureId: Joi.number().integer().positive().optional().allow(null),
    lng: Joi.number().min(106).max(109).required(),
    lat: Joi.number().min(13).max(16.5).required(),
    attributes: Joi.object().pattern(Joi.string(), Joi.any()).default({}),
    clientUuid: Joi.string().trim().max(80).optional().allow('', null),
    note: Joi.string().trim().max(1000).optional().allow('', null),
});

const syncQuerySchema = Joi.object({
    since: Joi.date().iso().optional(),
});

module.exports = { createFieldUpdateSchema, syncQuerySchema };
