'use strict';

const svc  = require('../services/satellite.service');
const { OK, CREATED } = require('../core/success.response');
const { t } = require('../utils/i18n.util');

// ── POST /satellite/rgb ───────────────────────────────────────────────────────
const getRgb = async (req, res) => {
    const result = await svc.getRgb(req.body);
    OK(res, t('get_detail_success', req.lang), result);
};

// ── POST /satellite/ndvi ──────────────────────────────────────────────────────
const getNdvi = async (req, res) => {
    const result = await svc.getNdvi(req.body);
    OK(res, t('get_detail_success', req.lang), result);
};

// ── POST /satellite/heat-map ──────────────────────────────────────────────────
const getHeatmap = async (req, res) => {
    const result = await svc.getHeatmap(req.body);
    OK(res, t('get_detail_success', req.lang), result);
};

// ── POST /satellite/classified ────────────────────────────────────────────────
const getClassified = async (req, res) => {
    const result = await svc.getClassified(req.body);
    OK(res, t('get_detail_success', req.lang), result);
};

// ── POST /satellite/compare ───────────────────────────────────────────────────
const getCompare = async (req, res) => {
    const result = await svc.getCompare(req.body);
    OK(res, t('get_detail_success', req.lang), result);
};

// ── GET /satellite/tiles/:resultId/:z/:x/:y ───────────────────────────────────
// Proxies GEE tiles server-side: hides GEE tokens from client, enables CORS.
const proxyTile = async (req, res) => {
    const { resultId, z, x, y } = req.params;
    await svc.streamTile(resultId, z, x, y, res);
};

// ── POST /satellite/publish ───────────────────────────────────────────────────
// Submit async GEE export task → GeoServer. Body: { resultId }
const publishToGeoServer = async (req, res) => {
    const { resultId } = req.body;
    if (!resultId) {
        return res.status(400).json({ message: 'resultId là bắt buộc.' });
    }
    const updated = await svc.publishResult(resultId);
    CREATED(res, 'Đã gửi tác vụ xuất GeoTIFF.', { result: updated });
};

module.exports = { getRgb, getNdvi, getHeatmap, getClassified, getCompare, proxyTile, publishToGeoServer };
