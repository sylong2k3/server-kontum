'use strict';

/**
 * Fire Risk Service (EP-06 — Cảnh báo cháy rừng).
 *
 * Pipeline (mirrors GEE script chayRungFinal.txt v8.1):
 *   1. Sentinel-2 → NDVI, NDMI, NBR (vegetation health & moisture)
 *   2. MODIS MOD11A1 → LST (land surface temperature)
 *   3. ERA5-Land DAILY_AGGR → AirTemp, DewPoint, RelHumidity, WindSpeed, Rain
 *   4. P Nesterov (QĐ 25/2022/QĐ-UBND) accumulated over NESTEROV_LOOKBACK_DAYS
 *   5. Threshold score: blends P, NDVI, NDMI, LST
 *   6. Optional RF score via GEE (expensive — submitted as async task if enabled)
 *   7. FinalFireRiskScore → RiskLevel (1-5)
 *   8. reduceRegions per district → district_stats JSONB → DB snapshot
 *   9. High-risk vector features (level 4-5) → fire.fire_risk_features
 *  10. Async: export GeoTIFF → GCS → MinIO → GeoServer harvest
 *
 * Node.js GEE SDK note:
 *   Use .evaluate(callback) (promisified via eeEvaluate) instead of print().
 *   Heavy computations use tileScale 4-16 to avoid EE memory errors.
 */

const cfg    = require('../configs/fire-risk');
const { ee, initializeEarthEngine } = require('../configs/gge');
const repo   = require('../repositories/fire-risk.repository');
const {
    eeEval: eeEvaluate,
    getKonTumRegion,
    getKonTumDistricts,
    medianOrFallback,
    maskS2FireRisk,
    todayUtc,
    fmtDate,
} = require('../utils/gee-satellite.util');
const { pollGeeTask, publishRasterToMinio } = require('../utils/gee-export.helper');
const { BusinessLogicError } = require('../core/error.response');
const { StatusCodes } = require('../core/http-status-code');

// ── Sentinel-2 indices ───────────────────────────────────────────────────────

const S2_BANDS = ['B2', 'B3', 'B4', 'B8', 'B11', 'B12'];

function getS2Collection(region, startDate, endDate) {
    return ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
        .filterBounds(region)
        .filterDate(startDate, endDate)
        .filter(ee.Filter.lte('CLOUDY_PIXEL_PERCENTAGE', 85))
        .map(maskS2FireRisk);
}

/**
 * Compute NDVI, NDMI, NBR from Sentinel-2 with fallback to 180-day history.
 * Returns {indices, s2DataSource, s2Observed45}.
 */
function computeS2Indices(region, analysisEnd) {
    const endDate   = ee.Date(analysisEnd);
    const startDate = endDate.advance(-cfg.FEATURE_WINDOW_DAYS, 'day');
    const fbStart   = startDate.advance(-cfg.S2_FALLBACK_DAYS, 'day');

    const primary  = medianOrFallback(getS2Collection(region, startDate, endDate), S2_BANDS,
        [0.12, 0.10, 0.08, 0.40, 0.20, 0.12]);
    const fallback = medianOrFallback(getS2Collection(region, fbStart, startDate), S2_BANDS,
        [0.12, 0.10, 0.08, 0.40, 0.20, 0.12]);

    const primaryValid = primary.mask().reduce(ee.Reducer.min()).unmask(0);
    const merged       = primary.unmask(fallback);
    const filled       = merged.unmask(
        ee.Image.constant([0.12, 0.10, 0.08, 0.40, 0.20, 0.12]).rename(S2_BANDS),
    ).rename(S2_BANDS).clip(region);

    const ndvi = filled.normalizedDifference(['B8', 'B4']).rename('NDVI');
    const ndmi = filled.normalizedDifference(['B8', 'B11']).rename('NDMI');
    const nbr  = filled.normalizedDifference(['B8', 'B12']).rename('NBR');

    return {
        indices:        ndvi.addBands(ndmi).addBands(nbr),
        s2Observed45:   primaryValid.unmask(0).toByte().rename('S2_Observed45'),
    };
}

