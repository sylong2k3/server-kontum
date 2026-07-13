'use strict';

/**
 * Field Measurement Service — đo đạc thực địa GPS, ghi nhận biến đổi khu vực.
 * Thiết kế: docs/modules/17-change-tracking-design.md
 */

const db = require('../configs/database');
const repo = require('../repositories/field-measurement.repository');
const areaRepo = require('../repositories/monitored-area.repository');
const layerRepo = require('../repositories/map-layer.repository');
const minio = require('./minio.service');
const notificationService = require('./notification.service');
const { Api400Error, Api403Error, Api404Error } = require('../core/error.response');
const { t } = require('../utils/i18n.util');
const { v4: uuidv4 } = require('uuid');
const ExcelJS = require('exceljs');

const MIN_POINTS = 3;

// Gửi realtime/push best-effort — lỗi notification không được làm hỏng luồng chính.
const dispatchSafe = (fn) => {
    try {
        const result = fn();
        if (result && typeof result.catch === 'function') {
            result.catch((err) => console.error('[FIELD_MEASUREMENT] notify error:', err.message));
        }
    } catch (err) {
        console.error('[FIELD_MEASUREMENT] notify error:', err.message);
    }
};

const isOwner = (actor, measurement) => actor?.id && Number(measurement.measured_by) === Number(actor.id);
const isAdmin = (actor) => actor?.role === 'system_admin';

const toMeasurementItem = (row) => ({
    id: row.id,
    code: row.code,
    areaId: row.area_id,
    layerId: row.layer_id,
    points: row.points,
    geom: row.geom,
    areaM2: row.area_m2,
    avgAccuracyM: row.avg_accuracy_m,
    communeCode: row.commune_code,
    affectedFeatures: row.affected_features || [],
    oldLandUse: row.old_land_use,
    newLandUse: row.new_land_use,
    note: row.note,
    status: row.status,
    reviewNote: row.review_note,
    deviceInfo: row.device_info,
    measuredBy: row.measured_by,
    verifiedBy: row.verified_by,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    submittedAt: row.submitted_at,
    verifiedAt: row.verified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
});

const toPhotoItem = (row) => ({
    id: row.id,
    measurementId: row.measurement_id,
    originalName: row.original_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    takenAt: row.taken_at,
    uploadedBy: row.uploaded_by,
    createdAt: row.created_at,
});

const toAreaItem = (row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    refGeom: row.ref_geom,
    communeCode: row.commune_code,
    note: row.note,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
});

// ── Phiên đo ──────────────────────────────────────────────────────────────────

const createMeasurement = async (actor, payload, lang) => {
    if (!Array.isArray(payload.points) || payload.points.length < MIN_POINTS) {
        throw new Api400Error(t('field_measurement_invalid_points', lang));
    }

    const { geom, areaM2, avgAccuracyM } = await repo.buildValidPolygon(payload.points);

    let affectedFeatures = [];
    let oldLandUse = null;
    let layer = null;
    if (payload.layerCode) {
        layer = await layerRepo.findByCode(payload.layerCode);
        if (!layer) { throw new Api404Error(t('map_layer_not_found', lang)); }
        try {
            const intersected = await repo.intersectWithLayer(layer, geom, payload.landUseField || null);
            affectedFeatures = intersected.map((row) => ({
                featureId: row.feature_id,
                landUse: row.land_use,
                overlapM2: row.overlap_m2,
            }));
            oldLandUse = affectedFeatures[0]?.landUse || null; // giao cắt lớn nhất (đã ORDER BY overlap_m2 DESC)
        } catch (err) {
            throw new Api400Error(t('field_measurement_invalid_land_use_field', lang), [err.message]);
        }
    }

    // Best-effort: gis.administrative_units chưa có ranh giới xã/phường thực tế
    // (chờ import shapefile) — commune_code có thể null, không chặn luồng.
    let communeCode = null;
    try {
        communeCode = await repo.findCommuneCode(geom);
    } catch (err) {
        console.warn('[FIELD_MEASUREMENT] commune lookup failed:', err.message);
    }

    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        let created = await repo.create(client, {
            areaId: payload.areaId || null,
            layerId: layer?.id || null,
            points: payload.points,
            geom,
            areaM2,
            avgAccuracyM,
            communeCode,
            affectedFeatures,
            oldLandUse: payload.oldLandUse || oldLandUse,
            newLandUse: payload.newLandUse || null,
            note: payload.note || null,
            deviceInfo: payload.deviceInfo || {},
            measuredBy: actor.id,
            startedAt: payload.startedAt || null,
            finishedAt: payload.finishedAt || null,
        });
        created = await repo.assignCode(client, created.id);
        await client.query('COMMIT');
        return toMeasurementItem(created);
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
};

const listMeasurements = async (query = {}) => {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;
    const offset = (page - 1) * limit;
    const { items, total } = await repo.findAll({
        status: query.status,
        communeCode: query.commune_code,
        areaId: query.area_id,
        from: query.from,
        to: query.to,
        limit,
        offset,
    });
    return { items: items.map(toMeasurementItem), total };
};

