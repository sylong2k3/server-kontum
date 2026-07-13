'use strict';

/**
 * Monitored Area Repository — "khu vực theo dõi" (docs/modules/17 §1.3).
 * Gom nhiều phiên đo GPS của cùng một chỗ theo thời gian để xem diễn tiến.
 * Chỉ chứa SQL, không chứa business logic.
 */

const db = require('../configs/database');

const exec = (client) => (text, params) => client ? client.query(text, params) : db.query(text, params);

const AREA_COLUMNS = `
    id, code, name,
    CASE WHEN ref_geom IS NULL THEN NULL ELSE ST_AsGeoJSON(ref_geom)::json END AS ref_geom,
    commune_code, note, created_by, created_at, updated_at
`;

const create = async (client, { name, geomGeoJSON, communeCode, note, createdBy }) => {
    const { rows } = await exec(client)(
        `INSERT INTO gis.monitored_areas (name, ref_geom, commune_code, note, created_by)
         VALUES ($1, ST_SetSRID(ST_GeomFromGeoJSON($2), 4326), $3, $4, $5)
         RETURNING ${AREA_COLUMNS}`,
        [name || null, JSON.stringify(geomGeoJSON), communeCode || null, note || null, createdBy || null]
    );
    return rows[0];
};

// Gán mã KV-{năm}-{id} sau khi INSERT (id sinh từ SERIAL nên không trùng).
const assignCode = async (client, id) => {
    const year = new Date().getFullYear();
    const code = `KV-${year}-${String(id).padStart(3, '0')}`;
    const { rows } = await exec(client)(
        `UPDATE gis.monitored_areas SET code = $2 WHERE id = $1 RETURNING ${AREA_COLUMNS}`,
        [id, code]
    );
    return rows[0];
};

const findById = async (id) => {
    const { rows } = await db.query(`SELECT ${AREA_COLUMNS} FROM gis.monitored_areas WHERE id = $1`, [id]);
    return rows[0] || null;
};

const findAll = async ({ communeCode, limit = 50, offset = 0 } = {}) => {
    const where = [];
    const params = [];
    if (communeCode) {
        params.push(communeCode);
        where.push(`commune_code = $${params.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    params.push(limit, offset);
    const { rows } = await db.query(
        `SELECT ${AREA_COLUMNS}, COUNT(*) OVER()::int AS total_count
         FROM gis.monitored_areas ${whereSql}
         ORDER BY created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
    );
    if (rows.length === 0) { return { items: [], total: 0 }; }
    const total = rows[0].total_count;
    const items = rows.map(({ total_count, ...row }) => row);
    return { items, total };
};

// Mốc 1 (§1.3.1): gợi ý khu vực gần một điểm GPS — dùng khi cán bộ vừa tới hiện trường.
const suggestByPoint = async ({ lng, lat, radiusM = 50 }) => {
    const { rows } = await db.query(
        `SELECT ${AREA_COLUMNS},
                (SELECT COUNT(*)::int FROM gis.field_measurements fm WHERE fm.area_id = ma.id) AS measurement_count,
                (SELECT MAX(fm.finished_at) FROM gis.field_measurements fm WHERE fm.area_id = ma.id) AS last_measured_at
         FROM gis.monitored_areas ma
         WHERE ref_geom IS NOT NULL AND ST_DWithin(
             ref_geom::geography,
             ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
             $3
         )
         ORDER BY ST_Distance(ref_geom::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) ASC
         LIMIT 10`,
        [lng, lat, radiusM]
    );
    return rows;
};

// Mốc 2 (§1.3.1): gợi ý khu vực trùng với polygon vừa đo, so với hình LẦN ĐO GẦN NHẤT
// (không phải ref_geom lần đầu) — tỉ lệ trùng chia cho hình NHỎ hơn (LEAST) để không bỏ
// sót trường hợp khu vực co lại (vd. rừng bị phá dần).
const suggestByGeom = async ({ geomGeoJSON }) => {
    const { rows } = await db.query(
        `WITH latest AS (
            SELECT DISTINCT ON (area_id) area_id, geom
            FROM gis.field_measurements
            WHERE area_id IS NOT NULL AND status = 'verified'
            ORDER BY area_id, finished_at DESC NULLS LAST, created_at DESC
        ), new_geom AS (
            SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 4326) AS g
        )
        SELECT ma.id, ma.code, ma.name, ma.commune_code,
               ROUND(ST_Area(ST_Intersection(l.geom, ng.g)::geography)::numeric, 2) AS overlap_m2,
               ROUND(ST_Area(ng.g::geography)::numeric, 2) AS new_m2,
               ROUND(ST_Area(l.geom::geography)::numeric, 2) AS last_m2
        FROM latest l
        JOIN gis.monitored_areas ma ON ma.id = l.area_id
        CROSS JOIN new_geom ng
        WHERE ST_Intersects(l.geom, ng.g)
        ORDER BY overlap_m2 DESC
        LIMIT 10`,
        [JSON.stringify(geomGeoJSON)]
    );
    // Tỉ lệ trùng theo hình NHỎ hơn — xem lý do trong docs/modules/17 §1.3.1.
    return rows.map((row) => ({
        ...row,
        overlapRatio: Math.min(row.new_m2, row.last_m2) > 0
            ? Number((row.overlap_m2 / Math.min(row.new_m2, row.last_m2)).toFixed(4))
            : 0,
    }));
};

// Dòng thời gian các lần đo của một khu vực — diện tích/loại đất/ảnh qua từng mốc.
const findTimeline = async (areaId) => {
    const { rows } = await db.query(
        `SELECT id, code, area_m2, old_land_use, new_land_use, status,
                avg_accuracy_m, finished_at, submitted_at, verified_at, created_at
         FROM gis.field_measurements
         WHERE area_id = $1
         ORDER BY COALESCE(finished_at, created_at) ASC`,
        [areaId]
    );
    return rows;
};

module.exports = {
    create,
    assignCode,
    findById,
    findAll,
    suggestByPoint,
    suggestByGeom,
    findTimeline,
};
