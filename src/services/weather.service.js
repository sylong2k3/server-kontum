'use strict';

/**
 * Weather Service (EP-05).
 *
 * Chiến lược cache: lưu gis.weather_cache theo giờ để giảm gọi API ngoài.
 * Khi API ngoài lỗi → fallback về bản ghi cache gần nhất kèm cờ stale=true,
 * để FE vẫn hiển thị được dữ liệu (kèm nhãn thời điểm).
 */

const cfg    = require('../configs/weather');
const owm    = require('../utils/openweather.client');
const repo   = require('../repositories/weather.repository');
const { Api400Error, BusinessLogicError } = require('../core/error.response');
const { StatusCodes } = require('../core/http-status-code');
const { t } = require('../utils/i18n.util');

// ── Helpers ─────────────────────────────────────────────────────────────────
const round = (n, d = 2) => Number(Number(n).toFixed(d));

const requireOpenWeather = (lang) => {
    if (!cfg.isOpenWeatherConfigured()) {
        throw new Api400Error(t('weather_not_configured', lang), ['WEATHER_NOT_CONFIGURED']);
    }
};

const parseBbox = (bboxStr, lang) => {
    if (!bboxStr) { return cfg.KONTUM_BBOX; }
    const parts = String(bboxStr).split(',').map(Number);
    if (parts.length !== 4 || parts.some(Number.isNaN)) {
        throw new Api400Error(t('weather_invalid_bbox', lang), ['INVALID_BBOX']);
    }
    const [minLng, minLat, maxLng, maxLat] = parts;
    if (minLng >= maxLng || minLat >= maxLat) {
        throw new Api400Error(t('weather_invalid_bbox', lang), ['INVALID_BBOX']);
    }
    return parts;
};

// ══════════════════════════════════════════════════════════════════════════════
//  LAYERS — trả URL template tile (proxy qua backend, không lộ API key)
// ══════════════════════════════════════════════════════════════════════════════
const getLayers = (type, baseUrl, lang) => {
    requireOpenWeather(lang);

    if (type && !cfg.WEATHER_TYPES.includes(type)) {
        throw new Api400Error(
            t('weather_invalid_type', lang, { types: cfg.WEATHER_TYPES.join(', ') }),
            ['INVALID_TYPE'],
        );
    }

    const types = type ? [type] : cfg.WEATHER_TYPES;
    const base  = (baseUrl || process.env.APP_URL || '').replace(/\/$/, '');

    return types.map((tp) => ({
        type:        tp,
        owmLayer:    cfg.TILE_LAYERS[tp],
        // FE thay {z}/{x}/{y} khi render (OpenLayers/Mapbox/Leaflet raster source).
        tileUrl:     `${base}/api/v1/weather/tiles/${tp}/{z}/{x}/{y}.png`,
        attribution: 'OpenWeather',
    }));
};

// ══════════════════════════════════════════════════════════════════════════════
//  TILE PROXY — backend tải tile rồi trả về (giữ API key ở server)
// ══════════════════════════════════════════════════════════════════════════════
const getTile = async ({ type, z, x, y, lang }) => {
    requireOpenWeather(lang);
    const layer = cfg.TILE_LAYERS[type];
    if (!layer) {
        throw new Api400Error(
            t('weather_invalid_type', lang, { types: cfg.WEATHER_TYPES.join(', ') }),
            ['INVALID_TYPE'],
        );
    }
    return owm.fetchTile(layer, z, x, y);
};

// ══════════════════════════════════════════════════════════════════════════════
//  POINT — thời tiết hiện tại tại điểm (popup), cache theo lưới ~1km
// ══════════════════════════════════════════════════════════════════════════════
const getPoint = async ({ lng, lat, lang }) => {
    requireOpenWeather(lang);

    const rLng = round(lng);
    const rLat = round(lat);
    const cacheKey = `point:${rLng},${rLat}`;

    const fresh = await repo.getFresh(cacheKey);
    if (fresh) {
        return { ...fresh.payload, cached: true, stale: false, fetchedAt: fresh.fetched_at };
    }

    try {
        const data    = await owm.getCurrentWeather(rLng, rLat);
        const expires = new Date(Date.now() + cfg.POINT_TTL_SECONDS * 1000);
        await repo.upsert({
            cache_key:   cacheKey,
            data_type:   'point',
            lng:         rLng,
            lat:         rLat,
            payload:     data,
            source:      'openweather',
            observed_at: data.observedAt,
            expires_at:  expires,
        });
        return { ...data, cached: false, stale: false };
    } catch (err) {
        // Fallback: bản ghi cache gần nhất (kể cả hết hạn).
        const latest = await repo.getLatest(cacheKey);
        if (latest) {
            return { ...latest.payload, cached: true, stale: true, fetchedAt: latest.fetched_at };
        }
        throw new BusinessLogicError(
            t('weather_upstream_failed', lang, { msg: err.message }),
            ['WEATHER_UPSTREAM_FAILED'],
            StatusCodes.SERVICE_UNAVAILABLE,
        );
    }
};