// ── MODIS LST ─────────────────────────────────────────────────────────────────

function computeLST(region, analysisEnd) {
    const endDate   = ee.Date(analysisEnd);
    const startDate = endDate.advance(-cfg.FEATURE_WINDOW_DAYS, 'day');
    const fbStart   = startDate.advance(-cfg.LST_FALLBACK_DAYS, 'day');

    const makeLst = (col) => col
        .select('LST_Day_1km')
        .multiply(cfg.LST_SCALE_FACTOR)
        .reduce(ee.Reducer.mean())
        .subtract(cfg.LST_KELVIN_OFFSET)
        .rename('LST_C');

    const modis  = ee.ImageCollection('MODIS/061/MOD11A1').filterBounds(region);
    const primary  = modis.filterDate(startDate, endDate);
    const fallback = modis.filterDate(fbStart, startDate);

    const lstPrimary  = ee.Image(ee.Algorithms.If(primary.size().gt(0),
        makeLst(primary), ee.Image.constant(30).rename('LST_C').updateMask(0)));
    const lstFallback = ee.Image(ee.Algorithms.If(fallback.size().gt(0),
        makeLst(fallback), ee.Image.constant(30).rename('LST_C').updateMask(0)));

    const lstObserved = lstPrimary.mask().unmask(0).toByte().rename('LST_Observed45');
    const lst = lstPrimary.unmask(lstFallback)
        .unmask(ee.Image.constant(30).rename('LST_C'))
        .clip(region);

    return { lst, lstObserved };
}

// ── ERA5-Land weather & P Nesterov ────────────────────────────────────────────

/**
 * Compute weather predictors (AirTemp, RelHumidity, WindSpeed) and
 * P Nesterov index accumulated over NESTEROV_LOOKBACK_DAYS.
 *
 * P Nesterov formula (simplified daily accumulation):
 *   P_i = (T13 * D13) * (T13 + D13)   — where D13 = T13 − Td13 (humidity deficit)
 *   Σ P_i resets when daily rain >= RAIN_RESET_MM (5 mm by default)
 *
 * ERA5-Land proxies:
 *   T13 ≈ temperature_2m at 06:00 UTC (13:00 VN)
 *   Td13 ≈ dewpoint_temperature_2m
 *   Rain ≈ total_precipitation_sum * 1000 (m → mm)
 */
