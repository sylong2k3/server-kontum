'use strict';

/**
 * Repository ground truth cho fire-risk.
 *
 * 2 loại:
 *   - fire_gt_zones  : MultiPolygon (từ GeoJSON upload)
 *   - fire_gt_points : Point (single/bulk entry)
 *
 * Soft delete qua `is_active = false` — không xóa cứng để không rewrite
 * lịch sử snapshot đã dùng GT nào.
 */

const db = require('../configs/database');

const DEBUG = process.env.FIRE_RISK_DEBUG === 'true'
    || process.env.NODE_ENV === 'development';
const dbg = (msg) => { if (DEBUG) console.debug(`[FIRE-GT-REPO] ${msg}`); };

// ── ZONES ────────────────────────────────────────────────────────────────────

const insertZone = async ({ name, occurredAt, severity, source, geom, notes, createdBy }) => {
    dbg(`insertZone name="${name}" occurred=${occurredAt} severity=${severity} source=${source}`);
    const { rows } = await db.query(
        `INSERT INTO fire.fire_gt_zones
            (name, occurred_at, severity, source, geom, notes, created_by)
         VALUES ($1, $2, $3, $4, ST_GeomFromGeoJSON($5), $6, $7)
         RETURNING id, name, occurred_at, severity, source, area_ha,
                   ST_AsGeoJSON(geom)::jsonb AS geom, notes, created_at`,
        [name || null, occurredAt, severity, source || 'field_survey',
         JSON.stringify(geom), notes || null, createdBy || null],
    );
    return rows[0];
};

/**
 * Bulk insert từ FeatureCollection. Mỗi feature = 1 zone. properties có
 * shape: { name?, occurredAt (bắt buộc), severity (bắt buộc), source?, notes? }.
 */
