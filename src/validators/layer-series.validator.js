'use strict';

const Joi = require('joi');

const groupCode = Joi.string().pattern(/^[a-zA-Z_][a-zA-Z0-9_]*$/).max(80);
const year = Joi.number().integer().min(1900).max(2100);

const groupParams = Joi.object({ group: groupCode.required() });

const ingestGranule = Joi.object({
    year_from: year.required(),
    year_to: year.optional(),
    label: Joi.string().trim().max(120).allow('', null),
    source_layer: Joi.string().trim().max(255).allow('', null),
    source_url: Joi.string().trim().max(4000).allow('', null),
    force: Joi.boolean().default(false),
}).custom((value, helpers) => {
    value.year_to = value.year_to ?? value.year_from;
    if (value.year_to < value.year_from) { return helpers.error('any.invalid'); }
    return value;
});

module.exports = { groupParams, ingestGranule };