function computeWeatherAndNesterov(region, analysisEnd) {
    const endDate   = ee.Date(analysisEnd);
    const startDate = endDate.advance(-cfg.FEATURE_WINDOW_DAYS, 'day');
    const pStart    = endDate.advance(-cfg.NESTEROV_LOOKBACK_DAYS, 'day');

    const era5 = ee.ImageCollection('ECMWF/ERA5_LAND/DAILY_AGGR').filterBounds(region);

    // ── Weather predictors over feature window ─────────────────────────────
    const wx = era5.filterDate(startDate, endDate);
    const airTemp = wx.select('temperature_2m').mean()
        .subtract(273.15).rename('AirTemp_C').unmask(25);
    const dewPoint = wx.select('dewpoint_temperature_2m').mean()
        .subtract(273.15).rename('DewPoint_C').unmask(18);
    const windU   = wx.select('u_component_of_wind_10m').mean().unmask(0);
    const windV   = wx.select('v_component_of_wind_10m').mean().unmask(0);
    const windSpeed = windU.pow(2).add(windV.pow(2)).sqrt().rename('WindSpeed_ms').unmask(2);
    const rain    = wx.select('total_precipitation_sum').mean()
        .multiply(1000).rename('Rain_mm').unmask(0);

    // Relative humidity from temperature and dew point.
    const e  = dewPoint.expression(
        '6.1078 * exp((17.269 * t) / (237.3 + t))', { t: dewPoint });
    const es = airTemp.expression(
        '6.1078 * exp((17.269 * t) / (237.3 + t))', { t: airTemp });
    const relHumidity = e.divide(es).multiply(100).clamp(0, 100).rename('RelHumidity_pct').unmask(70);

    // ── P Nesterov accumulation over lookback window ──────────────────────
    const pDays = era5.filterDate(pStart, endDate);

    // Map each daily image to a Nesterov daily contribution.
    const pDaily = pDays.map((img) => {
        const t  = img.select('temperature_2m').subtract(273.15);
        const td = img.select('dewpoint_temperature_2m').subtract(273.15);
        const r  = img.select('total_precipitation_sum').multiply(1000);

        // Humidity deficit D = T - Td (clamped to 0 if below min temp).
        const deficite = t.subtract(td).max(0);
        // Daily P contribution: T * D, clamped >= 0, reset if rain >= threshold.
        const pContrib = t.multiply(deficite)
            .where(t.lt(cfg.MIN_TEMP_FOR_NESTEROV_C), 0)
            .where(r.gte(5), ee.Image.constant(0));   // rain reset
        return pContrib.rename('P_daily').copyProperties(img, ['system:time_start']);
    });

    // Sum over the lookback window.
    const pNesterov = pDaily.select('P_daily').sum()
        .max(0).rename('P_Nesterov').unmask(0).clip(region);

    const weatherBands = airTemp.addBands(dewPoint)
        .addBands(relHumidity).addBands(windSpeed).addBands(rain).clip(region);

    return { weatherBands, pNesterov };
}

// ── Forest fuel mask ─────────────────────────────────────────────────────────

function getForestMask(region) {
    const igbp = ee.ImageCollection('MODIS/061/MCD12Q1')
        .filterDate('2020-01-01', '2021-01-01')
        .first().select('LC_Type1').clip(region).unmask(0);
    // IGBP classes 1-10 = forest/vegetation types.
    return igbp.gte(1).and(igbp.lte(10)).rename('ForestMask');
}

// ── Threshold-based risk score ────────────────────────────────────────────────

/**
 * Compute final fire risk score and risk level from indices without RF.
 * Used when RF is not enabled or as the primary component.
 *
 * FinalFireRiskScore ∈ [0,1]; RiskLevel ∈ {0,1,2,3,4,5}
 * 0 = no data (no S2 and no LST observation in 45-day window).
 */
function computeThresholdRisk(region, s2Indices, s2Observed45, lst, lstObserved, weatherBands, pNesterov) {
    const ndvi = s2Indices.select('NDVI');
    const ndmi = s2Indices.select('NDMI');

    // P Nesterov score (0-1): threshold look-up from QĐ 25/2022.
    const [p1, p2, p3, p4] = cfg.NESTEROV_P_BREAKS;
    const pScore = pNesterov.expression(
        '(p < p1) ? 0.05 : (p < p2) ? 0.30 : (p < p3) ? 0.60 : (p < p4) ? 0.80 : 0.95',
        { p: pNesterov, p1, p2, p3, p4 },
    ).rename('PScore');

    // NDVI drought score (lower NDVI = higher drought stress = higher risk).
    const ndviScore = ndvi.expression(
        '(n > 0.5) ? 0.10 : (n > 0.3) ? 0.35 : (n > 0.1) ? 0.65 : 0.90',
        { n: ndvi },
    ).rename('NDVIScore');

    // NDMI moisture score (lower = drier vegetation = higher risk).
    const ndmiScore = ndmi.expression(
        '(m > 0.1) ? 0.10 : (m > -0.1) ? 0.40 : (m > -0.3) ? 0.70 : 0.90',
        { m: ndmi },
    ).rename('NDMIScore');

    // LST score (higher surface temp = higher risk).
    const lstC   = lst.select('LST_C');
    const lstScore = lstC.expression(
        '(t < 30) ? 0.10 : (t < 35) ? 0.30 : (t < 40) ? 0.60 : 0.85',
        { t: lstC },
    ).rename('LSTScore');

    // Weighted blend.
    const thresholdScore = pScore.multiply(cfg.WEIGHT_P_NESTEROV)
        .add(ndviScore.multiply(cfg.WEIGHT_NDVI_DROUGHT))
        .add(ndmiScore.multiply(cfg.WEIGHT_NDMI_DROUGHT))
        .add(lstScore.multiply(cfg.WEIGHT_LST))
        .rename('ThresholdScore');

    // Apply forest mask.
    const forestMask = getForestMask(region);
    const finalScore = thresholdScore.updateMask(forestMask).rename('FinalFireRiskScore');

    // RiskLevel: 0 = no observation; 1-5 by risk_score_breaks.
    const [b1, b2, b3, b4] = cfg.RISK_SCORE_BREAKS;
    const riskLevelRaw = finalScore.expression(
        '(r < b1) ? 1 : (r < b2) ? 2 : (r < b3) ? 3 : (r < b4) ? 4 : 5',
        { r: finalScore, b1, b2, b3, b4 },
    ).rename('RiskLevel');

    // Mask out pixels with no S2 AND no LST recent observation.
    const hasObservation = s2Observed45.add(lstObserved).gt(0);
    const riskLevel = riskLevelRaw.updateMask(hasObservation)
        .unmask(0).toInt8().clip(region);

    return { finalScore, riskLevel };
}

