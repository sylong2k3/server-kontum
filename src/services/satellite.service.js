'use strict';

/**
 * Satellite Image Service — on-demand GEE tile generation + GeoServer publish.
 *
 * Flow:
 *   1. POST /satellite/{type}   → compute GEE image → return proxy tile URL (immediate)
 *   2. POST /satellite/publish  → submit GEE export task → GCS → MinIO → GeoServer (async)
 *   3. GET  /satellite/tiles/:id/:z/:x/:y → proxy GEE tile server-side (hides GEE tokens)
 *
 * All endpoints cache results in satellite.image_results.
 * Proxy URL format: /api/v1/satellite/tiles/{resultId}/{z}/{x}/{y}
 */

const crypto = require('crypto');
const { ee, initializeEarthEngine } = require('../configs/gge');
const {
    eeEval,
    getEeMapId,
    toEeGeometry,
    addIndices,
    maskS2FireRisk,
    maskLandsatC2,
    prepL57,
    prepL89,
    maskS2,
} = require('../utils/gee-satellite.util');
const { pollGeeTask, publishRasterToMinio } = require('../utils/gee-export.helper');
const repo      = require('../repositories/satellite.repository');
const geoserver = require('../utils/geoserver.client');
const { BusinessLogicError } = require('../core/error.response');
const { StatusCodes } = require('../core/http-status-code');

// MinIO bucket for satellite rasters.
const SATELLITE_MINIO_BUCKET = process.env.SATELLITE_MINIO_BUCKET || 'satellite-rasters';
const GCS_BUCKET             = process.env.GEE_GCS_BUCKET || '';
const GCS_KEY_FILE           = process.env.GOOGLE_APPLICATION_CREDENTIALS || '';
const EXPORT_SCALE_M         = parseInt(process.env.SATELLITE_EXPORT_SCALE_M, 10) || 30;

// ── Request normalization & caching helpers ───────────────────────────────────

function normalizeParams(raw) {
    return {
        imageType:   raw.imageType   || 'rgb',
        collection:  raw.collection  || null,
        cloudCover:  raw.cloudCover  != null ? Number(raw.cloudCover) : 50,
        startDate:   raw.startDate   || null,
        endDate:     raw.endDate     || null,
        startDate2:  raw.startDate2  || null,
        endDate2:    raw.endDate2    || null,
        geometry:    raw.geometry    || null,
    };
}

function hashParams(params) {
    const str = JSON.stringify({
        t: params.imageType, c: params.collection, cc: params.cloudCover,
        sd: params.startDate, ed: params.endDate,
        sd2: params.startDate2, ed2: params.endDate2,
        g: params.geometry,
    });
    return crypto.createHash('sha256').update(str).digest('hex');
}

function buildProxyUrl(resultId) {
    const base = (process.env.APP_URL || '').replace(/\/$/, '');
    return `${base}/api/v1/satellite/tiles/${resultId}/{z}/{x}/{y}`;
}

// ── Shared collection builder ─────────────────────────────────────────────────

function buildCollection(region, startDate, endDate, collection, cloudCover) {
    const useS2      = !collection || collection.toUpperCase() === 'S2';
    const useLandsat = !collection || collection.toUpperCase() === 'LANDSAT';

    let col = ee.ImageCollection([]);

    if (useLandsat) {
        const l8 = ee.ImageCollection('LANDSAT/LC08/C02/T1_L2')
            .filterBounds(region).filterDate(startDate, endDate)
            .map(maskLandsatC2).map(prepL89);
        const l9 = ee.ImageCollection('LANDSAT/LC09/C02/T1_L2')
            .filterBounds(region).filterDate(startDate, endDate)
            .map(maskLandsatC2).map(prepL89);
        col = col.merge(l8).merge(l9);
    }

    if (useS2) {
        const s2 = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
            .filterBounds(region).filterDate(startDate, endDate)
            .filter(ee.Filter.lte('CLOUDY_PIXEL_PERCENTAGE', cloudCover))
            .map(maskS2);
        col = col.merge(s2);
    }

    return col;
}

// ── Area stats helper ─────────────────────────────────────────────────────────

