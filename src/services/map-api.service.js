'use strict';

/**
 * Map API Service (US-025) — chia sẻ dữ liệu lớp GIS qua api_key.
 *
 * Key sinh ngẫu nhiên ~64 ký tự (base64url của 48 byte), CHỈ trả về 1 lần khi
 * tạo/xoay. DB chỉ lưu sha256(key) + 12 ký tự đầu (prefix) để tra cứu nhanh.
 */

const crypto = require('crypto');
const repo = require('../repositories/map-api.repository');
const layerRepo = require('../repositories/map-layer.repository');
const { hashToken } = require('../utils/cryptoHelper.util');
const { Api400Error, Api401Error, Api403Error, Api404Error } = require('../core/error.response');
const { t } = require('../utils/i18n.util');

const KEY_LABEL  = 'mapk';
const PREFIX_LEN = 12;
const MAX_LIMIT  = 5000;

// ── Sinh & bóc tách key ─────────────────────────────────────────────────────
const generateRawKey = () => {
    // 48 byte → ~64 ký tự base64url. Thêm nhãn để nhận diện.
    const secret = crypto.randomBytes(48).toString('base64url');
    return `${KEY_LABEL}_${secret}`;
};

const keyParts = (rawKey) => ({
    prefix: rawKey.slice(0, PREFIX_LEN),
    last4:  rawKey.slice(-4),
    hash:   hashToken(rawKey),
});

const normalizeScope = (scope = {}) => ({
    read:         scope.read !== false,
    rate_per_min: Number(scope.rate_per_min) > 0 ? Math.floor(Number(scope.rate_per_min)) : 60,
    ...(scope.bbox_limit != null ? { bbox_limit: Number(scope.bbox_limit) } : {}),
});

// ══════════════════════════════════════════════════════════════════════════════
//  ADMIN — CRUD
// ══════════════════════════════════════════════════════════════════════════════
const createKey = async ({ name, layer_id, scope, is_active = true, expires_at = null }, user, lang) => {
    // Xác nhận layer tồn tại.
    const layerRow = await findLayerById(layer_id, lang);

    const rawKey = generateRawKey();
    const { prefix, last4, hash } = keyParts(rawKey);

    const api = await repo.create({
        name,
        layer_id:   layerRow.id,
        key_prefix: prefix,
        key_hash:   hash,
        key_last4:  last4,
        scope:      normalizeScope(scope),
        is_active,
        expires_at,
        created_by: user?.id || null,
    });

    // Trả raw key DUY NHẤT một lần.
    return { api, apiKey: rawKey };
};

const listKeys = async (filters, lang) => repo.list(filters);

const getKey = async (id, lang) => {
    const api = await repo.findById(id);
    if (!api) { throw new Api404Error(t('map_api_not_found', lang), ['MAP_API_NOT_FOUND']); }
    return api;
};

const updateKey = async (id, fields, user, lang) => {
    const existing = await repo.findById(id);
    if (!existing) { throw new Api404Error(t('map_api_not_found', lang), ['MAP_API_NOT_FOUND']); }
    const patch = { ...fields };
    if (patch.scope) { patch.scope = normalizeScope(patch.scope); }
    const updated = await repo.update(id, patch);
    return updated;
};

const regenerateKey = async (id, user, lang) => {
    const existing = await repo.findById(id);
    if (!existing) { throw new Api404Error(t('map_api_not_found', lang), ['MAP_API_NOT_FOUND']); }
    const rawKey = generateRawKey();
    const { prefix, last4, hash } = keyParts(rawKey);
    await repo.rotateKey(id, { key_prefix: prefix, key_hash: hash, key_last4: last4 });
    const api = await repo.findById(id);
    return { api, apiKey: rawKey };
};

const deleteKey = async (id, user, lang) => {
    const removed = await repo.remove(id);
    if (!removed) { throw new Api404Error(t('map_api_not_found', lang), ['MAP_API_NOT_FOUND']); }
    return removed;
};

const findLayerById = async (layerId, lang) => {
    // layerRepo không có findById nên dùng truy vấn nhẹ qua findByCode không phù hợp;
    // tận dụng list/registry: tạo helper inline.
    const db = require('../configs/database');
    const { rows } = await db.query(
        `SELECT id, code, name_vi, is_active FROM gis.layer_registry WHERE id = $1`,
        [layerId],
    );
    if (!rows[0]) { throw new Api400Error(t('map_api_layer_not_found', lang), ['LAYER_NOT_FOUND']); }
    return rows[0];
};