// ── District statistics ───────────────────────────────────────────────────────

/**
 * Compute per-district area (ha) by risk level using reduceRegions.
 * Returns plain JS object from GEE evaluate().
 */
async function computeDistrictStats(riskLevel, pNesterov, s2Observed45, districts, region) {
    const SCALE = 500;
    const TILE  = 8;

    // Histogram of risk levels per district.
    const histImg = riskLevel.rename('riskLevel')
        .addBands(pNesterov.rename('pNesterov'))
        .addBands(s2Observed45.rename('s2Obs'));

    const reduced = histImg.reduceRegions({
        collection: districts,
        reducer:    ee.Reducer.frequencyHistogram()
            .combine(ee.Reducer.mean(), null, true),
        scale:      SCALE,
        tileScale:  TILE,
    });

    const fcResult = await eeEvaluate(reduced);

    // Parse GEE FeatureCollection result into district stats array.
    const stats = (fcResult.features || []).map((feat) => {
        const p = feat.properties || {};
        const hist = p.riskLevel_histogram || {};
        // Convert pixel counts to ha: 1 pixel at 500m scale = 25 ha.
        const pixelHa = (SCALE / 1000) ** 2 * 100; // km² → ha
        const levelDist = {};
        let totalForestHa = 0;
        for (let l = 1; l <= 5; l++) {
            const ha = (hist[String(l)] || 0) * pixelHa;
            levelDist[l] = Math.round(ha * 100) / 100;
            totalForestHa += ha;
        }
        return {
            unitCode:      p.ADM2_CODE  || null,
            name:          p.ADM2_NAME  || p.ADM1_NAME || null,
            riskLevelDist: levelDist,
            totalForestHa: Math.round(totalForestHa * 100) / 100,
            pNesterovMean: Math.round((p.pNesterov_mean || 0) * 100) / 100,
            s2Coverage:    Math.round((p.s2Obs_mean || 0) * 1000) / 1000,
        };
    });

    return stats;
}

/**
 * Compute province-level summary.
 */
