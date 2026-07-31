'use strict';

const Joi = require('joi');

const identifier = Joi.string().pattern(/^[a-zA-Z_][a-zA-Z0-9_]*$/);
const code = Joi.string().pattern(/^[a-zA-Z0-9_-]+$/).min(2).max(60);
const geometryType = Joi.string().valid(
    'POINT', 'MULTIPOINT', 'LINESTRING', 'MULTILINESTRING',
    'POLYGON', 'MULTIPOLYGON', 'GEOMETRY', 'RASTER'
);

const layerKind = Joi.string().valid('basemap', 'overlay');

const listLayersQuery = Joi.object({
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(200).default(100),
    q: Joi.string().allow('', null),
    category: Joi.string().allow('', null),
    layer_kind: layerKind.allow('', null),
    layer_group: Joi.string().max(80).allow('', null),
    data_year: Joi.number().integer().min(1900).max(2100),
    is_active: Joi.boolean(),
    is_public: Joi.boolean(),
    publish_data: Joi.boolean(),
});

const createLayer = Joi.object({
    code: code.required(),
    name_vi: Joi.string().min(1).max(200).required(),
    name_en: Joi.string().max(200).allow('', null),
    description_vi: Joi.string().allow('', null),
    description_en: Joi.string().allow('', null),
    schema_name: identifier.default('gis'),
    table_name: identifier.max(120).required(),
    geometry_column: identifier.max(60).default('geom'),
    geometry_type: geometryType.required(),
    epsg_code: Joi.number().integer().min(1).default(4326),
    geoserver_layer: Joi.string().max(255).allow('', null),
    geoserver_store: Joi.string().max(120).allow('', null),
    source_url: Joi.string().allow('', null),
    default_style: Joi.object().default({}),
    min_zoom: Joi.number().integer().min(0).max(24).default(1),
    max_zoom: Joi.number().integer().min(0).max(24).default(22),
    label_field: Joi.string().max(60).allow('', null),
    category: Joi.string().max(60).allow('', null),
    layer_kind: layerKind.default('overlay'),
    layer_group: Joi.string().max(80).allow('', null),
    data_year: Joi.number().integer().min(1900).max(2100).allow(null),
    source_dataset: Joi.string().max(120).allow('', null),
    source_layer_name: Joi.string().max(160).allow('', null),
    sort_order: Joi.number().integer().default(0),
    is_active: Joi.boolean().default(true),
    is_public: Joi.boolean().default(false),
    is_editable: Joi.boolean().default(true),
    layer_permissions: Joi.object().default({}),
}).custom((value, helpers) => {
    if (value.min_zoom > value.max_zoom) { return helpers.error('any.invalid'); }
    return value;
});

const updateLayer = Joi.object({
    name_vi:           Joi.string().min(1).max(200),
    name_en:           Joi.string().max(200).allow('', null),
    description_vi:    Joi.string().allow('', null),
    description_en:    Joi.string().allow('', null),
    schema_name:       identifier,
    table_name:        identifier.max(120),
    geometry_column:   identifier.max(60),
    geometry_type:     geometryType,
    epsg_code:         Joi.number().integer().min(1),
    geoserver_layer:   Joi.string().max(255).allow('', null),
    geoserver_store:   Joi.string().max(120).allow('', null),
    source_url:        Joi.string().allow('', null),
    default_style:     Joi.object(),
    min_zoom:          Joi.number().integer().min(0).max(24),
    max_zoom:          Joi.number().integer().min(0).max(24),
    label_field:       Joi.string().max(60).allow('', null),
    category:          Joi.string().max(60).allow('', null),
    layer_kind:        layerKind,
    layer_group:       Joi.string().max(80).allow('', null),
    data_year:         Joi.number().integer().min(1900).max(2100).allow(null),
    source_dataset:    Joi.string().max(120).allow('', null),
    source_layer_name: Joi.string().max(160).allow('', null),
    sort_order:        Joi.number().integer(),
    is_active:         Joi.boolean(),
    is_public:         Joi.boolean(),
    is_editable:       Joi.boolean(),
    layer_permissions: Joi.object(),
    // Optimistic locking (optional): nếu client gửi, backend chỉ update khi updated_at khớp.
    expectedUpdatedAt: Joi.date().iso(),
}).min(1);

const activeLayer = Joi.object({ is_active: Joi.boolean().required() });

const listFeaturesQuery = Joi.object({
    limit: Joi.number().integer().min(1).max(5000).default(1000),
    offset: Joi.number().integer().min(0).default(0),
    bbox: Joi.string().allow('', null),
});

const featurePayload = Joi.object({
    geometry: Joi.object({ type: Joi.string().required() }).unknown(true).allow(null),
    properties: Joi.object().default({}),
});

const featureInfoQuery = Joi.object({
    id: Joi.alternatives().try(Joi.number().integer(), Joi.string().max(120)),
    lng: Joi.number().min(-180).max(180),
    lat: Joi.number().min(-90).max(90),
    tolerance_meters: Joi.number().min(0).max(100000).default(10),
}).custom((value, helpers) => {
    if (value.id !== undefined) { return value; }
    if (value.lng !== undefined && value.lat !== undefined) { return value; }
    return helpers.error('any.required');
});

const importPayload = Joi.object({
    source_format: Joi.string().valid('geojson', 'csv', 'filegdb').required(),
    import_mode: Joi.string().valid('append', 'overwrite').default('append'),
    srid_input: Joi.number().integer().min(1).default(4326),
    encoding: Joi.string().max(20).default('UTF-8'),
    auto_publish: Joi.boolean().default(false),
    geojson: Joi.object(),
    csv: Joi.array().items(Joi.object()),
    geometry_field: Joi.string().default('geometry'),
    lng_field: Joi.string().default('lng'),
    lat_field: Joi.string().default('lat'),
});

module.exports = {
    activeLayer,
    createLayer,
    featureInfoQuery,
    featurePayload,
    importPayload,
    listFeaturesQuery,
    listLayersQuery,
    updateLayer,
};

