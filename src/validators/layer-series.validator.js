'use strict';

const Joi = require('joi');

const groupParams = Joi.object({
    group: Joi.string().pattern(/^[a-zA-Z_][a-zA-Z0-9_]*$/).max(80).required(),
});

module.exports = { groupParams };
