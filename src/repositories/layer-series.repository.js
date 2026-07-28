'use strict';

/**
 * Layer Series Repository — chỉ chứa SQL cho nhóm layer time-series
 * (gis.layer_registry WHERE layer_kind = 'timeseries' + gis.layer_series_granule).
 */

const db = require('../configs/database');

const exec = (client) => (text, params) => (client ? client.query(text, params) : db.query(text, params));

const findGroupByCode = async (code, client = null) => {
    const { rows } = await exec(client)(
        `SELECT * FROM gis.layer_registry WHERE code = $1 AND layer_kind = 'timeseries' AND deleted_at IS NULL`,
        [code]
    );
    return rows[0] || null;
};

const listGroups = async () => {
    const { rows } = await db.query(
        `SELECT * FROM gis.layer_registry
         WHERE layer_kind = 'timeseries' AND deleted_at IS NULL
         ORDER BY sort_order ASC, name_vi ASC`
    );
    return rows;
};

const setMosaicPublished = async (client, { layerId, mosaicPath, geoserverLayer, geoserverStore }) => {
    const { rows } = await exec(client)(
        `UPDATE gis.layer_registry
         SET mosaic_path = $2, geoserver_layer = $3, geoserver_store = $4,
             last_updated_at = NOW(), updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [layerId, mosaicPath, geoserverLayer, geoserverStore]
    );
    return rows[0] || null;
};

const touchLastUpdated = async (layerId) => {
    await db.query(`UPDATE gis.layer_registry SET last_updated_at = NOW() WHERE id = $1`, [layerId]);
};

const upsertGranule = async (client, {
    layerId, yearFrom, yearTo, timeValue, labelVi, labelEn, filePath, fileSha256, ingestedBy,
}) => {
    const { rows } = await exec(client)(
        `INSERT INTO gis.layer_series_granule (
            layer_id, year_from, year_to, time_value, label_vi, label_en,
            file_path, file_sha256, ingested_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (layer_id, year_from, year_to) DO UPDATE SET
            time_value  = EXCLUDED.time_value,
            label_vi    = EXCLUDED.label_vi,
            label_en    = COALESCE(EXCLUDED.label_en, gis.layer_series_granule.label_en),
            file_path   = EXCLUDED.file_path,
            file_sha256 = EXCLUDED.file_sha256,
            ingested_by = EXCLUDED.ingested_by,
            is_active   = true,
            updated_at  = NOW()
        RETURNING id, layer_id, year_from, year_to, to_char(time_value, 'YYYY-MM-DD') AS time_value,
                  label_vi, label_en, file_path, file_sha256, is_active, ingested_by, created_at, updated_at`,
        [layerId, yearFrom, yearTo, timeValue, labelVi, labelEn || null, filePath || null, fileSha256 || null, ingestedBy || null]
    );
    return rows[0];
};

// time_value là cột DATE — node-postgres parse thành JS Date theo giờ LOCAL
// của process, nên .toISOString()/JSON.stringify() có thể lùi 1 ngày khi
// TZ server lệch UTC (VD Indochina +7). Ép về text 'YYYY-MM-DD' ngay ở SQL
// để tránh phụ thuộc TZ khi trả JSON cho client.
const listGranules = async (layerId) => {
    const { rows } = await db.query(
        `SELECT id, layer_id, year_from, year_to, to_char(time_value, 'YYYY-MM-DD') AS time_value,
                label_vi, label_en, file_path, file_sha256, is_active, ingested_by, created_at, updated_at
         FROM gis.layer_series_granule
         WHERE layer_id = $1 AND is_active = true
         ORDER BY time_value ASC`,
        [layerId]
    );
    return rows;
};

module.exports = {
    findGroupByCode, listGroups, setMosaicPublished, touchLastUpdated, upsertGranule, listGranules,
};
