'use strict';

/**
 * Client gọi API thời tiết ngoài:
 *   - OpenWeather : current weather (point) + tile raster.
 *   - Open-Meteo  : lưới gió (wind grid) phục vụ animation streamlines.
 *
 * Dùng global fetch (Node 18+) kèm AbortController để timeout.
 */

const cfg = require('../configs/weather');

// ── HTTP helper ─────────────────────────────────────────────────────────────
const fetchWithTimeout = async (url, { timeoutMs = cfg.HTTP_TIMEOUT_MS, ...opts } = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { signal: controller.signal, ...opts });
    } finally {
        clearTimeout(timer);
    }
};

const fetchJson = async (url, opts) => {
    const res = await fetchWithTimeout(url, opts);
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Upstream ${res.status} ${res.statusText} ${body.slice(0, 200)}`);
    }
    return res.json();
};

// ── OpenWeather: current weather tại điểm ───────────────────────────────────
const getCurrentWeather = async (lng, lat) => {
    const url = `${cfg.OPENWEATHER_BASE_URL}/weather`
        + `?lat=${lat}&lon=${lng}`
        + `&appid=${cfg.OPENWEATHER_API_KEY}`
        + `&units=${cfg.UNITS}&lang=${cfg.LANG}`;

    const data = await fetchJson(url);

    return {
        observedAt: data.dt ? new Date(data.dt * 1000).toISOString() : null,
        coord:      { lng: data.coord?.lon ?? lng, lat: data.coord?.lat ?? lat },
        location:   data.name || null,
        temp:       data.main?.temp ?? null,
        feelsLike:  data.main?.feels_like ?? null,
        tempMin:    data.main?.temp_min ?? null,
        tempMax:    data.main?.temp_max ?? null,
        humidity:   data.main?.humidity ?? null,
        pressure:   data.main?.pressure ?? null,
        clouds:     data.clouds?.all ?? null,
        rain1h:     data.rain?.['1h'] ?? 0,
        snow1h:     data.snow?.['1h'] ?? 0,
        visibility: data.visibility ?? null,
        wind: {
            speed: data.wind?.speed ?? null,
            deg:   data.wind?.deg ?? null,
            gust:  data.wind?.gust ?? null,
        },
        weather: data.weather?.[0]
            ? {
                id:          data.weather[0].id,
                main:        data.weather[0].main,
                description: data.weather[0].description,
                icon:        data.weather[0].icon,
            }
            : null,
        units: cfg.UNITS,
    };
};

// ── OpenWeather: tile raster ────────────────────────────────────────────────
const buildTileUrl = (layer, z, x, y) =>
    `${cfg.OPENWEATHER_TILE_URL}/${layer}/${z}/${x}/${y}.png?appid=${cfg.OPENWEATHER_API_KEY}`;

/** Tải 1 tile PNG từ OpenWeather (để backend proxy, không lộ API key ra FE). */
const fetchTile = async (layer, z, x, y) => {
    const res = await fetchWithTimeout(buildTileUrl(layer, z, x, y));
    if (!res.ok) {
        throw new Error(`Tile upstream ${res.status} ${res.statusText}`);
    }
    const arrayBuffer = await res.arrayBuffer();
    return {
        buffer:      Buffer.from(arrayBuffer),
        contentType: res.headers.get('content-type') || 'image/png',
    };
};

// ── Open-Meteo: lưới gió ────────────────────────────────────────────────────
/**
 * Sinh lưới NxN điểm trong bbox và lấy tốc/hướng gió tại từng điểm,
 * rồi quy đổi sang thành phần (u, v) phục vụ animation streamlines.
 *
 * Quy ước khí tượng: wind_direction là hướng GIÓ THỔI TỚI TỪ (degrees).
 *   u (đông-tây)  = -speed * sin(dir)
 *   v (bắc-nam)   = -speed * cos(dir)
 *
 * @param {number[]} bbox [minLng, minLat, maxLng, maxLat]
 * @param {number}   size số điểm mỗi chiều
 */
const getWindGrid = async (bbox, size = cfg.WIND_GRID_SIZE) => {
    const [minLng, minLat, maxLng, maxLat] = bbox;
    const n = Math.max(2, Math.min(size, cfg.WIND_GRID_MAX));

    const lats = [];
    const lngs = [];
    for (let i = 0; i < n; i++) {
        const fy = n === 1 ? 0 : i / (n - 1);
        const lat = minLat + (maxLat - minLat) * fy;
        for (let j = 0; j < n; j++) {
            const fx = n === 1 ? 0 : j / (n - 1);
            const lng = minLng + (maxLng - minLng) * fx;
            lats.push(Number(lat.toFixed(4)));
            lngs.push(Number(lng.toFixed(4)));
        }
    }

    const url = `${cfg.OPEN_METEO_URL}`
        + `?latitude=${lats.join(',')}&longitude=${lngs.join(',')}`
        + `&current=wind_speed_10m,wind_direction_10m`
        + `&wind_speed_unit=ms`;

    const data = await fetchJson(url);
    // Open-Meteo trả mảng khi nhiều toạ độ, object đơn khi 1 toạ độ.
    const entries = Array.isArray(data) ? data : [data];

    if (entries.length !== lats.length) throw new Error('Wind grid response cardinality mismatch');
    const fetchedAt = new Date().toISOString();
    const points = entries.map((entry, index) => {
        const rawSpeed = entry?.current?.wind_speed_10m;
        const rawDeg = entry?.current?.wind_direction_10m;
        const speed = Number.isFinite(rawSpeed) && rawSpeed >= 0 ? rawSpeed : null;
        const deg = Number.isFinite(rawDeg) && rawDeg >= 0 && rawDeg <= 360 ? rawDeg : null;
        const valid = speed !== null && (speed === 0 || deg !== null);
        const rad = deg === null ? null : (deg * Math.PI) / 180;
        const rawTime = entry?.current?.time;
        const parsedTime = rawTime ? Date.parse(/Z$|[+-]\d{2}:\d{2}$/.test(rawTime) ? rawTime : rawTime + 'Z') : NaN;
        const observedAt = Number.isFinite(parsedTime) ? new Date(parsedTime).toISOString() : null;
        return {
            lat: Number.isFinite(entry?.latitude) ? entry.latitude : lats[index],
            lng: Number.isFinite(entry?.longitude) ? entry.longitude : lngs[index],
            speed, deg, valid, observedAt,
            observationAgeSeconds: observedAt ? Math.round((Date.parse(fetchedAt) - parsedTime) / 1000) : null,
            u: !valid ? null : speed === 0 ? 0 : Number((-speed * Math.sin(rad)).toFixed(3)),
            v: !valid ? null : speed === 0 ? 0 : Number((-speed * Math.cos(rad)).toFixed(3)),
        };
    });
    const times = points.map(p => p.observedAt).filter(Boolean).sort();
    return {
        gridSize: n, bbox, unit: 'm/s',
        observedAt: times.length === points.length ? times[0] : null,
        fetchedAt, expectedPointCount: lats.length,
        validPointCount: points.filter(p => p.valid).length,
        freshness: { oldestObservedAt: times[0] || null, newestObservedAt: times.at(-1) || null,
            missingTimestampCount: points.length - times.length },
        points,
    };
};

module.exports = {
    getCurrentWeather,
    buildTileUrl,
    fetchTile,
    getWindGrid,
};