async function computeProvinceSummary(riskLevel, pNesterov, s2Observed45, region) {
    const SCALE = 500;
    const pixelHa = (SCALE / 1000) ** 2 * 100;

    const reduced = riskLevel.addBands(pNesterov.rename('pNesterov'))
        .addBands(s2Observed45.rename('s2Obs'))
        .reduceRegion({
            reducer:   ee.Reducer.frequencyHistogram()
                .combine(ee.Reducer.mean(), null, true),
            geometry:  region.geometry(),
            scale:     SCALE,
            tileScale: 8,
            maxPixels: 1e10,
        });

    const result = await eeEvaluate(reduced);
    const hist   = result.riskLevel_histogram || {};
    const levelDist = {};
    let totalForestHa = 0;
    let weightedRiskSum = 0;

    for (let l = 1; l <= 5; l++) {
        const ha = (hist[String(l)] || 0) * pixelHa;
        levelDist[l]   = Math.round(ha * 100) / 100;
        totalForestHa += ha;
        weightedRiskSum += ha * l;
    }

    const avgRiskLevel = totalForestHa > 0
        ? Math.round((weightedRiskSum / totalForestHa) * 100) / 100
        : null;

    return {
        totalForestHa:    Math.round(totalForestHa * 100) / 100,
        avgRiskLevel,
        riskLevelDist:    levelDist,
        pNesterovProvMean: Math.round((result.pNesterov_mean || 0) * 100) / 100,
        s2CoverageRatio:   Math.round((result.s2Obs_mean || 0) * 1000) / 1000,
    };
}

/**
 * Compute P Nesterov province-level stats.
 */
async function computePNesterovStats(pNesterov, region) {
    const reduced = pNesterov.reduceRegion({
        reducer:   ee.Reducer.mean()
            .combine(ee.Reducer.max(), null, true)
            .combine(ee.Reducer.percentile([10, 50, 90]), null, true),
        geometry:  region.geometry(),
        scale:     500,
        tileScale: 4,
        maxPixels: 1e10,
    });
    const result = await eeEvaluate(reduced);
    const [p1, p2, p3, p4] = cfg.NESTEROV_P_BREAKS;
    return {
        mean:        Math.round((result.P_Nesterov_mean || 0) * 10) / 10,
        max:         Math.round((result.P_Nesterov_max  || 0) * 10) / 10,
        p10:         Math.round((result['P_Nesterov_p10'] || 0) * 10) / 10,
        p50:         Math.round((result['P_Nesterov_p50'] || 0) * 10) / 10,
        p90:         Math.round((result['P_Nesterov_p90'] || 0) * 10) / 10,
        levelBreaks: { p1, p2, p3, p4 },
    };
}

// ── Raster export (async, GCS → MinIO → GeoServer) ───────────────────────────

/**
 * Submit GEE export task to Google Cloud Storage.
 * Returns GEE task name string (used for polling).
 */
async function submitGeeExportTask(riskLevel, analysisDate) {
    if (!cfg.isGcsConfigured()) {
        throw new Error('GEE_GCS_BUCKET not configured — cannot export raster');
    }
    const dateTag   = analysisDate.replace(/-/g, '');
    const filePrefix = `fire_risk/kontum_fire_risk_level_${dateTag}`;

    const task = ee.batch.Export.image.toCloudStorage({
        image:           riskLevel.toInt8(),
        description:     `fire_risk_level_${dateTag}`,
        bucket:          cfg.GCS_BUCKET,
        fileNamePrefix:  filePrefix,
        scale:           cfg.EXPORT_SCALE_M,
        maxPixels:       1e10,
        region:          getKonTumRegion().geometry(),
        fileFormat:      'GeoTIFF',
        formatOptions:   { cloudOptimized: true },
    });
    task.start();

    // The Node.js SDK returns the task synchronously; get its operation name.
    const taskStatus = await eeEvaluate(task.status());
    return taskStatus.name || taskStatus.id || String(task);
}

// pollGeeTask and publishRaster are provided by gee-export.helper (imported above).

