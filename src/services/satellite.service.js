'use strict';

/**
 * Satellite Image Service — on-demand GEE tile generation + GeoServer publish.
 *
 * Flow:
 *   1. POST /satellite/{type}  → compute GEE image → return `geeTileUrl` (Earth
 *                                 Engine CDN URL). Client cắm thẳng vào Mapbox.
 *   2. POST /satellite/publish → submit GEE export task → GCS → MinIO → GeoServer
 *                                 (async — kết quả có `geoserverLayer` WMS name).
 *
 * Ghi chú kiến trúc: phiên bản cũ có proxy Node.js `/satellite/tiles/:id/:z/:x/:y`
 * để giấu GEE token khỏi client. Đã gỡ theo yêu cầu — client dùng `geeTileUrl`
 * gọi thẳng https://earthengine.googleapis.com/… . Ưu điểm: tile qua Google CDN
 * nhanh hơn, Node.js không thành nút cổ chai. Đánh đổi: mapId URL của GEE lộ ra
 * client (không đi kèm secret cá nhân — nó chỉ là handle tới một image lazy đã
 * đăng ký trên EE, tương tự signed URL).
 *
 * All endpoints cache results in satellite.image_results.
 */

const crypto = require('crypto');

const DEBUG = process.env.SATELLITE_DEBUG === 'true' || process.env.NODE_ENV === 'development';
function dbg(tag, msg, data) {
    if (!DEBUG) return;
    const ts = new Date().toISOString();
    if (data !== undefined) {
        console.debug(`[SATELLITE:${tag}] ${ts} — ${msg}`, typeof data === 'object' ? JSON.stringify(data) : data);
    } else {
        console.debug(`[SATELLITE:${tag}] ${ts} — ${msg}`);
    }
}
function dbgTime(tag, label, startMs) {
    if (!DEBUG) return;
    dbg(tag, `${label} (${Date.now() - startMs}ms)`);
}
const { ee, initializeEarthEngine } = require('../configs/gge');
const {
    eeEval,
    getEeMapId,
    getEeDownloadUrl,
    toEeGeometry,
    addIndices,
    maskS2FireRisk,
    maskLandsatC2,
    prepL57,
    prepL89,
    maskS2,
} = require('../utils/gee-satellite.util');
const { runRfClassification } = require('./forest-classification.pipeline');
const { runFireRiskAnalysis } = require('./fire-risk.pipeline');
const fcCfg    = require('../configs/forest-classification');
const frCfg    = require('../configs/fire-risk');
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
        geometry:    raw.geometry    || null,
        ndviMinThresh: raw.ndviMinThresh != null ? Number(raw.ndviMinThresh) : null,
        // Forest classification v3 ground-truth params (used by /classified).
        groundTruthAssetId: raw.groundTruthAssetId ? String(raw.groundTruthAssetId).trim() : '',
        gtBufferM:          raw.gtBufferM != null ? Number(raw.gtBufferM) : 60,
        minFieldTest:       raw.minFieldTest != null ? Number(raw.minFieldTest) : 10,
        // Fire warning v8.1 params (used by /fire-risk). analysisDate falls
        // back to endDate so a single date field works for both.
        analysisDate:       raw.analysisDate || raw.endDate || null,
        enableRf:           raw.enableRf !== undefined ? Boolean(raw.enableRf) : null,
        inputFireAssetId:   raw.inputFireAssetId ? String(raw.inputFireAssetId).trim() : '',
        // Which fire-risk layer to visualise: 'riskLevel' (default), 'score',
        // 'priorityWarning', 'confidence'.
        fireLayer:          raw.fireLayer || 'riskLevel',
    };
}