async function computeAreaStats(classImage, region, nClasses, scale = 100) {
    const areaImg = ee.Image.pixelArea().divide(10000).addBands(classImage.rename('class'));
    const result  = await eeEval(
        areaImg.reduceRegion({
            reducer:    ee.Reducer.sum().group({ groupField: 1, groupName: 'class' }),
            geometry:   region,
            scale,
            bestEffort: true,
            maxPixels:  1e12,
            tileScale:  8,
        }),
    );
    const stats = {};
    for (const g of (result.groups || [])) {
        stats[g.class] = Math.round((g.sum || 0) * 100) / 100;
    }
    return stats;
}

// ── Per-type image builders ───────────────────────────────────────────────────
// Each builder returns: { eeImage, vizParams, stats, legend, metadata }

async function buildRgb(params, region) {
    const col       = buildCollection(region, params.startDate, params.endDate,
        params.collection, params.cloudCover);
    const imgCount  = await eeEval(col.size());
    const eeImage   = col.select(['red', 'green', 'blue']).median().clip(region);
    const vizParams = { bands: ['red', 'green', 'blue'], min: 0, max: 0.3 };
    return {
        eeImage,
        vizParams,
        stats:    { imageCount: imgCount },
        legend:   null,
        metadata: { startDate: params.startDate, endDate: params.endDate,
                    collection: params.collection || 'auto' },
    };
}

async function buildNdvi(params, region) {
    const col       = buildCollection(region, params.startDate, params.endDate,
        params.collection, params.cloudCover);
    const imgCount  = await eeEval(col.size());
    const composite = col.median().clip(region);
    const eeImage   = composite.normalizedDifference(['nir', 'red']).rename('NDVI');
    const vizParams = { bands: ['NDVI'], min: -0.2, max: 0.8,
        palette: ['#d73027', '#fee08b', '#ffffbf', '#90ee90', '#1a9641'] };

    const ndviThresh = parseFloat(params.ndviMinThresh) || 0.3;
    const areaStats  = await computeAreaStats(
        eeImage.gt(ndviThresh).selfMask().toByte(), region, 2);

    return {
        eeImage,
        vizParams,
        stats:  { imageCount: imgCount, vegetationHa: areaStats[1] || 0, ndviThreshUsed: ndviThresh },
        legend: [
            { color: '#d73027', label: 'NDVI < 0' },
            { color: '#fee08b', label: '0 – 0.2' },
            { color: '#ffffbf', label: '0.2 – 0.4' },
            { color: '#90ee90', label: '0.4 – 0.6' },
            { color: '#1a9641', label: '> 0.6 (rừng dày)' },
        ],
        metadata: { startDate: params.startDate, endDate: params.endDate },
    };
}

async function buildHeatmap(params, region) {
    const modis    = ee.ImageCollection('MODIS/061/MOD11A1')
        .filterBounds(region).filterDate(params.startDate, params.endDate);
    const imgCount = await eeEval(modis.size());
    const eeImage  = modis.select('LST_Day_1km').mean()
        .multiply(0.02).subtract(273.15).rename('LST_C').clip(region);
    const vizParams = { bands: ['LST_C'], min: 20, max: 45,
        palette: ['#313695', '#74add1', '#fed976', '#fd8d3c', '#d73027'] };

    const r = await eeEval(eeImage.reduceRegion({
        reducer: ee.Reducer.mean().combine(ee.Reducer.minMax(), null, true),
        geometry: region, scale: 1000, bestEffort: true, maxPixels: 1e12,
    }));

    return {
        eeImage,
        vizParams,
        stats: {
            imageCount: imgCount,
            lstMeanC:   Math.round((r.LST_C_mean || 0) * 100) / 100,
            lstMinC:    Math.round((r.LST_C_min  || 0) * 100) / 100,
            lstMaxC:    Math.round((r.LST_C_max  || 0) * 100) / 100,
        },
        legend: [
            { color: '#313695', label: '< 20°C' }, { color: '#74add1', label: '20–30°C' },
            { color: '#fed976', label: '30–35°C' }, { color: '#fd8d3c', label: '35–40°C' },
            { color: '#d73027', label: '> 40°C' },
        ],
        metadata: { source: 'MODIS MOD11A1', startDate: params.startDate, endDate: params.endDate },
    };
}

