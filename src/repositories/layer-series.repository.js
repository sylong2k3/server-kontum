'use strict';

const db = require('../configs/database');

const listGroups = async ({ includePrivate = false }) => {
    const { rows } = await db.query(
        `SELECT id, code, name_vi, name_en, geoserver_store, geoserver_layer,
                geoserver_style, is_active, is_public, created_at, updated_at
         FROM gis.layer_series_groups
         WHERE ($1::boolean = true OR (is_active = true AND is_public = true))
         ORDER BY name_vi ASC, code ASC`,
        [includePrivate]
    );
    return rows;
};

const findGroupByCode = async (code, client = db) => {
    const { rows } = await client.query(
        `SELECT id, code, name_vi, name_en, geoserver_store, geoserver_layer,
                geoserver_style, is_active, is_public, created_at, updated_at
         FROM gis.layer_series_groups
         WHERE code = $1`,
        [code]
    );
    return rows[0] || null;
};

const createGroup = async (payload) => {
    const { rows } = await db.query(
        `INSERT INTO gis.layer_series_groups
            (code, name_vi, name_en, geoserver_store, geoserver_layer,
             geoserver_style, is_active, is_public)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
            payload.code, payload.name_vi, payload.name_en || null,
            payload.geoserver_store, payload.geoserver_layer,
            payload.geoserver_style || null,
            payload.is_active ?? true, payload.is_public ?? true,
        ]
    );
    return rows[0];
};

const updateGroup = async (code, payload) => {
    const allowed = [
        'name_vi', 'name_en', 'geoserver_store', 'geoserver_layer',
        'geoserver_style', 'is_active', 'is_public',
    ];
    const sets = [];
    const values = [];
    for (const field of allowed) {
        if (payload[field] !== undefined) {
            values.push(payload[field] === '' ? null : payload[field]);
            sets.push(`${field} = $${values.length}`);
        }
    }
    if (!sets.length) return findGroupByCode(code);
    values.push(code);
    const { rows } = await db.query(
        `UPDATE gis.layer_series_groups
         SET ${sets.join(', ')}
         WHERE code = $${values.length}
         RETURNING *`,
        values
    );
    return rows[0] || null;
};

const deleteGroup = async (code) => {
    const { rows } = await db.query(
        'DELETE FROM gis.layer_series_groups WHERE code = $1 RETURNING *',
        [code]
    );
    return rows[0] || null;
};

// Tìm 1 layer con raster đầu tiên của nhóm — dùng để suy ra geoserver_store /
// geoserver_layer template khi admin tạo nhóm không điền các field kỹ thuật.
const findFirstSourceLayer = async (groupCode) => {
    const { rows } = await db.query(
        `SELECT geoserver_store, geoserver_layer
         FROM gis.layer_registry
         WHERE layer_group = $1
           AND geometry_type = 'RASTER'
           AND geoserver_layer IS NOT NULL
           AND deleted_at IS NULL
         ORDER BY data_year ASC NULLS LAST, code ASC
         LIMIT 1`,
        [groupCode]
    );
    return rows[0] || null;
};

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

module.exports = {
    createGroup,
    deleteGroup,
    findFirstSourceLayer,
    findGroupByCode,
    listGroups,
    listSourceLayers,
    updateGroup,
};
