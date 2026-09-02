'use strict';

const Joi = require('joi');

const code = Joi.string().pattern(/^[a-zA-Z0-9_-]+$/).min(2).max(60);
const identifier = Joi.string().pattern(/^[a-zA-Z_][a-zA-Z0-9_]*$/);

const geoImportPayload = Joi.object({
    code:              code.required(),
    name_vi:           Joi.string().min(1).max(200),
    name_en:           Joi.string().max(200).allow('', null),
    description_vi:    Joi.string().allow('', null),
    table_name:        identifier.max(120),
    // GeoTIFF không import qua đây — upload vào kho viễn thám rồi dùng
    // POST /remote-sensing/images/:id/publish để đưa lên GeoServer
    source_format:     Joi.string().valid('shapefile', 'geojson', 'kml', 'filegdb').required(),
    import_mode:       Joi.string().valid('append', 'overwrite').default('overwrite'),
    srid_input:        Joi.number().integer().min(1).default(4326),
    source_layer_name: Joi.string().max(160).allow('', null),
    category:          Joi.string().max(60).allow('', null),
    layer_kind:        Joi.string().valid('basemap', 'overlay').default('overlay'),
    layer_group:       Joi.string().max(80).allow('', null),
    data_year:         Joi.number().integer().min(1900).max(2100).allow(null),
    is_public:         Joi.boolean().default(false),
    auto_publish:      Joi.boolean().default(true),
    epsg_code:         Joi.number().integer().min(1).default(4326),
    min_zoom:          Joi.number().integer().min(0).max(24).default(1),
    max_zoom:          Joi.number().integer().min(0).max(24).default(22),
    label_field:       Joi.string().max(60).allow('', null),
    source_dataset:    Joi.string().max(120).allow('', null),
});

module.exports = { geoImportPayload };
