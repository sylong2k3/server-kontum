'use strict';

const db = require('../configs/database');

const exec = (client) => (text, params) => client ? client.query(text, params) : db.query(text, params);

const findGroupByCode = async (code, client = null) => {
    const { rows } = await exec(client)(
        `SELECT * FROM gis.layer_series_groups WHERE code = $1`,
        [code]
    );
    return rows[0] || null;
};

const listGroups = async ({ includePrivate = false } = {}) => {
    const { rows } = await db.query(
        `SELECT g.*,
                COUNT(s.id)::int AS step_count,
                MIN(s.year_from)::int AS min_year,
                MAX(s.year_to)::int AS max_year
         FROM gis.layer_series_groups g
         LEFT JOIN gis.layer_series_granules s ON s.group_id = g.id
         WHERE g.is_active = true AND ($1::boolean = true OR g.is_public = true)
         GROUP BY g.id
         ORDER BY g.code`,
        [includePrivate]
    );
    return rows;
};

const listGranules = async (groupId) => {
    const { rows } = await db.query(
        `SELECT * FROM gis.layer_series_granules
         WHERE group_id = $1
         ORDER BY year_to ASC, year_from ASC, id ASC`,
        [groupId]
    );
    return rows;
};

const findGranule = async (groupId, yearFrom, yearTo, client = null) => {
    const { rows } = await exec(client)(
        `SELECT * FROM gis.layer_series_granules
         WHERE group_id = $1 AND year_from = $2 AND year_to = $3`,
        [groupId, yearFrom, yearTo]
    );
    return rows[0] || null;
};

const upsertGranule = async (client, payload) => {
    const { rows } = await exec(client)(
        `INSERT INTO gis.layer_series_granules (
            group_id, year_from, year_to, time_value, label, file_name,
            source_layer, source_url, created_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (group_id, year_from, year_to) DO UPDATE SET
            time_value = EXCLUDED.time_value,
            label = EXCLUDED.label,
            file_name = EXCLUDED.file_name,
            source_layer = COALESCE(EXCLUDED.source_layer, gis.layer_series_granules.source_layer),
            source_url = COALESCE(EXCLUDED.source_url, gis.layer_series_granules.source_url),
            updated_at = NOW()
         RETURNING *`,
        [
            payload.groupId, payload.yearFrom, payload.yearTo, payload.timeValue,
            payload.label, payload.fileName, payload.sourceLayer || null,
            payload.sourceUrl || null, payload.createdBy || null,
        ]
    );
    return rows[0];
};

module.exports = {
    findGranule,
    findGroupByCode,
    listGranules,
    listGroups,
    upsertGranule,
};
