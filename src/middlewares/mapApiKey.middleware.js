'use strict';

/**
 * Middleware xác thực api_key cho API chia sẻ dữ liệu bản đồ (US-025).
 *
 *   - authenticateMapApiKey : đọc header X-Map-Api-Key → xác thực → req.mapApi.
 *   - mapApiRateLimit       : giới hạn theo scope.rate_per_min (cửa sổ 1 phút).
 *   - mapApiReadOnly        : chỉ cho phép GET (doc 14 §C).
 *
 * Lỗi: 401 INVALID_API_KEY | 403 SCOPE_DENIED/... | 429 RATE_LIMIT_EXCEEDED.
 */

const mapApiService = require('../services/map-api.service');
const mapApiRepo = require('../repositories/map-api.repository');
const { Api401Error, Api403Error, BaseError } = require('../core/error.response');
const { StatusCodes } = require('../core/http-status-code');
const { t } = require('../utils/i18n.util');

const HEADER = 'x-map-api-key';
const WINDOW_MS = 60 * 1000;

// Bộ đếm cửa sổ cố định 1 phút trong bộ nhớ: apiId → { count, resetAt }.
// Lưu ý: đây là per-process — nếu chạy nhiều worker (PM2 cluster), mỗi worker
// có bucket riêng và giới hạn sẽ nhân lên theo số worker. Cần Redis khi scale.
const buckets = new Map();

// Dọn định kỳ các bucket đã hết hạn để tránh rò rỉ bộ nhớ.
const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, b] of buckets) {
        if (b.resetAt <= now) { buckets.delete(key); }
    }
}, WINDOW_MS);
if (typeof cleanup.unref === 'function') { cleanup.unref(); }

const extractKey = (req) =>
    req.headers[HEADER] ||
    req.headers['x-api-key'] ||
    null;

const buildRateError = (req, retryAfter) =>
    new BaseError(
        t('map_api_rate_limited', req.lang, { retry: retryAfter }),
        StatusCodes.TOO_MANY_REQUESTS,
        ['RATE_LIMIT_EXCEEDED'],
        true,
    );

const authenticateMapApiKey = async (req, res, next) => {
    try {
        const rawKey = extractKey(req);
        if (!rawKey) {
            throw new Api401Error(t('map_api_key_required', req.lang), ['INVALID_API_KEY']);
        }
        const api = await mapApiService.authenticate(rawKey, req.lang);
        req.mapApi = api;
        next();
    } catch (err) {
        next(err);
    }
};

const mapApiRateLimit = (req, res, next) => {
    const api = req.mapApi;
    if (!api) { return next(new Api401Error(t('map_api_invalid_key', req.lang), ['INVALID_API_KEY'])); }

    const limit = Number(api.scope?.rate_per_min) > 0 ? Math.floor(Number(api.scope.rate_per_min)) : 60;
    const now = Date.now();

    let bucket = buckets.get(api.id);
    if (!bucket || bucket.resetAt <= now) {
        bucket = { count: 0, resetAt: now + WINDOW_MS };
        buckets.set(api.id, bucket);
    }
    bucket.count += 1;

    res.set('X-RateLimit-Limit', String(limit));
    res.set('X-RateLimit-Remaining', String(Math.max(0, limit - bucket.count)));
    res.set('X-RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));

    if (bucket.count > limit) {
        const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
        res.set('Retry-After', String(retryAfter));
        return next(buildRateError(req, retryAfter));
    }

    // Ghi nhận sử dụng chỉ sau khi rate-limit pass — request bị chặn không được tính.
    mapApiRepo.touchUsage(api.id).catch(() => { /* ignore */ });

    next();
};

const mapApiReadOnly = (req, res, next) => {
    if (req.method !== 'GET') {
        return next(new Api403Error(t('map_api_read_only', req.lang), ['METHOD_NOT_ALLOWED']));
    }
    next();
};

module.exports = {
    authenticateMapApiKey,
    mapApiRateLimit,
    mapApiReadOnly,
};