// Validate required date params per image type. Throws a 400 BusinessLogicError
// with a clear message rather than letting the GEE server complain later with
// "Parameter 'start' is required and may not be null".
function validateParams(imageType, params) {
    // Fire-risk only needs analysisDate (falls back to endDate in normalizeParams).
    if (imageType === 'fire-risk') {
        if (!params.analysisDate) {
            throw new BusinessLogicError(
                'Thiếu tham số bắt buộc: analysisDate (hoặc endDate).',
                ['MISSING_REQUIRED_PARAM'], StatusCodes.BAD_REQUEST,
            );
        }
        return;
    }
    const missing = [];
    if (!params.startDate) missing.push('startDate');
    if (!params.endDate)   missing.push('endDate');
    if (missing.length) {
        throw new BusinessLogicError(
            `Thiếu tham số bắt buộc: ${missing.join(', ')}.`,
            ['MISSING_REQUIRED_PARAM'],
            StatusCodes.BAD_REQUEST,
        );
    }
}

function hashParams(params) {
    const str = JSON.stringify({
        t: params.imageType, c: params.collection, cc: params.cloudCover,
        sd: params.startDate, ed: params.endDate,
        g: params.geometry,
        // Ground-truth params affect classification output, so include in cache key.
        gt: params.groundTruthAssetId || null,
        gb: params.groundTruthAssetId ? params.gtBufferM : null,
        // Fire warning params.
        ad: params.analysisDate || null,
        rf: params.enableRf,
        ifa: params.inputFireAssetId || null,
        fl: params.fireLayer,
    });
    return crypto.createHash('sha256').update(str).digest('hex');
}

// ── Shared collection builder ─────────────────────────────────────────────────

function buildCollection(region, startDate, endDate, collection, cloudCover) {
    const useS2      = !collection || collection.toUpperCase() === 'S2';
    const useLandsat = !collection || collection.toUpperCase() === 'LANDSAT';

    dbg('COLLECTION', `building — collection=${collection || 'auto'} dates=${startDate}→${endDate} cloudCover≤${cloudCover}%`);

    let col = ee.ImageCollection([]);

    if (useLandsat) {
        // L8 + L9 only (L5/L7 excluded — on-demand service targets post-2013 only)
        const l8 = ee.ImageCollection('LANDSAT/LC08/C02/T1_L2')
            .filterBounds(region).filterDate(startDate, endDate)
            .map(maskLandsatC2).map(prepL89);
        const l9 = ee.ImageCollection('LANDSAT/LC09/C02/T1_L2')
            .filterBounds(region).filterDate(startDate, endDate)
            .map(maskLandsatC2).map(prepL89);
        col = col.merge(l8).merge(l9);
        dbg('COLLECTION', 'merged L8 + L9');
    }

    if (useS2) {
        const s2 = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
            .filterBounds(region).filterDate(startDate, endDate)
            .filter(ee.Filter.lte('CLOUDY_PIXEL_PERCENTAGE', cloudCover))
            .map(maskS2);
        col = col.merge(s2);
        dbg('COLLECTION', 'merged S2_SR_HARMONIZED');
    }

    return col;
}