const getMeasurementById = async (id, lang) => {
    const measurement = await repo.findById(id);
    if (!measurement) { throw new Api404Error(t('field_measurement_not_found', lang)); }
    const photos = await repo.listPhotos(id);
    return { ...toMeasurementItem(measurement), photos: photos.map(toPhotoItem) };
};

const requireOwnedEditable = async (actor, id, lang) => {
    const measurement = await repo.findById(id);
    if (!measurement) { throw new Api404Error(t('field_measurement_not_found', lang)); }
    if (!isAdmin(actor) && !isOwner(actor, measurement)) {
        throw new Api403Error(t('no_permission', lang));
    }
    if (!['draft', 'rejected'].includes(measurement.status)) {
        throw new Api400Error(t('field_measurement_invalid_transition', lang));
    }
    return measurement;
};

const updateMeasurement = async (actor, id, payload, lang) => {
    await requireOwnedEditable(actor, id, lang);
    const updated = await repo.updateEditable(id, {
        area_id: payload.areaId,
        old_land_use: payload.oldLandUse,
        new_land_use: payload.newLandUse,
        note: payload.note,
    });
    if (!updated) { throw new Api404Error(t('field_measurement_not_found', lang)); }
    return toMeasurementItem(updated);
};

const deleteMeasurement = async (actor, id, lang) => {
    const measurement = await repo.findById(id);
    if (!measurement) { throw new Api404Error(t('field_measurement_not_found', lang)); }
    if (!isAdmin(actor) && !isOwner(actor, measurement)) { throw new Api403Error(t('no_permission', lang)); }
    if (measurement.status !== 'draft') { throw new Api400Error(t('field_measurement_invalid_transition', lang)); }
    const deleted = await repo.remove(id);
    if (!deleted) { throw new Api404Error(t('field_measurement_not_found', lang)); }
};

const addPhoto = async (actor, id, files, lang) => {
    await requireOwnedEditable(actor, id, lang);
    const uploaded = [];
    for (const file of files) {
        const objectKey = minio.buildObjectKey(uuidv4(), file.originalname, 'field-measurements');
        await minio.uploadBuffer({
            buffer: file.buffer,
            objectKey,
            mimeType: file.mimetype,
            bucket: minio.BUCKET_FIELD_MEASUREMENTS,
        });
        const photo = await repo.addPhoto(id, {
            minioKey: objectKey,
            originalName: file.originalname,
            mimeType: file.mimetype,
            sizeBytes: file.size,
            uploadedBy: actor.id,
        });
        uploaded.push(toPhotoItem(photo));
    }
    return uploaded;
};

const submitMeasurement = async (actor, id, context = {}) => {
    const measurement = await requireOwnedEditable(actor, id, context.lang);
    const updated = await repo.submit(id);
    if (!updated) { throw new Api404Error(t('field_measurement_not_found', context.lang)); }

    dispatchSafe(() => notificationService.broadcastToRole('system_admin', {
        channel: 'field_measurement',
        type: 'field_measurement_submitted',
        title: t('field_measurement_notify_submit_title', context.lang),
        body: t('field_measurement_notify_submit_body', context.lang, {
            code: updated.code,
            areaM2: measurement.area_m2,
        }),
        data: {
            measurementId: updated.id,
            code: updated.code,
            areaId: updated.area_id,
            communeCode: updated.commune_code,
            areaM2: updated.area_m2,
        },
    }, context));

    return toMeasurementItem(updated);
};

const verifyMeasurement = async (actor, id, context = {}) => {
    const measurement = await repo.findById(id);
    if (!measurement) { throw new Api404Error(t('field_measurement_not_found', context.lang)); }
    if (measurement.status !== 'submitted') { throw new Api400Error(t('field_measurement_invalid_transition', context.lang)); }

    const updated = await repo.verify(id, actor.id);

    if (updated.measured_by) {
        dispatchSafe(() => notificationService.sendToUser(updated.measured_by, {
            channel: 'field_measurement',
            type: 'field_measurement_verified',
            title: t('field_measurement_notify_verified_title', context.lang),
            body: t('field_measurement_notify_verified_body', context.lang, { code: updated.code }),
            data: { measurementId: updated.id, code: updated.code, status: updated.status },
        }, context));
    }
    dispatchSafe(() => notificationService.broadcastToRole('ubnd_tinh', {
        channel: 'field_measurement',
        type: 'field_measurement_verified',
        title: t('field_measurement_notify_verified_title', context.lang),
        body: t('field_measurement_notify_verified_body', context.lang, { code: updated.code }),
        data: {
            measurementId: updated.id,
            code: updated.code,
            areaId: updated.area_id,
            communeCode: updated.commune_code,
            areaM2: updated.area_m2,
        },
    }, context));

    return toMeasurementItem(updated);
};