async function publishRaster(analysisDate, gcsPath) {
    if (!cfg.isGcsConfigured()) return null;
    const dateTag  = analysisDate.replace(/-/g, '');
    const fileName = `kontum_fire_risk_level_${dateTag}.tif`;
    return publishRasterToMinio({
        gcsPath,
        bucket:      cfg.GCS_BUCKET,
        fileName,
        minioKey:    `fire_risk/${fileName}`,
        minioBucket: cfg.MINIO_BUCKET,
        storeName:   `fire_risk_${dateTag}`,
        gcsKeyFile:  cfg.GCS_KEY_FILE,
    });
}

// ── High-risk vector features ─────────────────────────────────────────────────

/**
 * Build fire_risk_features rows from district stats (no geometry — stats only).
 * Full vector export requires GCS raster → local reduceToVectors (expensive).
 */
function buildFeaturesFromStats(snapshotId, districtStats) {
    const rows = [];
    for (const d of districtStats) {
        for (let l = 1; l <= 5; l++) {
            const areaHa = d.riskLevelDist[l] || 0;
            if (areaHa <= 0) continue;
            rows.push({
                risk_level:      l,
                district_code:   d.unitCode,
                district_name:   d.name,
                area_ha:         areaHa,
                p_nesterov_mean: d.pNesterovMean,
                ndvi_mean:       null,
                properties:      { s2Coverage: d.s2Coverage },
                geojson:         null,
            });
        }
    }
    return rows;
}

// ── Main orchestration ────────────────────────────────────────────────────────

/**
 * Run the full fire risk analysis for a given analysis date.
 * Called by the cron job or manual refresh.
 *
 * @param {string} analysisDate 'YYYY-MM-DD' — GEE ANALYSIS_END
 * @param {object} opts
 * @param {boolean} opts.submitExport — submit raster export task after stats
 * @returns {object} snapshot row
 */
async function runAnalysis(analysisDate, { submitExport = cfg.isGcsConfigured() } = {}) {
    await initializeEarthEngine();

    // Upsert snapshot → status computing.
    let snapshot = await repo.upsertSnapshot({
        analysis_date: analysisDate,
        status: 'computing',
        model_params: {
            version:             'v8.1',
            feature_window_days: cfg.FEATURE_WINDOW_DAYS,
            nesterov_lookback:   cfg.NESTEROV_LOOKBACK_DAYS,
            nesterov_p_breaks:   cfg.NESTEROV_P_BREAKS,
            risk_score_breaks:   cfg.RISK_SCORE_BREAKS,
            export_scale_m:      cfg.EXPORT_SCALE_M,
            official_thresholds_verified: false,
        },
    });

    try {
        const region    = getKonTumRegion();
        const districts = getKonTumDistricts();

        // Step 1-3: compute indices.
        const { indices: s2Indices, s2Observed45 } = computeS2Indices(region, analysisDate);
        const { lst, lstObserved }                 = computeLST(region, analysisDate);
        const { weatherBands, pNesterov }          = computeWeatherAndNesterov(region, analysisDate);

        // Step 4-5: compute risk.
        const { riskLevel } = computeThresholdRisk(
            region, s2Indices, s2Observed45, lst, lstObserved, weatherBands, pNesterov,
        );

        // Step 6: district and province stats (parallel evaluate calls).
        const [districtStats, provinceSummary, pNesterovStats] = await Promise.all([
            computeDistrictStats(riskLevel, pNesterov, s2Observed45, districts, region),
            computeProvinceSummary(riskLevel, pNesterov, s2Observed45, region),
            computePNesterovStats(pNesterov, region),
        ]);

        // Update snapshot with stats.
        snapshot = await repo.updateStatus(snapshot.id, 'completed', {
            province_summary:  provinceSummary,
            district_stats:    districtStats,
            p_nesterov_stats:  pNesterovStats,
            s2_coverage_ratio: provinceSummary.s2CoverageRatio,
            computed_at:       new Date(),
        });

        // Step 7: save vector features from stats.
        const featureRows = buildFeaturesFromStats(snapshot.id, districtStats);
        await repo.replaceFeatures(snapshot.id, featureRows);

        // Step 8: optionally submit raster export (async).
        if (submitExport) {
            const taskName = await submitGeeExportTask(riskLevel, analysisDate);
            snapshot = await repo.updateStatus(snapshot.id, 'exporting', {
                gee_task_id: taskName,
            });
        }

        return snapshot;
    } catch (err) {
        await repo.updateStatus(snapshot.id, 'failed', {
            error_message: err.message,
        });
        throw err;
    }
}