// Throw a clear 400 when the merged collection has zero images. Otherwise
// downstream calls (.median → .select → visualize) fail deep in GEE with
// cryptic messages like "no bands" or "Parameter 'start' is required".
function assertNonEmpty(imgCount, startDate, endDate, cloudCover) {
    if (imgCount > 0) return;
    throw new BusinessLogicError(
        `Không tìm thấy ảnh vệ tinh nào trong ${startDate} → ${endDate} ` +
        `với ngưỡng mây ≤ ${cloudCover}%. Hãy mở rộng khoảng thời gian hoặc ` +
        `tăng ngưỡng mây.`,
        ['EMPTY_COLLECTION'],
        StatusCodes.BAD_REQUEST,
    );
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
    const t0 = Date.now();
    dbg('RGB', `start — ${params.startDate} → ${params.endDate}`);
    const col       = buildCollection(region, params.startDate, params.endDate,
        params.collection, params.cloudCover);
    const imgCount  = await eeEval(col.size());
    dbgTime('RGB', `collection size=${imgCount}`, t0);
    assertNonEmpty(imgCount, params.startDate, params.endDate, params.cloudCover);
    const eeImage   = col.select(['red', 'green', 'blue']).median().clip(region);
    const vizParams = { bands: ['red', 'green', 'blue'], min: 0, max: 0.3 };
    dbgTime('RGB', 'done', t0);
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
    const t0 = Date.now();
    dbg('NDVI', `start — ${params.startDate} → ${params.endDate}`);
    const col       = buildCollection(region, params.startDate, params.endDate,
        params.collection, params.cloudCover);
    const imgCount  = await eeEval(col.size());
    dbgTime('NDVI', `collection size=${imgCount}`, t0);
    assertNonEmpty(imgCount, params.startDate, params.endDate, params.cloudCover);
    const composite = col.median().clip(region);
    const eeImage   = composite.normalizedDifference(['nir', 'red']).rename('NDVI');
    const vizParams = { bands: ['NDVI'], min: -0.2, max: 0.8,
        palette: ['#d73027', '#fee08b', '#ffffbf', '#90ee90', '#1a9641'] };

    const ndviThresh = parseFloat(params.ndviMinThresh) || 0.3;
    dbg('NDVI', `computing area stats with thresh=${ndviThresh}`);
    const areaStats  = await computeAreaStats(
        eeImage.gt(ndviThresh).selfMask().toByte(), region, 2);
    dbgTime('NDVI', `vegetationHa=${areaStats[1] || 0}`, t0);

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
    const t0 = Date.now();
    dbg('HEATMAP', `start — MODIS MOD11A1 ${params.startDate} → ${params.endDate}`);
    const modis    = ee.ImageCollection('MODIS/061/MOD11A1')
        .filterBounds(region).filterDate(params.startDate, params.endDate);
    const imgCount = await eeEval(modis.size());
    dbgTime('HEATMAP', `MODIS images=${imgCount}`, t0);
    const eeImage  = modis.select('LST_Day_1km').mean()
        .multiply(0.02).subtract(273.15).rename('LST_C').clip(region);
    const vizParams = { bands: ['LST_C'], min: 20, max: 45,
        palette: ['#313695', '#74add1', '#fed976', '#fd8d3c', '#d73027'] };

    dbg('HEATMAP', 'reducing LST stats');
    const r = await eeEval(eeImage.reduceRegion({
        reducer: ee.Reducer.mean().combine(ee.Reducer.minMax(), null, true),
        geometry: region, scale: 1000, bestEffort: true, maxPixels: 1e12,
    }));
    dbgTime('HEATMAP', `LST mean=${r.LST_C_mean?.toFixed(2)}°C min=${r.LST_C_min?.toFixed(2)} max=${r.LST_C_max?.toFixed(2)}`, t0);

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

const CLASSIFIED_CLASSES = fcCfg.CLASS_NAMES.map((name, id) => ({
    id, name, color: fcCfg.CLASS_PALETTE[id],
}));

/**
 * On-demand 11-class forest cover classification for Kon Tum.
 *
 * Mirrors the v3 GEE script (lopPhuRungFinal): Landsat 5/7/8/9 + Sentinel-2
 * seasonal composites (dry/wet), spectral indices, DEM, threshold + Dynamic
 * World + ESA WorldCover + JRC GSW pseudo-labels, Random Forest classifier,
 * and JRC stable-water post-correction. Shared with the scheduled monthly
 * snapshot service via forest-classification.pipeline.js.
 *
 * The RF pipeline is year-based (seasonal composites need fixed month windows),
 * so we derive `year` from `params.startDate`. `params.endDate` and `cloudCover`
 * are used only to gate the composite range; the pipeline uses fcCfg month
 * windows for base/dry/wet.
 */
async function buildClassified(params, region) {
    const t0 = Date.now();
    const year = new Date(params.startDate).getUTCFullYear();
    const hasGT = Boolean(params.groundTruthAssetId);
    dbg('CLASSIFIED', `start — 11-class RF year=${year} region=${params.geometry ? 'custom' : 'Kon Tum'} groundTruth=${hasGT ? params.groundTruthAssetId : 'none'}`);

    // Wrap ee.Geometry as FeatureCollection so pipeline helpers that need
    // `region.geometry()` (stratifiedSample, export) work uniformly whether
    // the ROI came from the user or the default Kon Tum province.
    const regionFC   = ee.FeatureCollection([ee.Feature(region)]);
    const regionGeom = region;

    const {
        classified: eeImage,
        oobPct,
        testAccuracyPct,
        testKappa,
        quotas,
    } = await runRfClassification(year, regionFC, regionGeom, {
        seed:               year,
        groundTruthAssetId: params.groundTruthAssetId,
        gtBufferM:          params.gtBufferM,
        minFieldTest:       params.minFieldTest,
        // Skip blocking eeEval calls for OOB/test accuracy — these force the full
        // RF training to materialise synchronously and take 5+ minutes for Kon Tum.
        // Tiles are still rendered correctly; stats are omitted for on-demand requests.
        skipStats: true,
        // Lite mode: on-demand endpoint bỏ dataset labels (DW+WC+JRC), giảm sample,
        // giảm RF trees, dùng sample scale coarser. Cần thiết vì graph v3 gốc
        // vượt quá budget của getMapId (~200 s → GEE "Please try again").
        // Batch cron trong forest-classification.service.js vẫn dùng full v3.
        liteMode:           params.liteMode !== false,
    });
    dbgTime('CLASSIFIED', `RF graph built (stats skipped)`, t0);

    const palette   = fcCfg.CLASS_PALETTE;
    const nClasses  = fcCfg.CLASS_NAMES.length;
    const vizParams = { bands: ['classification'], min: 0, max: nClasses - 1, palette };

    // Skip computeAreaStats (reduceRegion over Kon Tum at 60m would take > 5 min).
    // Return class list without areas so the cache and client both know the shape.
    const areaByClass = CLASSIFIED_CLASSES.map((c) => ({
        classId: c.id, name: c.name, color: c.color, areaHa: null,
    }));
    dbgTime('CLASSIFIED', `vizParams built`, t0);

    return {
        eeImage,
        vizParams,
        stats:  {
            year,
            oobAccuracyPct:  Math.round((oobPct || 0) * 100) / 100,
            testAccuracyPct: testAccuracyPct != null ? Math.round(testAccuracyPct * 100) / 100 : null,
            testKappa:       testKappa != null ? Math.round(testKappa * 1000) / 1000 : null,
            hasGroundTruth:  hasGT,
            sampleQuotas:    quotas,
            areaByClass,
        },
        legend: areaByClass.map((c) => ({ color: c.color, label: `${c.classId} – ${c.name}` })),
        metadata: {
            year,
            startDate:  params.startDate,
            endDate:    params.endDate,
            classCount: nClasses,
            model:      'RandomForest v3 (Landsat 5/7/8/9 + S2 + DW + WorldCover + JRC GSW)',
            groundTruthAssetId: hasGT ? params.groundTruthAssetId : null,
            gtBufferM:          hasGT ? params.gtBufferM : null,
            blendRule:          hasGT
                ? 'Input 50% + Dataset 30% + Threshold 20%'
                : 'Dataset 60% + Threshold 40%',
        },
    };
}

/**
 * On-demand fire warning (v8.1) for Kon Tum or a user-supplied ROI.
 *
 * Mirrors docs/kontum_fire_warning_final.js: 30-day predictor window with
 * 180-day S2/LST fallback, ERA5 Nesterov P (QĐ 25/2022), optional RF trained
 * on 20 dry-season months of MCD64A1 + FireCCI51 + FIRMS labels, blend rules
 * with/without INPUT, data-quality gating (Level 0 when neither S2 nor LST
 * observed in 30 days), and a priority-warning layer.
 *
 * `params.fireLayer` selects what to visualise:
 *   'riskLevel'       → 0-5 categorical (default)
 *   'score'           → FinalFireRiskScore ∈ [0,1]
 *   'priorityWarning' → 3/4/5 (model / FIRMS / confirmed input)
 *   'confidence'      → ModelConfidenceClass 0-3
 */
async function buildFireRisk(params, region) {
    const t0 = Date.now();
    const analysisDate = params.analysisDate || params.endDate;
    if (!analysisDate) {
        throw new BusinessLogicError(
            'Cần cung cấp analysisDate hoặc endDate cho fire-risk.',
            ['MISSING_ANALYSIS_DATE'], StatusCodes.BAD_REQUEST,
        );
    }

    const enableRf = params.enableRf ?? frCfg.ENABLE_RF;
    const layerKey = params.fireLayer || 'riskLevel';
    dbg('FIRE_RISK', `start — date=${analysisDate} rf=${enableRf} input=${params.inputFireAssetId || 'none'} layer=${layerKey}`);

    // The fire-risk pipeline expects an ee.FeatureCollection for `region.geometry()` calls.
    const regionFC = ee.FeatureCollection([ee.Feature(region)]);

    // runFireRiskAnalysis is now async (each build step is stage-logged);
    // the returned graph is still lazy — evaluate() only fires below.
    const analysis = await runFireRiskAnalysis(regionFC, analysisDate, {
        enableRf,
        inputFireAssetId: params.inputFireAssetId || '',
    });

    const layers = {
        riskLevel: {
            image:     analysis.riskLevel,
            viz:       { bands: ['RiskLevel'], min: 0, max: 5,
                palette: ['#ffffff','#00a65a','#f6e84a','#f39c12','#e74c3c','#7b241c'] },
            legend:    [
                { color: '#ffffff', label: 'Cấp 0 — Không có S2 hoặc LST quan sát trong 30 ngày' },
                { color: '#00a65a', label: 'Cấp I — Thấp' },
                { color: '#f6e84a', label: 'Cấp II — Trung bình' },
                { color: '#f39c12', label: 'Cấp III — Cao' },
                { color: '#e74c3c', label: 'Cấp IV — Nguy hiểm' },
                { color: '#7b241c', label: 'Cấp V — Cực kỳ nguy hiểm' },
            ],
        },
        score: {
            image:  analysis.finalFireRiskScore,
            viz:    { bands: ['FinalFireRiskScore'], min: 0, max: 1,
                palette: ['#00a65a','#f6e84a','#f39c12','#e74c3c','#7b241c'] },
            legend: [
                { color: '#00a65a', label: '0.0 – 0.2 — Thấp' },
                { color: '#f6e84a', label: '0.2 – 0.4 — Trung bình' },
                { color: '#f39c12', label: '0.4 – 0.6 — Cao' },
                { color: '#e74c3c', label: '0.6 – 0.8 — Nguy hiểm' },
                { color: '#7b241c', label: '0.8 – 1.0 — Cực kỳ nguy hiểm' },
            ],
        },
        priorityWarning: {
            image:  analysis.priorityFireWarning,
            viz:    { bands: ['PriorityFireWarning'], min: 3, max: 5,
                palette: ['#f39c12','#e74c3c','#7b241c'] },
            legend: [
                { color: '#f39c12', label: '3 — Model risk cấp cao' },
                { color: '#e74c3c', label: '4 — FIRMS gần đây' },
                { color: '#7b241c', label: '5 — INPUT đã xác thực' },
            ],
        },
        confidence: {
            image:  analysis.modelConfidenceClass,
            viz:    { bands: ['ModelConfidenceClass'], min: 0, max: 3,
                palette: ['#ffffff','#f6e84a','#f39c12','#2166ac'] },
            legend: [
                { color: '#ffffff', label: '0 — Không có quan sát mới 30 ngày' },
                { color: '#f6e84a', label: '1 — Thấp' },
                { color: '#f39c12', label: '2 — Trung bình' },
                { color: '#2166ac', label: '3 — Cao' },
            ],
        },
    };

    const layer = layers[layerKey] || layers.riskLevel;
    dbgTime('FIRE_RISK', `built layer=${layerKey}`, t0);

    return {
        eeImage:  layer.image,
        vizParams: layer.viz,
        stats: {
            analysisDate,
            fireLayer:        layerKey,
            rfEnabled:        analysis.rfEnabled,
            hasInputAsset:    Boolean(analysis.inputFireAssetId),
            fuelSource:       analysis.fuelSource,
            blendRule: analysis.inputFireAssetId
                ? '50% input + 30% dataset + 20% threshold (with INPUT), else 60% dataset + 40% threshold'
                : '60% dataset + 40% threshold',
            nesterovBreaks:   frCfg.NESTEROV_P_BREAKS,
            riskScoreBreaks:  frCfg.RISK_SCORE_BREAKS,
        },
        legend:   layer.legend,
        metadata: {
            analysisDate,
            fireLayer:         layerKey,
            enableRf,
            inputFireAssetId:  analysis.inputFireAssetId,
            featureWindowDays: frCfg.FEATURE_WINDOW_DAYS,
            nesterovLookbackDays: frCfg.NESTEROV_LOOKBACK_DAYS,
            model:             'FireRisk v8.1 (S2 + MODIS LST + ERA5 + Terrain + FuelK + Nesterov P + optional RF)',
        },
    };
}

const IMAGE_BUILDERS = {
    rgb:        buildRgb,
    ndvi:       buildNdvi,
    heatmap:    buildHeatmap,
    'heat-map': buildHeatmap,
    classified: buildClassified,
    'fire-risk': buildFireRisk,
    fire_risk:   buildFireRisk,
    firerisk:    buildFireRisk,
};

// ── Main request processor ────────────────────────────────────────────────────

async function processRequest(imageType, rawParams) {
    const t0 = Date.now();
    dbg('PROCESS', `→ type=${imageType}`, { startDate: rawParams.startDate, endDate: rawParams.endDate,
        collection: rawParams.collection, cloudCover: rawParams.cloudCover });

    await initializeEarthEngine();

    // Normalise slug variants (heat-map → heatmap, fire_risk / firerisk → fire-risk).
    let normalType = imageType;
    if (normalType === 'heat-map')                             normalType = 'heatmap';
    if (['fire_risk','firerisk'].includes(normalType))         normalType = 'fire-risk';
    const handler    = IMAGE_BUILDERS[normalType] || IMAGE_BUILDERS[imageType];
    if (!handler) {
        console.warn(`[SATELLITE:PROCESS] unknown imageType=${imageType}`);
        throw new BusinessLogicError(`Loại ảnh không hợp lệ: ${imageType}`,
            ['INVALID_IMAGE_TYPE'], StatusCodes.BAD_REQUEST);
    }

    const params = normalizeParams({ ...rawParams, imageType: normalType });
    validateParams(normalType, params);
    const hash   = hashParams(params);
    dbg('PROCESS', `cache hash=${hash.slice(0, 12)}…`);

    // Cache hit.
    const cached = await repo.getByHash(hash);
    if (cached) {
        // Bypass stale classified cache entries computed with an old class schema.
        const expectedClasses = fcCfg.CLASS_NAMES.length;
        const isStaleClassified = normalType === 'classified'
            && (cached.metadata?.classCount !== expectedClasses
                || !Array.isArray(cached.stats?.areaByClass)
                || cached.stats.areaByClass.length !== expectedClasses);
        if (!isStaleClassified) {
            dbgTime('PROCESS', `cache HIT id=${cached.id}`, t0);
            return {
                resultId:    cached.id,
                // Client gọi thẳng Earth Engine CDN qua `geeTileUrl` — không có
                // trung chuyển Node.js. Proxy `tileUrl` cũ đã gỡ.
                geeTileUrl:  cached.tile_url,
                geoserverLayer: cached.geoserver_layer || null,
                downloadUrl: cached.metadata?.downloadUrl || null,
                stats:       cached.stats,
                legend:      cached.legend,
                metadata:    cached.metadata,
                cached:      true,
            };
        }
        dbg('PROCESS', `classified cache STALE (${cached.stats?.areaByClass?.length ?? 0} classes ≠ ${expectedClasses}) — recomputing`);
    }

    dbg('PROCESS', 'cache MISS — computing via GEE');
    // Compute via GEE.
    const region  = toEeGeometry(params.geometry);
    const { eeImage, vizParams, stats, legend, metadata } = await handler(params, region);
    dbgTime('PROCESS', 'builder done — calling getEeMapId', t0);
    const { mapId, tileUrl } = await getEeMapId(eeImage, vizParams);
    dbgTime('PROCESS', `mapId obtained mapId=${mapId?.slice(0, 12)}…`, t0);

    // Generate download URL (best-effort; null if image is too large or GEE rejects).
    const downloadUrl = await getEeDownloadUrl(eeImage, region, vizParams);

    const saved = await repo.upsert({
        request_hash: hash,
        image_type:   normalType,
        collection:   params.collection,
        start_date:   params.startDate,
        end_date:     params.endDate,
        geometry:     params.geometry,
        tile_url:     tileUrl,
        map_id:       mapId || null,
        stats, legend,
        metadata: { ...metadata, downloadUrl },
    }).catch((err) => {
        console.warn('[SATELLITE] Cache write failed:', err.message);
        return { id: null, tile_url: tileUrl, geoserver_layer: null };
    });

    dbgTime('PROCESS', `saved id=${saved.id} — done`, t0);
    return {
        resultId:       saved.id,
        // Response chỉ có geeTileUrl → client vẽ tile bằng URL Earth Engine.
        geeTileUrl:     tileUrl,
        geoserverLayer: null,
        downloadUrl,
        stats, legend, metadata,
        cached: false,
    };
}

// ── GeoServer publish (async) ─────────────────────────────────────────────────

/**
 * Submit a GEE export task for an existing cached result.
 * Updates result status → 'exporting'.
 * Polled by pollPublishes().
 */
async function publishResult(resultId) {
    dbg('PUBLISH', `start id=${resultId}`);
    await initializeEarthEngine();

    const result = await repo.getById(resultId);
    if (!result) throw new BusinessLogicError('Kết quả không tồn tại.', ['NOT_FOUND'], 404);
    if (!GCS_BUCKET) throw new BusinessLogicError('GEE_GCS_BUCKET chưa được cấu hình.', ['GCS_NOT_CONFIGURED'], 503);

    if (result.geoserver_layer) {
        dbg('PUBLISH', `id=${resultId} already published → ${result.geoserver_layer}`);
        return result;  // already published
    }

    // Re-build the EE image to export (cannot reuse mapId image object).
    // Restore any per-type extras (ground-truth for classified) from metadata.
    const meta = result.metadata || {};
    const params  = normalizeParams({
        imageType:          result.image_type,
        collection:         result.collection,
        startDate:          result.start_date,
        endDate:            result.end_date,
        geometry:           result.geometry,
        groundTruthAssetId: meta.groundTruthAssetId || '',
        gtBufferM:          meta.gtBufferM,
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
    dbg('PUBLISH', `GEE export task started id=${resultId} taskName=${taskName}`);

    return repo.updatePublish(resultId, { status: 'exporting', gee_task_id: taskName });
}

/**
 * Poll all 'exporting' satellite results and publish to GeoServer when done.
 * Called by cron job or periodic worker.
 */
async function pollPublishes() {
    const exporting = await repo.listExporting();
    dbg('POLL', `checking ${exporting.length} exporting result(s)`);
    for (const r of exporting) {
        try {
            const state = await pollGeeTask(r.gee_task_id);
            dbg('POLL', `id=${r.id} taskId=${r.gee_task_id} state=${state}`);
            if (state === 'COMPLETED') {
                dbg('POLL', `id=${r.id} COMPLETED — starting MinIO/GeoServer publish`);
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
    getFireRisk:   (p) => processRequest('fire-risk',  p),
    processRequest,
    publishResult,
    pollPublishes,
    CLASSIFIED_CLASSES,
};
