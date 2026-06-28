'use strict';

/**
 * Statistics Repository (EP-07).
 * Truy vấn dữ liệu thống kê lớp phủ / che phủ rừng + đơn vị hành chính.
 * Tất cả query parameterized.
 */

const db = require('../configs/database');

// ── Đơn vị hành chính ─────────────────────────────────────────────────────────
const listAdministrativeUnits = async (level = 'district') => {
    const { rows } = await db.query(
        `SELECT code, name_vi, name_en, level, parent_code, area_km2, population,
                centroid_lng, centroid_lat, sort_order
         FROM   gis.administrative_units
         WHERE  ($1::text IS NULL OR level = $1)
         ORDER BY sort_order, code`,
        [level || null],
    );
    return rows;
};

const findUnitByCode = async (code) => {
    const { rows } = await db.query(
        `SELECT code, name_vi, name_en, level, parent_code, area_km2, population
         FROM   gis.administrative_units WHERE code = $1`,
        [code],
    );
    return rows[0] || null;
};

// ── Che phủ rừng theo huyện + năm ─────────────────────────────────────────────
/**
 * Lấy thống kê lớp phủ theo huyện cho một năm, kèm số liệu năm trước để tính
 * biến động (change_pct) ngay trong SQL bằng window function LAG.
 */
const getLandcoverByDistrict = async ({ year, forestType = 'total', level = 'district' }) => {
    const { rows } = await db.query(
        `WITH series AS (
            SELECT s.unit_code, s.period_year, s.forest_type, s.area_ha, s.coverage_pct,
                   LAG(s.area_ha) OVER (PARTITION BY s.unit_code, s.forest_type ORDER BY s.period_year) AS prev_area_ha
            FROM   gis.landcover_statistics s
            JOIN   gis.administrative_units u ON u.code = s.unit_code
            WHERE  s.forest_type = $2
              AND  ($3::text IS NULL OR u.level = $3)
         )
         SELECT u.code AS unit_code, u.name_vi, u.name_en, u.area_km2, u.population,
                ser.period_year, ser.forest_type, ser.area_ha, ser.coverage_pct,
                ser.prev_area_ha,
                CASE WHEN ser.prev_area_ha IS NOT NULL AND ser.prev_area_ha <> 0
                     THEN ROUND(((ser.area_ha - ser.prev_area_ha) / ser.prev_area_ha) * 100, 2)
                     ELSE NULL END AS change_pct
         FROM   gis.administrative_units u
         JOIN   series ser ON ser.unit_code = u.code AND ser.period_year = $1
         ORDER BY u.sort_order, u.code`,
        [year, forestType, level || null],
    );
    return rows;
};

/** Tổng hợp các năm có dữ liệu (cho dropdown / hợp lệ hoá tham số). */
const getAvailableYears = async () => {
    const { rows } = await db.query(
        `SELECT DISTINCT period_year FROM gis.landcover_statistics ORDER BY period_year DESC`,
    );
    return rows.map((r) => r.period_year);
};

/** Tổng hợp toàn tỉnh theo loại rừng cho một năm. */
const getProvinceSummary = async (year) => {
    const { rows } = await db.query(
        `SELECT forest_type, area_ha, coverage_pct, source
         FROM   gis.landcover_statistics
         WHERE  unit_code = '62' AND period_year = $1`,
        [year],
    );
    return rows;
};

// ── Cache dashboard ───────────────────────────────────────────────────────────
const getCache = async (key) => {
    const { rows } = await db.query(
        `SELECT payload, computed_at FROM gis.stats_cache WHERE cache_key = $1 AND expires_at > NOW()`,
        [key],
    );
    return rows[0] || null;
};

const setCache = async (key, payload, ttlSeconds) => {
    await db.query(
        `INSERT INTO gis.stats_cache (cache_key, payload, computed_at, expires_at)
         VALUES ($1, $2::jsonb, NOW(), NOW() + ($3 || ' seconds')::interval)
         ON CONFLICT (cache_key) DO UPDATE SET
            payload = EXCLUDED.payload, computed_at = NOW(), expires_at = EXCLUDED.expires_at`,
        [key, JSON.stringify(payload), String(ttlSeconds)],
    );
};

// ── Số liệu cho dashboard (đếm phản ánh theo trạng thái) ──────────────────────
const getFeedbackCounts = async () => {
    const { rows } = await db.query(
        `SELECT status, COUNT(*)::int AS count
         FROM   field.feedback
         WHERE  deleted_at IS NULL
         GROUP BY status`,
    );
    return rows;
};

module.exports = {
    listAdministrativeUnits,
    findUnitByCode,
    getLandcoverByDistrict,
    getAvailableYears,
    getProvinceSummary,
    getCache,
    setCache,
    getFeedbackCounts,
};