// ══════════════════════════════════════════════════════════════════════════════
//  WIND GRID — lưới gió (Open-Meteo, không cần OpenWeather key)
// ══════════════════════════════════════════════════════════════════════════════
const getWindGrid = async ({ bbox, grid, lang }) => {
    const box  = parseBbox(bbox, lang);
    const size = grid ? Math.max(2, Math.min(Number(grid), cfg.WIND_GRID_MAX)) : cfg.WIND_GRID_SIZE;

    // Cache theo bbox đã làm tròn + kích thước lưới.
    const keyBox   = box.map((n) => round(n, 3)).join(',');
    const cacheKey = `wind_grid:${keyBox}:${size}`;

    const fresh = await repo.getFresh(cacheKey);
    if (fresh) {
        return { ...fresh.payload, cached: true, stale: false, fetchedAt: fresh.fetched_at };
    }

    try {
        const data    = await owm.getWindGrid(box, size);
        const expires = new Date(Date.now() + cfg.WIND_TTL_SECONDS * 1000);
        await repo.upsert({
            cache_key:   cacheKey,
            data_type:   'wind_grid',
            bbox:        box,
            payload:     data,
            source:      'open-meteo',
            observed_at: data.observedAt,
            expires_at:  expires,
        });
        return { ...data, cached: false, stale: false };
    } catch (err) {
        const latest = await repo.getLatest(cacheKey);
        if (latest) {
            return { ...latest.payload, cached: true, stale: true, fetchedAt: latest.fetched_at };
        }
        throw new BusinessLogicError(
            t('weather_upstream_failed', lang, { msg: err.message }),
            ['WEATHER_UPSTREAM_FAILED'],
            StatusCodes.SERVICE_UNAVAILABLE,
        );
    }
};

// ══════════════════════════════════════════════════════════════════════════════
//  REFRESH — làm nóng cache (cron + admin)
// ══════════════════════════════════════════════════════════════════════════════
const refreshCache = async ({ lang = 'vi' } = {}) => {
    const result = { point: false, windGrid: false, errors: [] };
    const [minLng, minLat, maxLng, maxLat] = cfg.KONTUM_BBOX;
    const centerLng = round((minLng + maxLng) / 2);
    const centerLat = round((minLat + maxLat) / 2);

    // 1) Warm wind grid (Open-Meteo, không cần key) cho toàn bbox Kon Tum.
    try {
        const data    = await owm.getWindGrid(cfg.KONTUM_BBOX, cfg.WIND_GRID_SIZE);
        const keyBox   = cfg.KONTUM_BBOX.map((n) => round(n, 3)).join(',');
        await repo.upsert({
            cache_key:   `wind_grid:${keyBox}:${cfg.WIND_GRID_SIZE}`,
            data_type:   'wind_grid',
            bbox:        cfg.KONTUM_BBOX,
            payload:     data,
            source:      'open-meteo',
            observed_at: data.observedAt,
            expires_at:  new Date(Date.now() + cfg.WIND_TTL_SECONDS * 1000),
        });
        result.windGrid = true;
    } catch (err) {
        result.errors.push(`wind_grid: ${err.message}`);
    }

    // 2) Warm point tại trung tâm tỉnh (chỉ khi có OpenWeather key).
    if (cfg.isOpenWeatherConfigured()) {
        try {
            const data = await owm.getCurrentWeather(centerLng, centerLat);
            await repo.upsert({
                cache_key:   `point:${centerLng},${centerLat}`,
                data_type:   'point',
                lng:         centerLng,
                lat:         centerLat,
                payload:     data,
                source:      'openweather',
                observed_at: data.observedAt,
                expires_at:  new Date(Date.now() + cfg.POINT_TTL_SECONDS * 1000),
            });
            result.point = true;
        } catch (err) {
            result.errors.push(`point: ${err.message}`);
        }
    } else {
        result.errors.push('point: OPENWEATHER_API_KEY not configured');
    }

    return result;
};

module.exports = {
    getLayers,
    getTile,
    getPoint,
    getWindGrid,
    refreshCache,
};