/**
 * Poll all snapshots in 'exporting' state and publish when GEE task completes.
 * Called by the cron job on each tick.
 */
async function pollExports() {
    const exporting = await repo.listExporting();
    for (const snap of exporting) {
        try {
            const state = await pollGeeTask(snap.gee_task_id);
            if (state === 'COMPLETED') {
                const dateTag  = snap.analysis_date.toISOString().slice(0, 10).replace(/-/g, '');
                const gcsPath  = `fire_risk/kontum_fire_risk_level_${dateTag}`;
                const published = await publishRaster(snap.analysis_date.toISOString().slice(0, 10), gcsPath);
                if (published) {
                    await repo.updateStatus(snap.id, 'published', {
                        ...published,
                        published_at: new Date(),
                    });
                }
            } else if (state === 'FAILED' || state === 'CANCELLED' || state === 'TIMEOUT') {
                await repo.updateStatus(snap.id, 'failed', {
                    error_message: `GEE export task ${state}: ${snap.gee_task_id}`,
                });
            }
        } catch (err) {
            console.error(`[FIRE RISK] pollExports error for snapshot ${snap.id}:`, err.message);
        }
    }
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Get the latest completed snapshot for the API response.
 * Returns { snapshot, features, stale }.
 */
const getLatest = async ({ minRiskLevel = 1 } = {}) => {
    const snapshot = await repo.getLatestCompleted();
    if (!snapshot) {
        const pending = await repo.getLatest();
        if (pending) {
            return { snapshot: pending, features: [], stale: true, computing: true };
        }
        throw new BusinessLogicError(
            'Chưa có dữ liệu cảnh báo cháy rừng. Vui lòng thử lại sau.',
            ['FIRE_RISK_NO_DATA'],
            StatusCodes.SERVICE_UNAVAILABLE,
        );
    }
    const features = await repo.getFeatures(snapshot.id, { minLevel: minRiskLevel });
    return { snapshot, features, stale: false, computing: false };
};

/**
 * Get GeoJSON FeatureCollection of fire risk features for the map.
 */
const getMap = async ({ minRiskLevel = 4 } = {}) => {
    const snapshot = await repo.getLatestCompleted();
    if (!snapshot) {
        return { type: 'FeatureCollection', features: [], snapshotDate: null };
    }
    const rows = await repo.getFeatures(snapshot.id, { minLevel: minRiskLevel });
    const features = rows.map((r) => ({
        type: 'Feature',
        geometry: r.geometry || null,
        properties: {
            id:            r.id,
            riskLevel:     r.risk_level,
            districtCode:  r.district_code,
            districtName:  r.district_name,
            areaHa:        r.area_ha,
            pNesterovMean: r.p_nesterov_mean,
            ndviMean:      r.ndvi_mean,
            ...r.properties,
        },
    }));
    return {
        type:         'FeatureCollection',
        features,
        snapshotDate: snapshot.analysis_date,
        geoserverLayer: snapshot.geoserver_layer || null,
    };
};

/**
 * List completed snapshots (history).
 */
const getHistory = async ({ page = 1, limit = 30 } = {}) =>
    repo.listCompleted({ page, limit });

/**
 * Trigger manual analysis for today (admin only).
 */
const refresh = async ({ analysisDate, submitExport } = {}) => {
    const date = analysisDate || todayUtc();
    return runAnalysis(date, { submitExport });
};

module.exports = {
    runAnalysis,
    pollExports,
    getLatest,
    getMap,
    getHistory,
    refresh,
    todayUtc,
    fmtDate,
};
