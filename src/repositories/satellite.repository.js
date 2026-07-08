'use strict';

const db = require('../configs/database');

const DEFAULT_TTL_MS = parseInt(process.env.SATELLITE_CACHE_TTL_MS, 10) || 6 * 60 * 60 * 1000;

// ── Read ──────────────────────────────────────────────────────────────────────

const getByHash = async (hash) => {
    const { rows } = await db.query(
        `SELECT * FROM satellite.image_results
         WHERE request_hash = $1 AND expires_at > NOW()
         LIMIT 1`,
        [hash],
    );
    return rows[0] || null;
};

const getById = async (id) => {
    const { rows } = await db.query(
        'SELECT * FROM satellite.image_results WHERE id = $1',
        [id],
    );
    return rows[0] || null;
};

const listExporting = async () => {
    const { rows } = await db.query(
        `SELECT * FROM satellite.image_results
         WHERE status = 'exporting' AND gee_task_id IS NOT NULL
         ORDER BY created_at`,
    );
    return rows;
};

// ── Write ─────────────────────────────────────────────────────────────────────

const upsert = async ({
    request_hash,
    image_type,
    collection   = null,
    start_date,
    end_date,
    start_date2  = null,
    end_date2    = null,
    bbox         = null,
    geometry     = null,
    tile_url,
    map_id       = null,
    stats        = null,
    legend       = null,
    metadata     = null,
    ttl_ms       = DEFAULT_TTL_MS,
}) => {
    const expiresAt = new Date(Date.now() + ttl_ms);
    const { rows } = await db.query(
        `INSERT INTO satellite.image_results
            (request_hash, image_type, collection, start_date, end_date,
             start_date2, end_date2, bbox, geometry, tile_url, map_id,
             stats, legend, metadata, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (request_hash) DO UPDATE SET
            tile_url   = EXCLUDED.tile_url,
            map_id     = EXCLUDED.map_id,
            stats      = EXCLUDED.stats,
            legend     = EXCLUDED.legend,
            metadata   = EXCLUDED.metadata,
            expires_at = EXCLUDED.expires_at
         RETURNING *`,
        [
            request_hash, image_type, collection, start_date, end_date,
            start_date2, end_date2,
            bbox     ? JSON.stringify(bbox)     : null,
            geometry ? JSON.stringify(geometry) : null,
            tile_url, map_id,
            stats    ? JSON.stringify(stats)    : null,
            legend   ? JSON.stringify(legend)   : null,
            metadata ? JSON.stringify(metadata) : null,
            expiresAt,
        ],
    );
    return rows[0];
};

/**
 * Update GeoServer publish state for a result.
 */
const updatePublish = async (id, { status, gee_task_id, minio_key, geoserver_layer, geoserver_store, publish_error }) => {
    const sets = ['status = $2'];
    const vals = [id, status];
    let idx = 3;

    const add = (col, val) => {
        if (val !== undefined) { sets.push(`${col} = $${idx++}`); vals.push(val ?? null); }
    };
    add('gee_task_id',     gee_task_id);
    add('minio_key',       minio_key);
    add('geoserver_layer', geoserver_layer);
    add('geoserver_store', geoserver_store);
    add('publish_error',   publish_error);

    const { rows } = await db.query(
        `UPDATE satellite.image_results SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
        vals,
    );
    return rows[0] || null;
};

const deleteExpired = async () => {
    const { rowCount } = await db.query(
        `DELETE FROM satellite.image_results
         WHERE expires_at < NOW() AND status NOT IN ('published')`,
    );
    return rowCount;
};

module.exports = { getByHash, getById, listExporting, upsert, updatePublish, deleteExpired };
