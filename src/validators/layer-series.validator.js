'use strict';

const Joi = require('joi');

const groupParams = Joi.object({
    group: Joi.string().pattern(/^[a-zA-Z_][a-zA-Z0-9_]*$/).max(80).required(),
});

const code = Joi.string().pattern(/^[a-zA-Z_][a-zA-Z0-9_]*$/).max(80);
const store = Joi.string().pattern(/^[a-zA-Z_][a-zA-Z0-9_]*$/).max(120);
const layer = Joi.string().pattern(/^[a-zA-Z_][a-zA-Z0-9_:.-]*$/).max(255);

const createGroup = Joi.object({
    code: code.required(),
    name_vi: Joi.string().trim().max(200).required(),
    name_en: Joi.string().trim().max(200).allow('', null).optional(),
    geoserver_store: store.required(),
    geoserver_layer: layer.required(),
    geoserver_style: Joi.string().trim().max(160).allow('', null).optional(),
    is_active: Joi.boolean().optional(),
    is_public: Joi.boolean().optional(),
});

const updateGroup = Joi.object({
    name_vi: Joi.string().trim().max(200).optional(),
    name_en: Joi.string().trim().max(200).allow('', null).optional(),
    geoserver_store: store.optional(),
    geoserver_layer: layer.optional(),
    geoserver_style: Joi.string().trim().max(160).allow('', null).optional(),
    is_active: Joi.boolean().optional(),
    is_public: Joi.boolean().optional(),
}).min(1);

module.exports = { createGroup, groupParams, updateGroup };