const rejectMeasurement = async (actor, id, payload, context = {}) => {
    const measurement = await repo.findById(id);
    if (!measurement) { throw new Api404Error(t('field_measurement_not_found', context.lang)); }
    if (measurement.status !== 'submitted') { throw new Api400Error(t('field_measurement_invalid_transition', context.lang)); }
    if (!payload.reviewNote) { throw new Api400Error(t('field_measurement_review_note_required', context.lang)); }

    const updated = await repo.reject(id, actor.id, payload.reviewNote);

    if (updated.measured_by) {
        dispatchSafe(() => notificationService.sendToUser(updated.measured_by, {
            channel: 'field_measurement',
            type: 'field_measurement_rejected',
            title: t('field_measurement_notify_rejected_title', context.lang),
            body: t('field_measurement_notify_rejected_body', context.lang, {
                code: updated.code,
                reviewNote: payload.reviewNote,
            }),
            data: { measurementId: updated.id, code: updated.code, status: updated.status, reviewNote: payload.reviewNote },
        }, context));
    }

    return toMeasurementItem(updated);
};

// ── Khu vực theo dõi ──────────────────────────────────────────────────────────

const createArea = async (actor, payload) => {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        let area = await areaRepo.create(client, {
            name: payload.name,
            geomGeoJSON: payload.geom,
            communeCode: payload.communeCode,
            note: payload.note,
            createdBy: actor.id,
        });
        area = await areaRepo.assignCode(client, area.id);
        await client.query('COMMIT');
        return toAreaItem(area);
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
};

const listAreas = async (query = {}) => {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;
    const offset = (page - 1) * limit;
    const { items, total } = await areaRepo.findAll({ communeCode: query.commune_code, limit, offset });
    return { items: items.map(toAreaItem), total };
};

const getAreaWithTimeline = async (id, lang) => {
    const area = await areaRepo.findById(id);
    if (!area) { throw new Api404Error(t('monitored_area_not_found', lang)); }
    const timeline = await areaRepo.findTimeline(id);
    return { ...toAreaItem(area), timeline };
};

// Chỉ xuất phiên đo đã 'verified' — kết quả chưa xác thực không đưa vào báo cáo chính thức.
const fetchVerifiedForExport = async (query = {}) => {
    const { items } = await repo.findAll({
        status: 'verified',
        communeCode: query.commune_code,
        from: query.from,
        to: query.to,
        limit: 5000,
        offset: 0,
    });
    return items;
};

const exportMeasurements = async (query = {}) => {
    const items = await fetchVerifiedForExport(query);
    return {
        type: 'FeatureCollection',
        features: items.map((row) => ({
            type: 'Feature',
            geometry: row.geom,
            properties: {
                id: row.id,
                code: row.code,
                areaM2: row.area_m2,
                avgAccuracyM: row.avg_accuracy_m,
                communeCode: row.commune_code,
                oldLandUse: row.old_land_use,
                newLandUse: row.new_land_use,
                note: row.note,
                measuredBy: row.measured_by,
                verifiedBy: row.verified_by,
                verifiedAt: row.verified_at,
            },
        })),
    };
};

// Xuất bảng tính (.xlsx) — chỉ dữ liệu thuộc tính (không có geometry, xem GeoJSON để
// lấy hình học/bản đồ biến động).
const exportMeasurementsXlsx = async (query = {}) => {
    const items = await fetchVerifiedForExport(query);

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Ket qua do dac');
    sheet.columns = [
        { header: 'Mã phiên đo', key: 'code', width: 18 },
        { header: 'Xã/phường', key: 'communeCode', width: 14 },
        { header: 'Diện tích (m²)', key: 'areaM2', width: 16 },
        { header: 'Sai số TB (m)', key: 'avgAccuracyM', width: 14 },
        { header: 'Loại đất trước', key: 'oldLandUse', width: 20 },
        { header: 'Loại đất sau', key: 'newLandUse', width: 20 },
        { header: 'Ghi chú', key: 'note', width: 30 },
        { header: 'Người đo (ID)', key: 'measuredBy', width: 14 },
        { header: 'Người xác thực (ID)', key: 'verifiedBy', width: 16 },
        { header: 'Ngày xác thực', key: 'verifiedAt', width: 20 },
    ];
    sheet.getRow(1).font = { bold: true };

    items.forEach((row) => {
        sheet.addRow({
            code: row.code,
            communeCode: row.commune_code,
            areaM2: row.area_m2,
            avgAccuracyM: row.avg_accuracy_m,
            oldLandUse: row.old_land_use,
            newLandUse: row.new_land_use,
            note: row.note,
            measuredBy: row.measured_by,
            verifiedBy: row.verified_by,
            verifiedAt: row.verified_at ? new Date(row.verified_at).toISOString() : null,
        });
    });

    return workbook.xlsx.writeBuffer();
};

const suggestAreasByPoint = async (lng, lat, radiusM) => areaRepo.suggestByPoint({ lng, lat, radiusM });

const suggestAreasByGeom = async (geom) => areaRepo.suggestByGeom({ geomGeoJSON: geom });

module.exports = {
    createMeasurement,
    listMeasurements,
    getMeasurementById,
    updateMeasurement,
    deleteMeasurement,
    addPhoto,
    submitMeasurement,
    verifyMeasurement,
    rejectMeasurement,
    exportMeasurements,
    exportMeasurementsXlsx,
    createArea,
    listAreas,
    getAreaWithTimeline,
    suggestAreasByPoint,
    suggestAreasByGeom,
};
