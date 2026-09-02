'use strict';

const svc     = require('../services/fire-gt.service');
const schemas = require('../validators/fire-gt.validator');
const { OK, OK_LIST, CREATED } = require('../core/success.response');
const { t } = require('../utils/i18n.util');

const validate = (schema, source, lang) => {
    const { value, error } = schema.validate(source, {
        abortEarly: false, stripUnknown: true, convert: true,
    });
    if (error) {
        const err = new Error(t('invalid_data', lang));
        err.status = 400;
        err.errors = error.details.map((d) => d.message);
        throw err;
    }
    return value;
};

// ── ZONES ────────────────────────────────────────────────────────────────────

const createZone = async (req, res) => {
    const body = validate(schemas.zoneCreate, req.body || {}, req.lang);
    const zone = await svc.createZone(body, req.user);
    console.log(`[FIRE-GT-CTL] zone CREATED id=${zone.id} severity=${zone.severity} user=${req.user?.id}`);
    CREATED(res, 'Đã thêm vùng cháy.', zone);
};

const bulkZone = async (req, res) => {
    const fc = validate(schemas.featureCollection, req.body || {}, req.lang);
    const result = await svc.bulkZoneFromFeatureCollection(fc, req.user);
    console.log(`[FIRE-GT-CTL] zone BULK inserted=${result.inserted} user=${req.user?.id}`);
    CREATED(res, `Đã thêm ${result.inserted} vùng cháy.`, result);
};

const listZones = async (req, res) => {
    const q = validate(schemas.listQuery, req.query || {}, req.lang);
    const { items, total } = await svc.listZones(q);
    OK_LIST(res, 'Danh sách vùng cháy.', items, { page: q.page, limit: q.limit, total });
};

const deleteZone = async (req, res) => {
    const result = await svc.deleteZone(req.params.id);
    console.log(`[FIRE-GT-CTL] zone DELETED id=${result.id} user=${req.user?.id}`);
    OK(res, 'Đã xóa vùng cháy.', result);
};

// ── POINTS ───────────────────────────────────────────────────────────────────

const createPoint = async (req, res) => {
    const body = validate(schemas.pointCreate, req.body || {}, req.lang);
    const p = await svc.createPoint(body, req.user);
    console.log(`[FIRE-GT-CTL] point CREATED id=${p.id} sev=${p.severity}`);
    CREATED(res, 'Đã thêm điểm quan sát.', p);
};

const bulkPoint = async (req, res) => {
    const body = validate(schemas.pointBulk, req.body || {}, req.lang);
    const result = await svc.bulkPoint(body, req.user);
    console.log(`[FIRE-GT-CTL] point BULK inserted=${result.inserted}`);
    CREATED(res, `Đã thêm ${result.inserted} điểm.`, result);
};

const listPoints = async (req, res) => {
    const q = validate(schemas.listQuery, req.query || {}, req.lang);
    const { items, total } = await svc.listPoints(q);
    OK_LIST(res, 'Danh sách điểm.', items, { page: q.page, limit: q.limit, total });
};

const deletePoint = async (req, res) => {
    const result = await svc.deletePoint(req.params.id);
    console.log(`[FIRE-GT-CTL] point DELETED id=${result.id}`);
    OK(res, 'Đã xóa điểm.', result);
};

module.exports = {
    createZone, bulkZone, listZones, deleteZone,
    createPoint, bulkPoint, listPoints, deletePoint,
};
