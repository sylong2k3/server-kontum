'use strict';

/**
 * Cấu hình module Thời tiết (EP-05).
 *
 * Nguồn dữ liệu:
 *   - OpenWeather : tile raster (nhiệt/mưa/mây/gió) + current weather tại điểm.
 *   - Open-Meteo  : lưới gió (wind grid) cho animation streamlines — không cần key.
 *
 * Tham chiếu thiết kế: docs/modules/08-weather-satellite-design.md §A.
 */

require('dotenv').config();

const OPENWEATHER_API_KEY  = process.env.OPENWEATHER_API_KEY || '';
const OPENWEATHER_BASE_URL = process.env.OPENWEATHER_BASE_URL || 'https://api.openweathermap.org/data/2.5';
const OPENWEATHER_TILE_URL = process.env.OPENWEATHER_TILE_URL || 'https://tile.openweathermap.org/map';
const OPEN_METEO_URL       = process.env.OPEN_METEO_URL || 'https://api.open-meteo.com/v1/forecast';

// Ánh xạ "type" công khai → tên lớp tile của OpenWeather.
const TILE_LAYERS = {
    temp:     'temp_new',
    rain:     'precipitation_new',
    cloud:    'clouds_new',
    wind:     'wind_new',
    pressure: 'pressure_new',
};

const WEATHER_TYPES = Object.keys(TILE_LAYERS);

// Bbox mặc định tỉnh Kon Tum [minLng, minLat, maxLng, maxLat] — dùng để warm cache.
const KONTUM_BBOX = (process.env.WEATHER_DEFAULT_BBOX || '107.0,13.8,108.6,15.5')
    .split(',')
    .map(Number);

const POINT_TTL_SECONDS = parseInt(process.env.WEATHER_POINT_TTL_SECONDS, 10) || 3600;
const WIND_TTL_SECONDS  = parseInt(process.env.WEATHER_WIND_TTL_SECONDS, 10) || 3600;
const TILE_TTL_SECONDS  = parseInt(process.env.WEATHER_TILE_TTL_SECONDS, 10) || 600;
const HTTP_TIMEOUT_MS   = parseInt(process.env.WEATHER_HTTP_TIMEOUT_MS, 10) || 10000;

const UNITS = process.env.WEATHER_UNITS || 'metric'; // metric → °C, m/s
const LANG  = process.env.WEATHER_LANG || 'vi';

// Kích thước lưới gió mặc định (NxN điểm). Giới hạn để tránh quá nhiều điểm gọi Open-Meteo.
const WIND_GRID_SIZE = parseInt(process.env.WEATHER_WIND_GRID_SIZE, 10) || 8;
const WIND_GRID_MAX  = parseInt(process.env.WEATHER_WIND_GRID_MAX, 10) || 16;

const CRON = process.env.WEATHER_CRON || '0 * * * *'; // mỗi giờ

// OpenWeather cần API key; Open-Meteo (wind grid) thì không.
const isOpenWeatherConfigured = () => Boolean(OPENWEATHER_API_KEY);

module.exports = {
    OPENWEATHER_API_KEY,
    OPENWEATHER_BASE_URL,
    OPENWEATHER_TILE_URL,
    OPEN_METEO_URL,
    TILE_LAYERS,
    WEATHER_TYPES,
    KONTUM_BBOX,
    POINT_TTL_SECONDS,
    WIND_TTL_SECONDS,
    TILE_TTL_SECONDS,
    HTTP_TIMEOUT_MS,
    UNITS,
    LANG,
    WIND_GRID_SIZE,
    WIND_GRID_MAX,
    CRON,
    isOpenWeatherConfigured,
};
