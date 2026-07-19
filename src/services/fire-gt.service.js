'use strict';

/**
 * Ground truth service cho fire-risk. Thin layer trên repo — validate business
 * rules + trigger notification/audit khi có GT mới.
 */

const repo     = require('../repositories/fire-gt.repository');
const { Api400Error, Api404Error } = require('../core/error.response');

const DEBUG = process.env.FIRE_RISK_DEBUG === 'true'
    || process.env.NODE_ENV === 'development';
const dbg = (msg) => { if (DEBUG) console.debug(`[FIRE-GT] ${msg}`); };

// ── ZONES ────────────────────────────────────────────────────────────────────

async function createZone(body, user) {
    const geom = body.geom;
    // Bọc Polygon → MultiPolygon (schema NOT NULL, GEOMETRY(MULTIPOLYGON, 4326)).
    const multiGeom = geom.type === 'Polygon'
        ? { type: 'MultiPolygon', coordinates: [geom.coordinates] }
        : geom;
    dbg(`createZone type=${multiGeom.type} severity=${body.severity} user=${user?.id}`);
    return repo.insertZone({
        ...body,
        geom: multiGeom,
        createdBy: user?.id,
    });
}

async function bulkZoneFromFeatureCollection(fc, user) {
    if (!fc?.features?.length) throw new Api400Error('FeatureCollection rỗng.', ['EMPTY_FC']);
    // Auto-fill severity/occurredAt nếu properties thiếu — dùng ngày hôm nay + sev 3.
    const now = new Date();
    fc.features.forEach((f) => {
        f.properties = f.properties || {};
        if (!f.properties.occurredAt && !f.properties.occurred_at && !f.properties.date) {
            f.properties.occurredAt = now;
        }
        if (!f.properties.severity) f.properties.severity = 3;
    });
    dbg(`bulkZone count=${fc.features.length} user=${user?.id}`);
    return repo.insertZoneBulk(fc.features, user?.id);
}

async function listZones(query) { return repo.listZones(query); }

async function deleteZone(id) {
    const ok = await repo.softDeleteZone(Number(id));
    if (!ok) throw new Api404Error('Zone không tồn tại.', ['NOT_FOUND']);
    return { deleted: true, id: Number(id) };
}

// ── POINTS ───────────────────────────────────────────────────────────────────

async function createPoint(body, user) {
    dbg(`createPoint sev=${body.severity} coords=[${body.lng},${body.lat}]`);
    return repo.insertPoint({ ...body, createdBy: user?.id });
}

async function bulkPoint(body, user) {
    dbg(`bulkPoint count=${body.points.length} user=${user?.id}`);
    return repo.insertPointBulk(body.points, user?.id);
}

async function listPoints(query) { return repo.listPoints(query); }

async function deletePoint(id) {
    const ok = await repo.softDeletePoint(Number(id));
    if (!ok) throw new Api404Error('Point không tồn tại.', ['NOT_FOUND']);
    return { deleted: true, id: Number(id) };
}

// ── For pipeline: get GT for the analysis window ─────────────────────────────

/**
 * Trả GT active trong cửa sổ N ngày trước analysisDate.
 * Note: analysisDate là ISO string hoặc Date, N là số ngày (default 30).
 */
async function getGtForAnalysis(analysisDate, windowDays = 30) {
    const to   = new Date(analysisDate);
    const from = new Date(to.getTime() - windowDays * 24 * 3600 * 1000);
    dbg(`getGtForAnalysis window=${windowDays}d [${from.toISOString()}, ${to.toISOString()})`);
    return repo.getGtForWindow({ from, to });
}

module.exports = {
    createZone, bulkZoneFromFeatureCollection, listZones, deleteZone,
    createPoint, bulkPoint, listPoints, deletePoint,
    getGtForAnalysis,
};