// ══════════════════════════════════════════════════════════════════════════════
//  XÁC THỰC KEY (dùng bởi middleware)
// ══════════════════════════════════════════════════════════════════════════════
const authenticate = async (rawKey, lang) => {
    if (!rawKey || typeof rawKey !== 'string' || rawKey.length < PREFIX_LEN + 4) {
        throw new Api401Error(t('map_api_invalid_key', lang), ['INVALID_API_KEY']);
    }
    const prefix = rawKey.slice(0, PREFIX_LEN);
    const row = await repo.findByPrefixWithSecret(prefix);
    if (!row) {
        throw new Api401Error(t('map_api_invalid_key', lang), ['INVALID_API_KEY']);
    }

    // So hash an toàn theo thời gian hằng số.
    const incoming = Buffer.from(hashToken(rawKey));
    const stored   = Buffer.from(row.key_hash);
    if (incoming.length !== stored.length || !crypto.timingSafeEqual(incoming, stored)) {
        throw new Api401Error(t('map_api_invalid_key', lang), ['INVALID_API_KEY']);
    }

    if (!row.is_active) {
        throw new Api403Error(t('map_api_key_disabled', lang), ['API_KEY_DISABLED']);
    }
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
        throw new Api403Error(t('map_api_key_expired', lang), ['API_KEY_EXPIRED']);
    }
    if (!row.layer_is_active) {
        throw new Api403Error(t('map_api_layer_inactive', lang), ['LAYER_INACTIVE']);
    }
    return row;
};

/** Đảm bảo scope cho phép hành động (mặc định 'read'). */
const assertScope = (api, action = 'read', lang = 'vi') => {
    const scope = api.scope || {};
    if (action === 'read' && scope.read !== true) {
        throw new Api403Error(t('map_api_scope_denied', lang), ['SCOPE_DENIED']);
    }
    return true;
};

// ══════════════════════════════════════════════════════════════════════════════
//  DỮ LIỆU (consumer dùng key)
// ══════════════════════════════════════════════════════════════════════════════
const getLayerMeta = (api) => ({
    code:          api.layer_code,
    name:          api.layer_name_vi,
    geometry_type: api.geometry_type,
    epsg_code:     api.epsg_code,
});

const bboxArea = (bbox) => Math.abs((bbox[2] - bbox[0]) * (bbox[3] - bbox[1]));

const getFeatures = async (api, { bbox = null, limit = 500, offset = 0 }, lang) => {
    assertScope(api, 'read', lang);

    const scope = api.scope || {};
    if (scope.bbox_limit != null) {
        if (!bbox) {
            throw new Api400Error(t('map_api_bbox_required', lang), ['BBOX_REQUIRED']);
        }
        if (bboxArea(bbox) > Number(scope.bbox_limit)) {
            throw new Api403Error(
                t('map_api_bbox_too_large', lang, { max: scope.bbox_limit }),
                ['BBOX_TOO_LARGE'],
            );
        }
    }

    const cappedLimit = Math.min(Number(limit) || 500, MAX_LIMIT);
    // Lấy thêm 1 bản ghi để biết còn dữ liệu (hasMore) mà không cần COUNT(*).
    const layer = {
        schema_name:     api.schema_name,
        table_name:      api.table_name,
        geometry_column: api.geometry_column,
        epsg_code:       api.epsg_code,
    };
    const rows = await layerRepo.findFeaturesAsGeoJSON(layer, {
        bbox,
        limit: cappedLimit + 1,
        offset: Number(offset) || 0,
    });

    const hasMore = rows.length > cappedLimit;
    const features = hasMore ? rows.slice(0, cappedLimit) : rows;

    return {
        type: 'FeatureCollection',
        layer: getLayerMeta(api),
        features,
        metadata: {
            returned: features.length,
            limit:    cappedLimit,
            offset:   Number(offset) || 0,
            hasMore,
        },
    };
};

module.exports = {
    createKey,
    listKeys,
    getKey,
    updateKey,
    regenerateKey,
    deleteKey,
    authenticate,
    assertScope,
    getFeatures,
    getLayerMeta,
};
