'use strict';

/**
 * Spatial Analysis Repository (EP-07).
 *
 * US-061: Thay đổi rừng giữa 2 mốc — so sánh gis.landcover_statistics.
 * US-062: Khoảng cách dân cư – rừng — ST_DWithin trên lớp GIS đã import.
 *
 * Dynamic table refs (lớp GIS) được kiểm tra identifier nghiêm ngặt để chống
 * SQL injection (chỉ cho phép [a-zA-Z_][a-zA-Z0-9_]*).
 */

const db = require('../configs/database');

const IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const assertIdentifier = (value, label = 'identifier') => {
    if (!IDENTIFIER_RE.test(String(value || ''))) {
        throw new Error(`Invalid ${label}: ${value}`);
    }
    return value;
};
const qid = (value) => '"' + assertIdentifier(value).replace(/"/g, '""') + '"';
const tableRef = (layer) => `${qid(layer.schema_name)}.${qid(layer.table_name)}`;
const geomCol = (layer) => qid(layer.geometry_column || 'geom');

// ── Tra cứu lớp GIS trong registry ────────────────────────────────────────────
const findLayerByCode = async (code) => {
    const { rows } = await db.query(
        `SELECT id, code, name_vi, schema_name, table_name,
                COALESCE(geometry_column, 'geom') AS geometry_column,
                geometry_type, epsg_code, is_active
         FROM   gis.layer_registry WHERE code = $1`,
        [code],
    );
    return rows[0] || null;
};

// ── US-061: Thay đổi rừng giữa 2 mốc (tabular) ────────────────────────────────
/**
 * So sánh diện tích rừng giữa 2 năm cho từng đơn vị (hoặc 1 đơn vị cụ thể).
 */
const getForestChange = async ({ fromYear, toYear, forestType = 'total', unitCode = null }) => {
    const { rows } = await db.query(
        `WITH a AS (
            SELECT unit_code, area_ha, coverage_pct
            FROM   gis.landcover_statistics
            WHERE  period_year = $1 AND forest_type = $3
              AND  ($4::text IS NULL OR unit_code = $4)
         ), b AS (
            SELECT unit_code, area_ha, coverage_pct
            FROM   gis.landcover_statistics
            WHERE  period_year = $2 AND forest_type = $3
              AND  ($4::text IS NULL OR unit_code = $4)
         )
         SELECT u.code AS unit_code, u.name_vi, u.name_en,
                a.area_ha AS from_area_ha, b.area_ha AS to_area_ha,
                a.coverage_pct AS from_coverage_pct, b.coverage_pct AS to_coverage_pct,
                (b.area_ha - a.area_ha) AS delta_area_ha,
                CASE WHEN a.area_ha IS NOT NULL AND a.area_ha <> 0
                     THEN ROUND(((b.area_ha - a.area_ha) / a.area_ha) * 100, 2)
                     ELSE NULL END AS delta_pct
         FROM   gis.administrative_units u
         JOIN   a ON a.unit_code = u.code
         JOIN   b ON b.unit_code = u.code
         ORDER BY u.sort_order, u.code`,
        [fromYear, toYear, forestType, unitCode],
    );
    return rows;
};

// ── US-062: Khoảng cách dân cư – rừng (ST_DWithin) ────────────────────────────
/**
 * Tìm các đối tượng dân cư nằm trong ngưỡng khoảng cách tới rừng.
 * Cả 2 lớp đều là lớp GIS động — table ref được kiểm tra identifier.
 *
 * @returns {Promise<Array>} mỗi phần tử: { gid, distance_m, geojson }
 */
const findResidentialNearForest = async ({ residentialLayer, forestLayer, thresholdM, limit = 500 }) => {
    const resTable  = tableRef(residentialLayer);
    const resGeom   = geomCol(residentialLayer);
    const forTable  = tableRef(forestLayer);
    const forGeom   = geomCol(forestLayer);

    // ST_DWithin trên geography để ngưỡng tính bằng mét chính xác.
    // LATERAL lấy khoảng cách tới đối tượng rừng gần nhất cho mỗi điểm dân cư.
    const sql = `
        SELECT r.ctid::text AS feature_id,
               ROUND(nearest.dist_m::numeric, 2) AS distance_m,
               ST_AsGeoJSON(ST_Transform(r.${resGeom}, 4326))::json AS geojson
        FROM   ${resTable} r
        CROSS JOIN LATERAL (
            SELECT ST_Distance(r.${resGeom}::geography, f.${forGeom}::geography) AS dist_m
            FROM   ${forTable} f
            ORDER BY r.${resGeom} <-> f.${forGeom}
            LIMIT  1
        ) nearest
        WHERE nearest.dist_m <= $1
        ORDER BY nearest.dist_m ASC
        LIMIT $2
    `;
    const { rows } = await db.query(sql, [thresholdM, limit]);
    return rows;
};

module.exports = {
    findLayerByCode,
    getForestChange,
    findResidentialNearForest,
};