const CLASSIFIED_CLASSES = [
    { id: 0, name: 'Mặt nước',          color: '#0064ff' },
    { id: 1, name: 'Đô thị/Công trình', color: '#c0c0c0' },
    { id: 2, name: 'Đất trống',         color: '#d4a017' },
    { id: 3, name: 'Đất nông nghiệp',   color: '#ffeb3b' },
    { id: 4, name: 'Trảng cỏ/Cây bụi', color: '#a5d6a7' },
    { id: 5, name: 'Rừng trồng',        color: '#ff9800' },
    { id: 6, name: 'Rừng tự nhiên',     color: '#1b5e20' },
];

async function buildClassified(params, region) {
    const col       = buildCollection(region, params.startDate, params.endDate,
        params.collection, params.cloudCover);
    const imgCount  = await eeEval(col.size());
    const composite = col.median().clip(region);
    const indices   = addIndices(composite, '');
    const ndvi = indices.select('NDVI'); const ndwi = indices.select('NDWI');
    const mndwi = indices.select('MNDWI'); const ndbi = indices.select('NDBI');

    const water   = mndwi.gt(0.1).and(ndvi.lt(0.2));
    const urban   = ndbi.gt(0.0).and(ndvi.lt(0.15)).and(mndwi.lt(0.0));
    const bare    = ndvi.lt(0.12).and(mndwi.lt(0.05)).and(ndbi.gt(-0.1));
    const agri    = ndvi.gte(0.25).and(ndvi.lt(0.5)).and(ndbi.lt(0.05));
    const shrub   = ndvi.gte(0.12).and(ndvi.lt(0.4)).and(ndbi.lt(0.1));
    const planted = ndvi.gte(0.4).and(ndvi.lt(0.65));
    const forest  = ndvi.gte(0.65);

    const eeImage = ee.Image(0).byte()
        .where(shrub, 4).where(agri, 3).where(planted, 5).where(forest, 6)
        .where(bare,  2).where(urban, 1).where(water,  0)
        .rename('class').clip(region);

    const palette   = CLASSIFIED_CLASSES.map((c) => c.color);
    const vizParams = { bands: ['class'], min: 0, max: 6, palette };
    const areaStats = await computeAreaStats(eeImage, region, 7, 60);
    const areaByClass = CLASSIFIED_CLASSES.map((c) => ({
        classId: c.id, name: c.name, color: c.color, areaHa: areaStats[c.id] || 0,
    }));

    return {
        eeImage,
        vizParams,
        stats:  { imageCount: imgCount, areaByClass },
        legend: areaByClass.map((c) => ({ color: c.color, label: `${c.classId} – ${c.name}` })),
        metadata: { startDate: params.startDate, endDate: params.endDate, classCount: 7 },
    };
}

async function buildCompare(params, region) {
    const buildNdviImg = (sd, ed) =>
        buildCollection(region, sd, ed, params.collection, params.cloudCover)
            .median().clip(region).normalizedDifference(['nir', 'red']).rename('NDVI');

    const ndvi1 = buildNdviImg(params.startDate, params.endDate);
    const ndvi2 = buildNdviImg(params.startDate2, params.endDate2);
    const FOREST = 0.5;

    const forLoss  = ndvi1.gt(FOREST).and(ndvi2.gt(FOREST).not());
    const forGain  = ndvi1.gt(FOREST).not().and(ndvi2.gt(FOREST));
    const otherChg = ndvi1.subtract(ndvi2).abs().gt(0.15).and(forLoss.not()).and(forGain.not());

    const eeImage   = ee.Image(0).byte()
        .where(otherChg, 3).where(forGain, 2).where(forLoss, 1)
        .rename('change').clip(region);
    const vizParams = { bands: ['change'], min: 0, max: 3,
        palette: ['#e0e0e0', '#d73027', '#1a9641', '#ff9800'] };
    const areaStats = await computeAreaStats(eeImage, region, 4, 60);

    return {
        eeImage,
        vizParams,
        stats: {
            noChangeHa: areaStats[0] || 0, forestLossHa: areaStats[1] || 0,
            forestGainHa: areaStats[2] || 0, otherChangeHa: areaStats[3] || 0,
        },
        legend: [
            { color: '#e0e0e0', label: 'Không thay đổi' }, { color: '#d73027', label: 'Mất rừng' },
            { color: '#1a9641', label: 'Tăng rừng' },       { color: '#ff9800', label: 'Thay đổi khác' },
        ],
        metadata: {
            period1: { startDate: params.startDate, endDate: params.endDate },
            period2: { startDate: params.startDate2, endDate: params.endDate2 },
            forestNdviThresh: FOREST,
        },
    };
}

