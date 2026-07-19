'use strict';

/**
 * Repository ground truth cho forest classification.
 *
 * Cùng shape với fire-gt.repository.js nhưng:
 *   - schema `forest` thay vì `fire`
 *   - `class_id` (0-10) thay vì `severity` (1-5)
 *   - `observed_at` thay vì `occurred_at` (đo đạc chứ không phải sự cố)
 */

const db = require('../configs/database');

const DEBUG = process.env.FC_DEBUG === 'true'
    || process.env.NODE_ENV === 'development';
const dbg = (msg) => { if (DEBUG) console.debug(`[FOREST-GT-REPO] ${msg}`); };

// ── ZONES ────────────────────────────────────────────────────────────────────

const insertZone = async ({ name, observedAt, classId, source, geom, notes, createdBy }) => {
    dbg(`insertZone name="${name}" observed=${observedAt} class=${classId} source=${source}`);
    const { rows } = await db.query(
        `INSERT INTO forest.forest_gt_zones
            (name, observed_at, class_id, source, geom, notes, created_by)
         VALUES ($1, $2, $3, $4, ST_GeomFromGeoJSON($5), $6, $7)
         RETURNING id, name, observed_at, class_id, source, area_ha,
                   ST_AsGeoJSON(geom)::jsonb AS geom, notes, created_at`,
        [name || null, observedAt, classId, source || 'field_survey',
         JSON.stringify(geom), notes || null, createdBy || null],
    );
    return rows[0];
};

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
            const multiGeom = geom.type === 'Polygon'
                ? { type: 'MultiPolygon', coordinates: [geom.coordinates] }
                : geom;
            // Chấp nhận cả camel + snake — properties từ upload GeoJSON có
            // shape khác nhau tùy tool xuất.
            const classId = p.classId ?? p.class_id ?? p.class;
            if (classId == null) {
                throw new Error(`Feature ${ids.length + 1} thiếu class_id (0-10).`);
            }
            const { rows } = await client.query(
                `INSERT INTO forest.forest_gt_zones
                    (name, observed_at, class_id, source, geom, notes, created_by)
                 VALUES ($1, $2, $3, $4, ST_GeomFromGeoJSON($5), $6, $7)
                 RETURNING id`,
                [
                    p.name || null,
                    p.observedAt || p.observed_at || p.date || new Date(),
                    Number(classId),
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

const listZones = async ({ page = 1, limit = 50, from, to, classId } = {}) => {
    const offset = (page - 1) * limit;
    const wh = ['is_active = TRUE'];
    const args = [];
    if (from)    { args.push(from);    wh.push(`observed_at >= $${args.length}`); }
    if (to)      { args.push(to);      wh.push(`observed_at <  $${args.length}`); }
    if (classId != null) { args.push(classId); wh.push(`class_id = $${args.length}`); }
    args.push(limit, offset);
    const { rows } = await db.query(
        `SELECT id, name, observed_at, class_id, source, area_ha,
                ST_AsGeoJSON(geom)::jsonb AS geom, notes, created_at,
                COUNT(*) OVER()::int AS total_count
         FROM forest.forest_gt_zones
         WHERE ${wh.join(' AND ')}
         ORDER BY observed_at DESC
         LIMIT $${args.length - 1} OFFSET $${args.length}`,
        args,
    );
    const total = rows[0]?.total_count || 0;
    return { items: rows.map(({ total_count, ...r }) => r), total };
};

const softDeleteZone = async (id) => {
    dbg(`softDeleteZone id=${id}`);
    const { rowCount } = await db.query(
        `UPDATE forest.forest_gt_zones SET is_active = FALSE, updated_at = NOW() WHERE id = $1`,
        [id],
    );
    return rowCount > 0;
};

// ── POINTS ───────────────────────────────────────────────────────────────────

const insertPoint = async ({ observedAt, classId, lng, lat, source, photoUrl, reporterName, notes, createdBy }) => {
    dbg(`insertPoint observed=${observedAt} class=${classId} coords=[${lng},${lat}]`);
    const { rows } = await db.query(
        `INSERT INTO forest.forest_gt_points
            (observed_at, class_id, lng, lat, source, photo_url, reporter_name, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, observed_at, class_id, lng, lat, source, photo_url,
                   reporter_name, notes, created_at`,
        [observedAt, classId, lng, lat, source || 'field_report',
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
                `INSERT INTO forest.forest_gt_points
                    (observed_at, class_id, lng, lat, source, photo_url, reporter_name, notes, created_by)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                 RETURNING id`,
                [
                    p.observedAt || p.observed_at,
                    Number(p.classId ?? p.class_id),
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

const listPoints = async ({ page = 1, limit = 100, from, to, classId } = {}) => {
    const offset = (page - 1) * limit;
    const wh = ['is_active = TRUE'];
    const args = [];
    if (from)    { args.push(from);    wh.push(`observed_at >= $${args.length}`); }
    if (to)      { args.push(to);      wh.push(`observed_at <  $${args.length}`); }
    if (classId != null) { args.push(classId); wh.push(`class_id = $${args.length}`); }
    args.push(limit, offset);
    const { rows } = await db.query(
        `SELECT id, observed_at, class_id, lng, lat, source, photo_url,
                reporter_name, notes, created_at,
                COUNT(*) OVER()::int AS total_count
         FROM forest.forest_gt_points
         WHERE ${wh.join(' AND ')}
         ORDER BY observed_at DESC
         LIMIT $${args.length - 1} OFFSET $${args.length}`,
        args,
    );
    const total = rows[0]?.total_count || 0;
    return { items: rows.map(({ total_count, ...r }) => r), total };
};

const softDeletePoint = async (id) => {
    dbg(`softDeletePoint id=${id}`);
    const { rowCount } = await db.query(
        `UPDATE forest.forest_gt_points SET is_active = FALSE WHERE id = $1`,
        [id],
    );
    return rowCount > 0;
};

// ── For pipeline: fetch GT active trong cửa sổ [from, to) ────────────────────

const getGtForWindow = async ({ from, to }) => {
    dbg(`getGtForWindow from=${from} to=${to}`);
    const zonesQ = db.query(
        `SELECT id, name, observed_at, class_id,
                ST_AsGeoJSON(geom)::jsonb AS geom, area_ha
         FROM forest.forest_gt_zones
         WHERE is_active = TRUE AND observed_at >= $1 AND observed_at < $2`,
        [from, to],
    );
    const pointsQ = db.query(
        `SELECT id, observed_at, class_id, lng, lat,
                ST_AsGeoJSON(geom)::jsonb AS geom
         FROM forest.forest_gt_points
         WHERE is_active = TRUE AND observed_at >= $1 AND observed_at < $2`,
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
                class:       r.class_id,   // property key `class` để runRfClassification match sampleRegions
                observedAt:  r.observed_at,
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
                class:       r.class_id,
                observedAt:  r.observed_at,
                lng:         Number(r.lng),
                lat:         Number(r.lat),
            },
        })),
    };
    const counts = {
        zones: zRows.length, points: pRows.length,
        byClass: zRows.concat(pRows).reduce((acc, r) => {
            acc[r.class_id] = (acc[r.class_id] || 0) + 1;
            return acc;
        }, {}),
    };
    dbg(`getGtForWindow → zones=${counts.zones} points=${counts.points} byClass=${JSON.stringify(counts.byClass)}`);
    return { zones, points, counts };
};

module.exports = {
    insertZone, insertZoneBulk, listZones, softDeleteZone,
    insertPoint, insertPointBulk, listPoints, softDeletePoint,
    getGtForWindow,
};
