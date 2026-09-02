'use strict';

const Joi = require('joi');

const layerCode = Joi.string().pattern(/^[a-z][a-z0-9_-]{1,58}$/i).required();

// GEE download URL: https://earthengine.googleapis.com/v1alpha/... hoặc
// generic https URL — dài, có query token nên giới hạn 4000.
const sourceUrl = Joi.string().uri({ scheme: ['http', 'https'] }).max(4000).required();

const enqueueGeeIngest = Joi.object({
    source_url:  sourceUrl,
    layer_code:  layerCode,
    name_vi:     Joi.string().max(200).allow('', null),
    name_en:     Joi.string().max(200).allow('', null),
    is_public:   Joi.boolean().default(false),
    category:    Joi.string().max(60).default('remote_sensing'),

    // Optional GEE-side metadata cho auditing (mapId/taskId từ satellite response).
    gee_map_id:  Joi.string().max(200).allow('', null),
    gee_task_id: Joi.string().max(200).allow('', null),
    // Bbox override — mặc định pipeline dùng Kon Tum province.
    bbox:        Joi.array().items(Joi.number()).length(4).optional(),
    epsg_code:   Joi.number().integer().min(1).max(999999).default(4326),
    scale_m:     Joi.number().min(10).max(10000).default(100),
    data_year:   Joi.number().integer().min(1900).max(2100).optional(),
    layer_group: Joi.string().max(80).allow('', null),
});

module.exports = { enqueueGeeIngest };
