'use strict';

/**
 * Ground truth service cho forest classification. Thin layer trên repo.
 */

const repo     = require('../repositories/forest-gt.repository');
const { Api400Error, Api404Error } = require('../core/error.response');

const DEBUG = process.env.FC_DEBUG === 'true'
    || process.env.NODE_ENV === 'development';
const dbg = (msg) => { if (DEBUG) console.debug(`[FOREST-GT] ${msg}`); };

// ── ZONES ────────────────────────────────────────────────────────────────────

async function createZone(body, user) {
    const geom = body.geom;
    const multiGeom = geom.type === 'Polygon'
        ? { type: 'MultiPolygon', coordinates: [geom.coordinates] }
        : geom;
    dbg(`createZone class=${body.classId} type=${multiGeom.type} user=${user?.id}`);
    return repo.insertZone({
        ...body,
        geom: multiGeom,
        createdBy: user?.id,
    });
}

async function bulkZoneFromFeatureCollection(fc, user) {
    if (!fc?.features?.length) throw new Api400Error('FeatureCollection rỗng.', ['EMPTY_FC']);
    const now = new Date();
    fc.features.forEach((f) => {
        f.properties = f.properties || {};
        if (!f.properties.observedAt && !f.properties.observed_at && !f.properties.date) {
            f.properties.observedAt = now;
        }
        const c = f.properties.classId ?? f.properties.class_id ?? f.properties.class;
        if (c == null) throw new Api400Error('Feature thiếu class_id (0-12).', ['MISSING_CLASS_ID']);
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
    dbg(`createPoint class=${body.classId} coords=[${body.lng},${body.lat}]`);
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
 * Cửa sổ mặc định 180 ngày — dài hơn fire-risk (30 ngày) vì phân loại rừng
 * cần đủ mẫu cho RF training 11 class. Env override: FC_GT_WINDOW_DAYS.
 */
async function getGtForAnalysis(analysisEndDate, windowDays = Number(process.env.FC_GT_WINDOW_DAYS) || 180) {
    const to   = new Date(analysisEndDate);
    const from = new Date(to.getTime() - windowDays * 24 * 3600 * 1000);
    dbg(`getGtForAnalysis window=${windowDays}d [${from.toISOString()}, ${to.toISOString()})`);
    return repo.getGtForWindow({ from, to });
}

module.exports = {
    createZone, bulkZoneFromFeatureCollection, listZones, deleteZone,
    createPoint, bulkPoint, listPoints, deletePoint,
    getGtForAnalysis,
};
