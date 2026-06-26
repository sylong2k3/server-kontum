'use strict';

const svc = require('../services/weather.service');
const { OK } = require('../core/success.response');
const { t } = require('../utils/i18n.util');

// Suy ra base URL công khai để build tile URL template.
const getBaseUrl = (req) => {
    if (process.env.APP_URL) { return process.env.APP_URL; }
    return `${req.protocol}://${req.get('host')}`;
};

// GET /api/v1/weather/layers?type=temp|rain|cloud|wind|pressure
const getLayers = async (req, res) => {
    const layers = svc.getLayers(req.query.type, getBaseUrl(req), req.lang);
    return OK(res, t('weather_layers_success', req.lang), { layers }, { count: layers.length });
};

// GET /api/v1/weather/point?lng=&lat=
const getPoint = async (req, res) => {
    const data = await svc.getPoint({
        lng:  Number(req.query.lng),
        lat:  Number(req.query.lat),
        lang: req.lang,
    });
    return OK(res, t('weather_point_success', req.lang), data);
};

// GET /api/v1/weather/wind-grid?bbox=&grid=
const getWindGrid = async (req, res) => {
    const data = await svc.getWindGrid({
        bbox: req.query.bbox,
        grid: req.query.grid,
        lang: req.lang,
    });
    return OK(res, t('weather_wind_grid_success', req.lang), data);
};

// GET /api/v1/weather/tiles/:type/:z/:x/:y.png — proxy tile từ OpenWeather
const proxyTile = async (req, res) => {
    const { type, z, x } = req.params;
    const y = String(req.params.y).replace(/\.png$/i, '');

    const { buffer, contentType } = await svc.getTile({
        type,
        z:    Number(z),
        x:    Number(x),
        y:    Number(y),
        lang: req.lang,
    });

    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=600'); // 10 phút
    return res.send(buffer);
};

// POST /api/v1/weather/refresh — làm nóng cache thủ công (admin)
const refresh = async (req, res) => {
    const result = await svc.refreshCache({ lang: req.lang });
    return OK(res, t('weather_refresh_success', req.lang), result);
};

module.exports = {
    getLayers,
    getPoint,
    getWindGrid,
    proxyTile,
    refresh,
};
