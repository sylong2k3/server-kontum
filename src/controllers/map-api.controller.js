'use strict';

const svc = require('../services/map-api.service');
const { OK, CREATED, OK_LIST } = require('../core/success.response');
const { t } = require('../utils/i18n.util');

// Bbox "minLng,minLat,maxLng,maxLat" → [number, number, number, number]
const parseBbox = (str) => (str ? String(str).split(',').map(Number) : null);

// ── Admin: quản lý api_key ───────────────────────────────────────────────────
const createKey = async (req, res) => {
    const { api, apiKey } = await svc.createKey(req.body, req.user, req.lang);
    return CREATED(res, t('map_api_created', req.lang), {
        api,
        apiKey, // CHỈ hiển thị một lần — yêu cầu lưu lại ngay.
        notice: req.lang === 'en'
            ? 'Store this api key now. It will not be shown again.'
            : 'Hãy lưu api key này ngay. Khoá sẽ không hiển thị lại.',
    });
};

const listKeys = async (req, res) => {
    const { page, limit, layer_id, is_active } = req.query;
    const offset = (page - 1) * limit;
    const { items, total } = await svc.listKeys({ limit, offset, layer_id, is_active }, req.lang);
    return OK_LIST(res, t('map_api_list_success', req.lang), items, { page, limit, total });
};

const getKey = async (req, res) => {
    const api = await svc.getKey(Number(req.params.id), req.lang);
    return OK(res, t('map_api_get_success', req.lang), api);
};

const updateKey = async (req, res) => {
    const api = await svc.updateKey(Number(req.params.id), req.body, req.user, req.lang);
    return OK(res, t('map_api_updated', req.lang), api);
};

const regenerateKey = async (req, res) => {
    const { api, apiKey } = await svc.regenerateKey(Number(req.params.id), req.user, req.lang);
    return OK(res, t('map_api_regenerated', req.lang), {
        api,
        apiKey,
        notice: req.lang === 'en'
            ? 'A new api key was generated. The old key is now invalid.'
            : 'Đã tạo api key mới. Khoá cũ đã bị vô hiệu.',
    });
};

const deleteKey = async (req, res) => {
    await svc.deleteKey(Number(req.params.id), req.user, req.lang);
    return OK(res, t('map_api_deleted', req.lang), { id: Number(req.params.id) });
};

// ── Consumer: khai thác dữ liệu bằng api_key ─────────────────────────────────
const getLayerMeta = async (req, res) => {
    return OK(res, t('map_api_layer_meta_success', req.lang), svc.getLayerMeta(req.mapApi));
};

const getFeatures = async (req, res) => {
    const result = await svc.getFeatures(
        req.mapApi,
        {
            bbox:   parseBbox(req.query.bbox),
            limit:  req.query.limit,
            offset: req.query.offset,
        },
        req.lang,
    );
    return OK(res, t('map_api_features_success', req.lang), result);
};

module.exports = {
    createKey,
    listKeys,
    getKey,
    updateKey,
    regenerateKey,
    deleteKey,
    getLayerMeta,
    getFeatures,
};
