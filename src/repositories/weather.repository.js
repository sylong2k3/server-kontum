'use strict';

const db = require('../configs/database');

/**
 * Lấy bản ghi cache còn hạn theo cache_key.
 * @returns {object|null}
 */
const getFresh = async (cacheKey) => {
    const { rows } = await db.query(
        `SELECT * FROM gis.weather_cache
         WHERE cache_key = $1 AND expires_at > NOW()
         LIMIT 1`,
        [cacheKey],
    );
    return rows[0] || null;
};

/**
 * Lấy bản ghi cache gần nhất theo cache_key bất kể còn hạn hay không.
 * Dùng làm fallback khi API ngoài lỗi.
 */
const getLatest = async (cacheKey) => {
    const { rows } = await db.query(
        `SELECT * FROM gis.weather_cache
         WHERE cache_key = $1
         ORDER BY fetched_at DESC
         LIMIT 1`,
        [cacheKey],
    );
    return rows[0] || null;
};

/**
 * Upsert một bản ghi cache theo cache_key (unique).
 */
const upsert = async ({
    cache_key, data_type, lng = null, lat = null, bbox = null,
    payload, source = 'openweather', observed_at = null, expires_at,
}) => {
    const { rows } = await db.query(
        `INSERT INTO gis.weather_cache
            (cache_key, data_type, lng, lat, bbox, payload, source, observed_at, fetched_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), $9)
         ON CONFLICT (cache_key) DO UPDATE SET
            data_type   = EXCLUDED.data_type,
            lng         = EXCLUDED.lng,
            lat         = EXCLUDED.lat,
            bbox        = EXCLUDED.bbox,
            payload     = EXCLUDED.payload,
            source      = EXCLUDED.source,
            observed_at = EXCLUDED.observed_at,
            fetched_at  = NOW(),
            expires_at  = EXCLUDED.expires_at
         RETURNING *`,
        [
            cache_key, data_type, lng, lat,
            bbox ? JSON.stringify(bbox) : null,
            JSON.stringify(payload), source, observed_at, expires_at,
        ],
    );
    return rows[0];
};

/**
 * Dọn các bản ghi cache đã hết hạn quá lâu (giữ lại gần nhất làm fallback).
 */
const deleteExpired = async (graceDays = 7) => {
    const { rowCount } = await db.query(
        `DELETE FROM gis.weather_cache
         WHERE expires_at < NOW() - ($1 || ' days')::interval`,
        [String(graceDays)],
    );
    return rowCount;
};

module.exports = {
    getFresh,
    getLatest,
    upsert,
    deleteExpired,
};