const IMAGE_BUILDERS = {
    rgb:        buildRgb,
    ndvi:       buildNdvi,
    heatmap:    buildHeatmap,
    'heat-map': buildHeatmap,
    classified: buildClassified,
    compare:    buildCompare,
};

// ── Main request processor ────────────────────────────────────────────────────

async function processRequest(imageType, rawParams) {
    await initializeEarthEngine();

    const normalType = imageType === 'heat-map' ? 'heatmap' : imageType;
    const handler    = IMAGE_BUILDERS[normalType] || IMAGE_BUILDERS[imageType];
    if (!handler) {
        throw new BusinessLogicError(`Loại ảnh không hợp lệ: ${imageType}`,
            ['INVALID_IMAGE_TYPE'], StatusCodes.BAD_REQUEST);
    }

    const params = normalizeParams({ ...rawParams, imageType: normalType });
    const hash   = hashParams(params);

    // Cache hit.
    const cached = await repo.getByHash(hash);
    if (cached) {
        return {
            resultId:    cached.id,
            tileUrl:     buildProxyUrl(cached.id),
            geeTileUrl:  cached.tile_url,
            geoserverLayer: cached.geoserver_layer || null,
            stats:       cached.stats,
            legend:      cached.legend,
            metadata:    cached.metadata,
            cached:      true,
        };
    }

    // Compute via GEE.
    const region  = toEeGeometry(params.geometry);
    const { eeImage, vizParams, stats, legend, metadata } = await handler(params, region);
    const { mapId, tileUrl } = await getEeMapId(eeImage, vizParams);

    const saved = await repo.upsert({
        request_hash: hash,
        image_type:   normalType,
        collection:   params.collection,
        start_date:   params.startDate,
        end_date:     params.endDate,
        start_date2:  params.startDate2,
        end_date2:    params.endDate2,
        geometry:     params.geometry,
        tile_url:     tileUrl,
        map_id:       mapId || null,
        stats, legend, metadata,
    }).catch((err) => {
        console.warn('[SATELLITE] Cache write failed:', err.message);
        return { id: null, tile_url: tileUrl, geoserver_layer: null };
    });

    return {
        resultId:       saved.id,
        tileUrl:        saved.id ? buildProxyUrl(saved.id) : tileUrl,
        geeTileUrl:     tileUrl,
        geoserverLayer: null,
        stats, legend, metadata,
        cached: false,
    };
}

// ── Tile proxy ────────────────────────────────────────────────────────────────

/**
 * Fetch a single GEE tile and stream it to the response.
 * Called by GET /satellite/tiles/:resultId/:z/:x/:y.
 */
async function streamTile(resultId, z, x, y, res) {
    const result = await repo.getById(resultId);
    if (!result) {
        res.status(404).end();
        return;
    }

    const url = result.tile_url
        .replace('{z}', z).replace('{x}', x).replace('{y}', y);

    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), 30_000);

    try {
        const upstream = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);

        if (!upstream.ok) {
            res.status(upstream.status).end();
            return;
        }

        res.set('Content-Type', upstream.headers.get('content-type') || 'image/png');
        res.set('Cache-Control', 'public, max-age=3600');

        // Node 18+ readable stream from Response.
        const { Readable } = require('stream');
        Readable.fromWeb(upstream.body).pipe(res);
    } catch (err) {
        clearTimeout(timer);
        if (err.name === 'AbortError') { res.status(504).end(); return; }
        throw err;
    }
}

// ── GeoServer publish (async) ─────────────────────────────────────────────────

/**
 * Submit a GEE export task for an existing cached result.
 * Updates result status → 'exporting'.
 * Polled by pollPublishes().
 */
