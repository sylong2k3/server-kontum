'use strict';

const db = require('../configs/database');

const listSourceLayers = async ({ sourceGroups, includePrivate = false }) => {
    const { rows } = await db.query(
        `SELECT id, code, name_vi, name_en, geoserver_layer, default_style,
                data_year, layer_group
         FROM gis.layer_registry
         WHERE geometry_type = 'RASTER'
           AND geoserver_layer IS NOT NULL
           AND deleted_at IS NULL
           AND layer_group = ANY($1::text[])
           AND is_active = true
           AND ($2::boolean = true OR is_public = true)
         ORDER BY data_year ASC NULLS LAST, code ASC`,
        [sourceGroups, includePrivate]
    );
    return rows;
};

module.exports = { listSourceLayers };
