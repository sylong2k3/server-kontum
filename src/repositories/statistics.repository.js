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

// ── Cache dashboard ───────────────────────────────────────────────────────────
//
// NOTE (migration 041): getLandcoverByDistrict / getAvailableYears /
// getProvinceSummary đã BỎ. Bảng gis.landcover_statistics đã bị DROP.
// Endpoint GET /statistics/landcover + dashboard 4 stat card giờ aggregate
// từ forest.forest_snapshots + forest.forest_district_areas — dùng helper
// forestClassificationRepo.getSnapshotYears / getLatestCompletedByYear /
// getDistrictAreas.
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

// Phản ánh cần xử lý (new/in_progress), ưu tiên cao trước — dashboard vận hành (so_nnmt).
const getPendingFeedback = async (limit = 10) => {
    const { rows } = await db.query(
        `SELECT id, category, title, status, priority, lng, lat, created_at
         FROM   field.feedback
         WHERE  deleted_at IS NULL AND status IN ('new', 'in_progress')
         ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, created_at ASC
         LIMIT $1`,
        [limit],
    );
    return rows;
};

module.exports = {
    listAdministrativeUnits,
    findUnitByCode,
    getCache,
    setCache,
    getFeedbackCounts,
    getPendingFeedback,
};