async function publishResult(resultId) {
    await initializeEarthEngine();

    const result = await repo.getById(resultId);
    if (!result) throw new BusinessLogicError('Kết quả không tồn tại.', ['NOT_FOUND'], 404);
    if (!GCS_BUCKET) throw new BusinessLogicError('GEE_GCS_BUCKET chưa được cấu hình.', ['GCS_NOT_CONFIGURED'], 503);

    if (result.geoserver_layer) {
        return result;  // already published
    }

    // Re-build the EE image to export (cannot reuse mapId image object).
    const params  = normalizeParams({
        imageType:  result.image_type,
        collection: result.collection,
        startDate:  result.start_date,
        endDate:    result.end_date,
        startDate2: result.start_date2,
        endDate2:   result.end_date2,
        geometry:   result.geometry,
    });
    const handler = IMAGE_BUILDERS[result.image_type];
    const region  = toEeGeometry(params.geometry);
    const { eeImage } = await handler(params, region);

    const dateTag    = `${result.image_type}_${result.start_date}`.replace(/-/g, '');
    const filePrefix = `satellite/${dateTag}_${resultId}`;

    const task = ee.batch.Export.image.toCloudStorage({
        image:          eeImage.toFloat(),
        description:    `sat_${dateTag}_${resultId}`,
        bucket:         GCS_BUCKET,
        fileNamePrefix: filePrefix,
        scale:          EXPORT_SCALE_M,
        maxPixels:      1e13,
        region:         region,
        fileFormat:     'GeoTIFF',
        formatOptions:  { cloudOptimized: true },
    });
    task.start();

    const status   = await eeEval(task.status());
    const taskName = status.name || status.id || String(task);

    return repo.updatePublish(resultId, { status: 'exporting', gee_task_id: taskName });
}

/**
 * Poll all 'exporting' satellite results and publish to GeoServer when done.
 * Called by cron job or periodic worker.
 */
async function pollPublishes() {
    const exporting = await repo.listExporting();
    for (const r of exporting) {
        try {
            const state = await pollGeeTask(r.gee_task_id);
            if (state === 'COMPLETED') {
                const dateTag  = `${r.image_type}_${r.start_date}`.replace(/-/g, '');
                const fileName = `sat_${dateTag}_${r.id}.tif`;
                const minioKey = `satellite/${fileName}`;
                const storeName = `sat_${dateTag}_${r.id}`;

                const published = await publishRasterToMinio({
                    gcsPath:     `satellite/${dateTag}_${r.id}`,
                    bucket:      GCS_BUCKET,
                    fileName,
                    minioKey,
                    minioBucket: SATELLITE_MINIO_BUCKET,
                    storeName,
                    gcsKeyFile:  GCS_KEY_FILE,
                    harvest:     false,
                });

                if (published) {
                    // Create standalone GeoTIFF coverage store in GeoServer.
                    const localTmp = `/tmp/${fileName}`;
                    const gsLayer  = await geoserver.publishRasterLayer({
                        geoserver_store: storeName,
                        source_url:      localTmp,
                        name_vi:         `Ảnh vệ tinh ${r.image_type} ${r.start_date}`,
                    }).catch((e) => {
                        console.warn('[SATELLITE] GeoServer publish failed:', e.message);
                        return null;
                    });

                    await repo.updatePublish(r.id, {
                        status:         'published',
                        minio_key:      published.minioKey,
                        geoserver_store: storeName,
                        geoserver_layer: gsLayer || null,
                    });
                }
            } else if (['FAILED', 'CANCELLED', 'TIMEOUT'].includes(state)) {
                await repo.updatePublish(r.id, {
                    status:        'failed',
                    publish_error: `GEE export ${state}: ${r.gee_task_id}`,
                });
            }
        } catch (err) {
            console.error(`[SATELLITE] pollPublishes error id=${r.id}:`, err.message);
        }
    }
}

// ── Public API ────────────────────────────────────────────────────────────────

module.exports = {
    getRgb:        (p) => processRequest('rgb',        p),
    getNdvi:       (p) => processRequest('ndvi',       p),
    getHeatmap:    (p) => processRequest('heatmap',    p),
    getClassified: (p) => processRequest('classified', p),
    getCompare:    (p) => processRequest('compare',    p),
    processRequest,
    streamTile,
    publishResult,
    pollPublishes,
    CLASSIFIED_CLASSES,
};