const insertZoneBulk = async (features, createdBy) => {
    if (!features?.length) return { inserted: 0, ids: [] };
    dbg(`insertZoneBulk count=${features.length}`);
    const client = await db.pool.connect();
    const ids = [];
    try {
        await client.query('BEGIN');
        for (const f of features) {
            const p = f.properties || {};
            const geom = f.geometry;
            // Bọc Polygon → MultiPolygon nếu cần (schema strict MULTIPOLYGON).
            const multiGeom = geom.type === 'Polygon'
                ? { type: 'MultiPolygon', coordinates: [geom.coordinates] }
                : geom;
            const { rows } = await client.query(
                `INSERT INTO fire.fire_gt_zones
                    (name, occurred_at, severity, source, geom, notes, created_by)
                 VALUES ($1, $2, $3, $4, ST_GeomFromGeoJSON($5), $6, $7)
                 RETURNING id`,
                [
                    p.name || null,
                    p.occurredAt || p.occurred_at || p.date || new Date(),
                    p.severity || 3,
                    p.source || 'field_survey',
                    JSON.stringify(multiGeom),
                    p.notes || null,
                    createdBy || null,
                ],
            );
            ids.push(rows[0].id);
        }
        await client.query('COMMIT');
        return { inserted: ids.length, ids };
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
};

const listZones = async ({ page = 1, limit = 50, from, to, severity } = {}) => {
    const offset = (page - 1) * limit;
    const wh = ['is_active = TRUE'];
    const args = [];
    if (from)     { args.push(from);     wh.push(`occurred_at >= $${args.length}`); }
    if (to)       { args.push(to);       wh.push(`occurred_at <  $${args.length}`); }
    if (severity) { args.push(severity); wh.push(`severity = $${args.length}`); }
    args.push(limit, offset);
    const { rows } = await db.query(
        `SELECT id, name, occurred_at, severity, source, area_ha,
                ST_AsGeoJSON(geom)::jsonb AS geom, notes, created_at,
                COUNT(*) OVER()::int AS total_count
         FROM fire.fire_gt_zones
         WHERE ${wh.join(' AND ')}
         ORDER BY occurred_at DESC
         LIMIT $${args.length - 1} OFFSET $${args.length}`,
        args,
    );
    const total = rows[0]?.total_count || 0;
    return { items: rows.map(({ total_count, ...r }) => r), total };
};

const softDeleteZone = async (id) => {
    dbg(`softDeleteZone id=${id}`);
    const { rowCount } = await db.query(
        `UPDATE fire.fire_gt_zones SET is_active = FALSE, updated_at = NOW() WHERE id = $1`,
        [id],
    );
    return rowCount > 0;
};

// ── POINTS ───────────────────────────────────────────────────────────────────

const insertPoint = async ({ occurredAt, severity, lng, lat, source, photoUrl, reporterName, notes, createdBy }) => {
    dbg(`insertPoint occurred=${occurredAt} sev=${severity} coords=[${lng},${lat}]`);
    const { rows } = await db.query(
        `INSERT INTO fire.fire_gt_points
            (occurred_at, severity, lng, lat, source, photo_url, reporter_name, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, occurred_at, severity, lng, lat, source, photo_url,
                   reporter_name, notes, created_at`,
        [occurredAt, severity, lng, lat, source || 'field_report',
         photoUrl || null, reporterName || null, notes || null, createdBy || null],
    );
    return rows[0];
};

const insertPointBulk = async (points, createdBy) => {
    if (!points?.length) return { inserted: 0, ids: [] };
    dbg(`insertPointBulk count=${points.length}`);
    const client = await db.pool.connect();
    const ids = [];
    try {
        await client.query('BEGIN');
        for (const p of points) {
            const { rows } = await client.query(
                `INSERT INTO fire.fire_gt_points
                    (occurred_at, severity, lng, lat, source, photo_url, reporter_name, notes, created_by)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                 RETURNING id`,
                [
                    p.occurredAt || p.occurred_at,
                    p.severity || 3,
                    Number(p.lng),
                    Number(p.lat),
                    p.source || 'field_report',
                    p.photoUrl || p.photo_url || null,
                    p.reporterName || p.reporter_name || null,
                    p.notes || null,
                    createdBy || null,
                ],
            );
            ids.push(rows[0].id);
        }
        await client.query('COMMIT');
        return { inserted: ids.length, ids };
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
};

const listPoints = async ({ page = 1, limit = 100, from, to, severity } = {}) => {
    const offset = (page - 1) * limit;
    const wh = ['is_active = TRUE'];
    const args = [];
    if (from)     { args.push(from);     wh.push(`occurred_at >= $${args.length}`); }
    if (to)       { args.push(to);       wh.push(`occurred_at <  $${args.length}`); }
    if (severity) { args.push(severity); wh.push(`severity = $${args.length}`); }
    args.push(limit, offset);
    const { rows } = await db.query(
        `SELECT id, occurred_at, severity, lng, lat, source, photo_url,
                reporter_name, notes, created_at,
                COUNT(*) OVER()::int AS total_count
         FROM fire.fire_gt_points
         WHERE ${wh.join(' AND ')}
         ORDER BY occurred_at DESC
         LIMIT $${args.length - 1} OFFSET $${args.length}`,
        args,
    );
    const total = rows[0]?.total_count || 0;
    return { items: rows.map(({ total_count, ...r }) => r), total };
};

const softDeletePoint = async (id) => {
    dbg(`softDeletePoint id=${id}`);
    const { rowCount } = await db.query(
        `UPDATE fire.fire_gt_points SET is_active = FALSE WHERE id = $1`,
        [id],
    );
    return rowCount > 0;
};

// ── For pipeline: fetch GT active trong cửa sổ [from, to) làm FeatureCollection ─

/**
 * Trả về { zones: FeatureCollection, points: FeatureCollection, counts } —
 * pipeline convert sang ee.FeatureCollection inline (không cần asset).
 */
const getGtForWindow = async ({ from, to }) => {
    dbg(`getGtForWindow from=${from} to=${to}`);
    const zonesQ = db.query(
        `SELECT id, name, occurred_at, severity,
                ST_AsGeoJSON(geom)::jsonb AS geom, area_ha
         FROM fire.fire_gt_zones
         WHERE is_active = TRUE AND occurred_at >= $1 AND occurred_at < $2`,
        [from, to],
    );
    const pointsQ = db.query(
        `SELECT id, occurred_at, severity, lng, lat,
                ST_AsGeoJSON(geom)::jsonb AS geom
         FROM fire.fire_gt_points
         WHERE is_active = TRUE AND occurred_at >= $1 AND occurred_at < $2`,
        [from, to],
    );
    const [{ rows: zRows }, { rows: pRows }] = await Promise.all([zonesQ, pointsQ]);

    const zones = {
        type: 'FeatureCollection',
        features: zRows.map((r) => ({
            type: 'Feature',
            geometry: r.geom,
            properties: {
                gt_id:       r.id,
                severity:    r.severity,
                occurredAt:  r.occurred_at,
                area_ha:     Number(r.area_ha),
                name:        r.name,
            },
        })),
    };
    const points = {
        type: 'FeatureCollection',
        features: pRows.map((r) => ({
            type: 'Feature',
            geometry: r.geom,
            properties: {
                gt_id:       r.id,
                severity:    r.severity,
                occurredAt:  r.occurred_at,
                lng:         Number(r.lng),
                lat:         Number(r.lat),
            },
        })),
    };
    const counts = { zones: zRows.length, points: pRows.length };
    dbg(`getGtForWindow → zones=${counts.zones} points=${counts.points}`);
    return { zones, points, counts };
};

module.exports = {
    insertZone, insertZoneBulk, listZones, softDeleteZone,
    insertPoint, insertPointBulk, listPoints, softDeletePoint,
    getGtForWindow,
};
