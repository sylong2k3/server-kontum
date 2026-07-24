'use strict';

/**
 * Shared fire-warning pipeline for Kon Tum (v8.1, memory-safe).
 *
 * Mirrors docs/kontum_fire_warning_final.js:
 *   - 30-day feature window + 180-day fallback for S2 & MODIS LST
 *   - ERA5-Land Daily proxy for P Nesterov (QĐ 25/2022 lookup)
 *   - MCD64A1 + FireCCI51 + FIRMS training labels (20 dry-season months)
 *   - Random Forest MULTIPROBABILITY classifier
 *   - Blend: 50% input + 30% dataset + 20% threshold (with INPUT)
 *            60% dataset + 40% threshold (without INPUT)
 *   - Data-quality Level 0 when neither S2 nor LST is observed in the window
 *   - Priority warning: model risk (3) | FIRMS recent (4) | confirmed input (5)
 *
 * Consumed by both `fire-risk.service` (scheduled daily snapshot) and
 * `satellite.service` (on-demand /satellite/fire-risk).
 *
 * Node.js GEE SDK note: `.evaluate(cb)` (promisified via eeEval) only when
 * we must materialise a value in JS. All stitching stays server-side.
 */

const cfg = require('../configs/fire-risk');
const { ee } = require('../configs/gge');
const { makeStageLogger } = require('../utils/stage-logger.util');
const { eeGetInfo } = require('../utils/gee-satellite.util');

// ── Small utilities ──────────────────────────────────────────────────────────

function emptyImage(bands) {
    const zeros = bands.map(() => 0);
    return ee.Image.constant(zeros).rename(bands).updateMask(ee.Image.constant(0));
}

function medianOrEmpty(collection, bands) {
    return ee.Image(ee.Algorithms.If(
        collection.size().gt(0),
        collection.select(bands).median(),
        emptyImage(bands),
    ));
}

function firstOrEmpty(collection, bands) {
    return ee.Image(ee.Algorithms.If(
        collection.size().gt(0),
        ee.Image(collection.first()).select(bands),
        emptyImage(bands),
    ));
}

function vaporPressureHpa(tempC) {
    return ee.Image(tempC).expression(
        '6.1078 * exp((17.269 * t) / (237.3 + t))', { t: tempC });
}

// ── Terrain ──────────────────────────────────────────────────────────────────

function getTerrain(region) {
    const dem      = ee.Image('USGS/SRTMGL1_003').clip(region).unmask(0).rename('DEM');
    const products = ee.Terrain.products(dem);
    const slope    = products.select('slope').unmask(0).rename('Slope');
    const aspect   = products.select('aspect').unmask(0).rename('Aspect');
    // Southwest-facing (180-300°) is drier / more fire-prone in Kon Tum.
    const aspectExposure = aspect.expression(
        '(a >= 180 && a <= 300) ? 1.0 : 0.35', { a: aspect }).rename('AspectExposure');
    return { dem, slope, aspect, aspectExposure };
}

// ── Fuel type & forest mask ──────────────────────────────────────────────────

function getFuelInfo(region) {
    if (cfg.LOCAL_FUEL_TYPE_ASSET_ID) {
        // Schema forest-classification v5.3:
        // 0 no-data | 1-11 lớp phủ | 12 không xác định.
        const localClass = ee.Image(cfg.LOCAL_FUEL_TYPE_ASSET_ID)
            .rename('FuelClass').clip(region).unmask(0).toInt16();
        const fuelK = localClass.remap(
            [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
            [0.00, 0.10, 1.20, 0.30, 1.10, 1.00, 1.35, 1.28, 1.30, 1.18, 0.00, 1.05, 0.60],
            0.60,
        ).rename('FuelK');
        // Burnable = mọi thảm thực vật có nguy cơ cháy (không chỉ rừng theo QĐ 99).
        // Bao gồm cây công nghiệp (cao su rất dễ cháy trong mùa khô),
        // rừng 3-8, và trảng cỏ/cây bụi 10. Loại nước 9, đất trồng 2, đất khác 0.
        const burnableMask = localClass.remap(
            [2, 4, 5, 6, 7, 8, 9, 11],
            [1, 1, 1, 1, 1, 1, 1, 1],
            0,
        ).eq(1).rename('BurnableVegetationMask');
        // Alias `forestMask` for backwards compatibility with rest of pipeline;
        // downstream code gates all fire modeling by this mask.
        const forestMask = burnableMask.rename('ForestMask');
        return { fuelClass: localClass, fuelK, forestMask, burnableMask, source: 'LOCAL_FOREST_FUEL_MAP' };
    }

    const igbp = ee.ImageCollection('MODIS/061/MCD12Q1')
        .filterDate('2020-01-01', '2021-01-01')
        .first().select('LC_Type1').clip(region).unmask(0)
        .rename('FuelClass').toInt16();
    const fuelK = igbp.remap(
        [1,2,3,4,5,6,7,8,9,10],
        [1.35,1.00,1.20,1.28,1.10,1.05,1.10,1.12,1.15,1.12],
        0.55,
    ).rename('FuelK');
    // Fallback: mọi lớp vegetation IGBP 1-10 (rừng + shrub + savanna + grassland).
    // Không phải "rừng" theo QĐ 99, mà là "thảm thực vật có thể cháy".
    const burnableMask = igbp.gte(1).and(igbp.lte(10)).rename('BurnableVegetationMask');
    const forestMask = burnableMask.rename('ForestMask');
    return { fuelClass: igbp, fuelK, forestMask, burnableMask, source: 'MODIS_IGBP_FALLBACK' };
}

// ── Sentinel-2 (30-day primary + 180-day fallback) ───────────────────────────

const S2_BANDS = ['B2','B3','B4','B8','B11','B12'];

function prepS2(image) {
    const scl = image.select('SCL');
    const mask = scl.neq(3).and(scl.neq(8)).and(scl.neq(9))
        .and(scl.neq(10)).and(scl.neq(11)).and(scl.neq(0)).and(scl.neq(1));
    return image.select(S2_BANDS).multiply(0.0001).updateMask(mask)
        .copyProperties(image, ['system:time_start']);
}

function s2Collection(region, startDate, endDate) {
    return ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
        .filterBounds(region).filterDate(startDate, endDate)
        .filter(ee.Filter.lte('CLOUDY_PIXEL_PERCENTAGE', 85))
        .map(prepS2);
}

/**
 * S2 reflectance with primary (feature window) + optional fallback (180-day
 * history). Emits observation flags:
 *   S2_ObservedWindow  = 1 when primary window has valid pixels here.
 *   S2_FallbackWindow = 1 when only the history window contributes.
 *   S2_DataSource  = 0 none | 1 primary | 2 fallback only.
 */
function getSafeS2Reflectance(region, startDate, endDate, useFallback) {
    const start   = ee.Date(startDate);
    const end     = ee.Date(endDate);
    const primary = medianOrEmpty(s2Collection(region, start, end), S2_BANDS);

    const fallback = useFallback
        ? medianOrEmpty(
            s2Collection(region, start.advance(-cfg.S2_FALLBACK_DAYS, 'day'), start),
            S2_BANDS)
        : emptyImage(S2_BANDS);

    const primaryValid = primary.mask().reduce(ee.Reducer.min()).unmask(0).rename('S2_ObservedWindow');
    const fallbackValid = fallback.mask().reduce(ee.Reducer.min()).unmask(0).rename('S2_FallbackWindow');

    const merged   = primary.unmask(fallback);
    const neutral  = ee.Image.constant([0.12, 0.10, 0.08, 0.40, 0.20, 0.12]).rename(S2_BANDS);
    const filled   = merged.unmask(neutral).rename(S2_BANDS);

    const s2DataSource = ee.Image.constant(0)
        .where(primaryValid.eq(1), 1)
        .where(primaryValid.eq(0).and(fallbackValid.eq(1)), 2)
        .toByte().rename('S2_DataSource');

    return filled.addBands(primaryValid).addBands(fallbackValid).addBands(s2DataSource).clip(region);
}

function getS2Indices(region, startDate, endDate, useFallback) {
    const s2   = getSafeS2Reflectance(region, startDate, endDate, useFallback);
    const ndvi = s2.normalizedDifference(['B8','B4']).rename('NDVI');
    const ndmi = s2.normalizedDifference(['B8','B11']).rename('NDMI');
    const nbr  = s2.normalizedDifference(['B8','B12']).rename('NBR');
    return ndvi.addBands(ndmi).addBands(nbr)
        .addBands(s2.select(['S2_ObservedWindow', 'S2_FallbackWindow', 'S2_DataSource']))
        .clip(region);
}

// ── ERA5-Land weather features ───────────────────────────────────────────────

function getWeatherFeatures(region, startDate, endDate) {
    const wx = ee.ImageCollection('ECMWF/ERA5_LAND/DAILY_AGGR')
        .filterBounds(region).filterDate(startDate, endDate);

    const airTemp = wx.select('temperature_2m').mean()
        .subtract(273.15).rename('AirTemp_C').unmask(25);
    const dewPoint = wx.select('dewpoint_temperature_2m').mean()
        .subtract(273.15).rename('DewPoint_C').unmask(18);

    const rainfall = wx.select('total_precipitation_sum').sum()
        .max(0).multiply(1000).rename('Rainfall_mm').unmask(0);

    const windSpeed = wx.select(['u_component_of_wind_10m','v_component_of_wind_10m'])
        .map((img) => {
            const u = img.select('u_component_of_wind_10m');
            const v = img.select('v_component_of_wind_10m');
            return u.pow(2).add(v.pow(2)).sqrt().rename('Wind_mps');
        }).mean().multiply(3.6).rename('Wind_kmh').unmask(5);

    const vpd = vaporPressureHpa(airTemp).subtract(vaporPressureHpa(dewPoint))
        .max(0).rename('VPD_hPa').unmask(8);

    return airTemp.addBands(dewPoint).addBands(rainfall)
        .addBands(windSpeed).addBands(vpd).clip(region);
}

// ── MODIS LST (30-day primary + 180-day fallback) ────────────────────────────

function prepareLst(image) {
    const qa = image.select('QC_Day');
    const mandatoryQa = qa.bitwiseAnd(3);
    const valid = mandatoryQa.lte(1);
    return image.select('LST_Day_1km').updateMask(valid)
        .multiply(cfg.LST_SCALE_FACTOR).subtract(cfg.LST_KELVIN_OFFSET).rename('LST_C');
}

function getSafeLstFeatures(region, startDate, endDate, airTempImage, useFallback) {
    const start = ee.Date(startDate);
    const end   = ee.Date(endDate);

    const primary = medianOrEmpty(
        ee.ImageCollection('MODIS/061/MOD11A1').filterBounds(region)
            .filterDate(start, end).map(prepareLst),
        ['LST_C']);

    const fallback = useFallback
        ? medianOrEmpty(
            ee.ImageCollection('MODIS/061/MOD11A1').filterBounds(region)
                .filterDate(start.advance(-cfg.LST_FALLBACK_DAYS, 'day'), start)
                .map(prepareLst),
            ['LST_C'])
        : emptyImage(['LST_C']);

    const merged        = primary.unmask(fallback).rename('LST_C');
    const primaryValid  = primary.mask().unmask(0).rename('LST_ObservedWindow');
    const fallbackValid = fallback.mask().unmask(0).rename('LST_FallbackWindow');

    const lstDataSource = ee.Image.constant(0)
        .where(primaryValid.eq(1), 1)
        .where(primaryValid.eq(0).and(fallbackValid.eq(1)), 2)
        .toByte().rename('LST_DataSource');

    const filled = merged.unmask(airTempImage.rename('LST_C')).rename('LST_C');

    return filled.addBands(primaryValid).addBands(fallbackValid).addBands(lstDataSource).clip(region);
}

// ── Nesterov P (with rain-reset iteration) ───────────────────────────────────

function buildNesterovP(region, endDate) {
    const end   = ee.Date(endDate);
    const start = end.advance(-cfg.NESTEROV_LOOKBACK_DAYS, 'day');

    const dailyCollection = ee.ImageCollection('ECMWF/ERA5_LAND/DAILY_AGGR')
        .filterBounds(region).filterDate(start, end)
        .sort('system:time_start')
        .map((img) => {
            const tempC   = img.select('temperature_2m').subtract(273.15).max(0);
            const dewC    = img.select('dewpoint_temperature_2m').subtract(273.15);
            const deficit = vaporPressureHpa(tempC).subtract(vaporPressureHpa(dewC)).max(0);
            const rainMm  = img.select('total_precipitation_sum').max(0).multiply(1000);
            const dailyTerm = tempC.multiply(deficit).rename('dailyTerm');
            const rainReset = rainMm.gt(cfg.RAIN_RESET_MM).rename('rainReset');
            return dailyTerm.addBands(rainReset);
        });

    const dailyList = dailyCollection.toList(cfg.NESTEROV_LOOKBACK_DAYS);

    // iterate(): accumulate P daily, resetting to 0 on rainy days.
    // The reducer callback receives the current day image and the running
    // P image; each rainy pixel zeroes the running sum for the next day.
    const p = ee.Image(dailyList.iterate((day, prev) => {
        const dayImg = ee.Image(day);
        const next   = ee.Image(prev).add(dayImg.select('dailyTerm'));
        return next.where(dayImg.select('rainReset').eq(1), 0);
    }, ee.Image.constant(0)));

    return p.rename('NesterovP').clip(region);
}

function nesterovPToScore(pImage) {
    // Ngưỡng lấy từ cfg.NESTEROV_P_BREAKS (env-configurable) — không hard-code.
    const [b0, b1, b2, b3] = cfg.NESTEROV_P_BREAKS;
    return ee.Image(pImage).expression(
        `(x <= ${b0}) ? 0.10`
        + `: (x <= ${b1}) ? 0.30`
        + `: (x <= ${b2}) ? 0.55`
        + `: (x <= ${b3}) ? 0.78`
        + ': 1.00',
        { x: pImage },
    ).rename('NesterovScore');
}

// Cấp proxy theo P: 1-5. KHÔNG phải cấp cảnh báo cháy chính thức theo
// QĐ 25/2022 — đây là proxy tính từ ERA5-Land daily aggregate. Tên band
// đã đổi từ "NesterovOfficialLevel" (v8.1) → "NesterovProxyLevel" để tránh
// hiểu nhầm là con số chính thức của cơ quan quản lý.
function nesterovPToProxyLevel(pImage) {
    const [b0, b1, b2, b3] = cfg.NESTEROV_P_BREAKS;
    return ee.Image(pImage).expression(
        `(x <= ${b0}) ? 1`
        + `: (x <= ${b1}) ? 2`
        + `: (x <= ${b2}) ? 3`
        + `: (x <= ${b3}) ? 4`
        + ': 5',
        { x: pImage },
    ).toByte().rename('NesterovProxyLevel');
}

// ── Predictor image bundling ─────────────────────────────────────────────────

const PREDICTOR_BANDS = [
    'NDVI','NDMI','NBR',
    'S2_ObservedWindow','S2_FallbackWindow','S2_DataSource',
    'LST_C','LST_ObservedWindow','LST_FallbackWindow','LST_DataSource',
    'AirTemp_C','Rainfall_mm','Wind_kmh','VPD_hPa',
    'Slope','AspectExposure',
    'FuelK','NesterovP',
];

const RF_PREDICTOR_BANDS = [
    'NDVI','NDMI','NBR',
    'LST_C','AirTemp_C','Rainfall_mm','Wind_kmh','VPD_hPa',
    'Slope','AspectExposure',
    'FuelK','NesterovP',
];

function getPredictorImage(region, anchorDate, useFallback, precomputed = {}) {
    const end   = ee.Date(anchorDate);
    const start = end.advance(-cfg.FEATURE_WINDOW_DAYS, 'day');

    const s2 = getS2Indices(region, start, end, useFallback);
    const wx = getWeatherFeatures(region, start, end);
    const lst = getSafeLstFeatures(region, start, end, wx.select('AirTemp_C'), useFallback);
    const p   = buildNesterovP(region, end).rename('NesterovP');

    const terrain = precomputed.terrain || getTerrain(region);
    const fuel    = precomputed.fuel    || getFuelInfo(region);

    return s2.addBands(lst).addBands(wx)
        .addBands(terrain.slope).addBands(terrain.aspectExposure)
        .addBands(fuel.fuelK).addBands(p)
        .select(PREDICTOR_BANDS).toFloat().clip(region);
}

// ── Training labels (MCD64A1 + FireCCI51 + FIRMS) ────────────────────────────

function getMcdLabel(region, monthStart) {
    const start = ee.Date(monthStart);
    const end   = start.advance(1, 'month');

    const image = firstOrEmpty(
        ee.ImageCollection('MODIS/061/MCD64A1').filterBounds(region).filterDate(start, end),
        ['BurnDate','Uncertainty','QA']);
    const qa = image.select('QA').toUint8();

    // MCD64A1 v6.1 QA là BITMASK, không phải giá trị categorical:
    //   bit 0 (=1): Land/water flag — 1 = land, 0 = water/coast
    //   bit 1 (=2): Valid data flag  — 1 = valid observation, 0 = fill
    // Trước đây code dùng qa.eq(2) sẽ bắt được pixel water-with-valid-data
    // và bỏ sót pixel land-with-valid-data (QA=3).
    const isLand       = qa.bitwiseAnd(1).neq(0);
    const hasValidData = qa.bitwiseAnd(2).neq(0);
    const observed = isLand.and(hasValidData).and(image.select('BurnDate').mask())
        .unmask(0).rename('MCD_Observed');
    const landMask = isLand.unmask(0).rename('MCD_Land');
    const burned   = image.select('BurnDate').gt(0)
        .and(observed)
        .and(image.select('Uncertainty').lte(cfg.MCD_MAX_UNCERTAINTY_DAY))
        .unmask(0).rename('MCD_Burned');
    return { observed, landMask, burned };
}

function getFireCciLabel(region, monthStart) {
    const start = ee.Date(monthStart);
    const end   = start.advance(1, 'month');
    const image = firstOrEmpty(
        ee.ImageCollection('ESA/CCI/FireCCI/5_1').filterBounds(region).filterDate(start, end),
        ['BurnDate','ConfidenceLevel','ObservedFlag']);

    // ObservedFlag: -2 unburnable, -1 not observed. Everything else (incl. 0)
    // is a valid observation month.
    const observed = image.select('ObservedFlag').gte(0)
        .and(image.select('BurnDate').mask())
        .unmask(0).rename('FireCCI_Observed');
    const burned = image.select('BurnDate').gt(0).and(observed)
        .and(image.select('ConfidenceLevel').gte(cfg.FIRECCI_MIN_CONFIDENCE))
        .unmask(0).rename('FireCCI_Burned');
    return { observed, burned };
}

function getFirmsHotspot(region, startDate, endDate) {
    const collection = ee.ImageCollection('FIRMS').filterBounds(region).filterDate(startDate, endDate);
    // Filter TỪNG ảnh: T21 và confidence phải cùng thoả trên cùng detection.
    // Trước đây max(T21) và max(confidence) lấy độc lập → 1 pixel có thể "đạt"
    // ngưỡng từ 2 detection khác nhau (T21 cao ngày A, confidence cao ngày B).
    const perImageHotspot = collection.map((img) =>
        img.select('T21').gte(cfg.FIRMS_MIN_T21_K)
            .and(img.select('confidence').gte(cfg.FIRMS_MIN_CONFIDENCE))
            .rename('hotspot'),
    );
    return ee.Image(ee.Algorithms.If(
        collection.size().gt(0),
        perImageHotspot.max(),
        ee.Image.constant(0).rename('hotspot'),
    )).unmask(0).rename('FIRMS_Hotspot');
}

function getTrainingLabels(region, monthStart) {
    const start = ee.Date(monthStart);
    const end   = start.advance(1, 'month');
    const mcd     = getMcdLabel(region, start);
    const fireCci = getFireCciLabel(region, start);
    const firms   = getFirmsHotspot(region, start, end);

    const label = mcd.burned.or(fireCci.burned).or(firms).unmask(0).toByte().rename('label');
    const negativeEligibleImage = cfg.NEGATIVE_ELIGIBLE_MODE === 'strict_observed'
        ? mcd.observed.or(fireCci.observed)
        : mcd.landMask.or(fireCci.observed);
    const negativeEligible = negativeEligibleImage.unmask(0).toByte().rename('negativeEligible');
    return { label, negativeEligible };
}

// ── Per-month training sample (stratifiedSample, no mask dilation) ────────────

function makeTrainingSamples(region, forestMask, monthText, monthIndex) {
    const predictors = getPredictorImage(region, monthText, cfg.TRAIN_USE_FALLBACK);
    const labelInfo  = getTrainingLabels(region, monthText);

    const positiveMask = labelInfo.label.eq(1).and(forestMask);
    const negativeMask = labelInfo.negativeEligible.eq(1).and(labelInfo.label.eq(0)).and(forestMask);

    // Chỉ giữ pixel eligible (positive HOẶC negative); tất cả pixel ngoài
    // eligibleMask bị loại qua updateMask nên không dính vào stratifiedSample.
    // Không dùng "-1 → toByte()" nữa vì toByte(-1) = 255 (unsigned wrap),
    // gate `classBand.gte(0)` không loại được → sample nhận nhãn 255.
    const eligibleMask = positiveMask.or(negativeMask);
    const classBand = ee.Image.constant(0)
        .where(positiveMask, 1)
        .rename('classLabel').toByte();

    const trainingObservedMask = predictors.select('S2_ObservedWindow').eq(1)
        .or(predictors.select('LST_ObservedWindow').eq(1));

    const image = predictors.select(RF_PREDICTOR_BANDS).addBands(classBand)
        .updateMask(eligibleMask.and(trainingObservedMask));

    return image.stratifiedSample({
        numPoints:  cfg.TRAIN_SAMPLES_PER_CLASS,
        classBand:  'classLabel',
        region:     region.geometry(),
        scale:      cfg.TRAIN_SCALE_M,
        seed:       cfg.RANDOM_SEED + monthIndex,
        tileScale:  cfg.TRAIN_HEAVY_TILE_SCALE,
        geometries: false,
        dropNulls:  true,
    }).map((f) => f.set({ label: f.get('classLabel'), month_start: monthText }));
}

function buildTrainingCollection(region, forestMask) {
    const perMonth = cfg.TRAIN_MONTHS.map((month, idx) =>
        makeTrainingSamples(region, forestMask, month, idx));
    return ee.FeatureCollection(perMonth).flatten()
        .filter(ee.Filter.notNull(RF_PREDICTOR_BANDS.concat(['label'])));
}

/**
 * Validate training FC has enough samples per class before RF training.
 * Returns { ok, counts, missing } where:
 *   - counts:  { '0': N0, '1': N1 } histogram
 *   - missing: array of class labels below cfg.MIN_SAMPLES_PER_CLASS
 * Cost: 1 aggregate_histogram getInfo() call, typically 5-15s.
 * Async — must be awaited before deciding to train.
 */
async function validateTrainingCounts(trainingFC) {
    const hist = await eeGetInfo(trainingFC.aggregate_histogram('label'),
        cfg.GEE_TIMEOUT_MS);
    const counts = hist || {};
    const min = cfg.MIN_SAMPLES_PER_CLASS;
    const missing = [];
    for (const cls of ['0', '1']) {
        const n = Number(counts[cls] || 0);
        if (n < min) missing.push({ class: cls, count: n });
    }
    return { ok: missing.length === 0, counts, missing };
}

// ── Random Forest classifier ─────────────────────────────────────────────────

function trainRf(trainingFeatures) {
    const rf = ee.Classifier.smileRandomForest({
        numberOfTrees:     cfg.RF_TREES,
        variablesPerSplit: cfg.RF_VARIABLES_PER_SPLIT || null,
        minLeafPopulation: cfg.RF_MIN_LEAF_POPULATION,
        bagFraction:       cfg.RF_BAG_FRACTION,
        seed:              cfg.RANDOM_SEED,
    }).setOutputMode('MULTIPROBABILITY')
      .train({
          features:        trainingFeatures,
          classProperty:   'label',
          inputProperties: RF_PREDICTOR_BANDS,
      });
    return rf;
}

function classifyRfProbability(currentPredictors, trainingFeatures) {
    const classifier = trainRf(trainingFeatures);
    return applyRfClassifier(currentPredictors, classifier);
}

// Reuse-friendly variant: apply a pre-trained classifier so the caller can
// hold onto it (e.g. để tính OOB qua `.explain().getInfo()` sau khi
// classify) — tránh train 2 lần.
function applyRfClassifier(currentPredictors, classifier) {
    const probability = currentPredictors.select(RF_PREDICTOR_BANDS).classify(classifier);
    const bands = probability.arrayFlatten([['probability_no_fire', 'probability_fire']]);
    return bands.select('probability_fire').max(0).min(1).rename('DatasetModelScore');
}

// ── Threshold score ──────────────────────────────────────────────────────────

function computeFixedThresholdScore(currentPredictors, fuelK) {
    const nesterovP     = currentPredictors.select('NesterovP');
    const nesterovScore = nesterovPToScore(nesterovP);

    const ndmiDrynessScore = currentPredictors.select('NDMI').expression(
        '(x > 0.35) ? 0.05 : (x > 0.20) ? 0.30 : (x > 0.05) ? 0.60 : (x > -0.05) ? 0.82 : 1.00',
        { x: currentPredictors.select('NDMI') }).rename('NDMI_DrynessScore');

    const fuelLoadScore = currentPredictors.select('NDVI').expression(
        '(x < 0.18) ? 0.10 : (x < 0.35) ? 0.55 : (x < 0.70) ? 1.00 : 0.65',
        { x: currentPredictors.select('NDVI') }).rename('FuelLoadScore');

    const vegetationThresholdScore = ndmiDrynessScore.multiply(0.65)
        .add(fuelLoadScore.multiply(0.35))
        .multiply(fuelK.divide(1.1).max(0.65).min(1.25))
        .max(0).min(1).rename('VegetationThresholdScore');

    const slopeScore = currentPredictors.select('Slope').expression(
        '(s < 5) ? 0.05 : (s < 15) ? 0.30 : (s < 25) ? 0.65 : 1.00',
        { s: currentPredictors.select('Slope') }).rename('SlopeScore');
    const terrainThresholdScore = slopeScore.multiply(0.75)
        .add(currentPredictors.select('AspectExposure').multiply(0.25))
        .rename('TerrainThresholdScore');

    const windScore = currentPredictors.select('Wind_kmh').expression(
        '(w < 5) ? 0.05 : (w < 10) ? 0.25 : (w < 20) ? 0.55 : (w < 30) ? 0.78 : 1.00',
        { w: currentPredictors.select('Wind_kmh') }).rename('WindScore');
    const vpdScore = currentPredictors.select('VPD_hPa').expression(
        '(v < 6) ? 0.05 : (v < 12) ? 0.30 : (v < 20) ? 0.60 : (v < 28) ? 0.80 : 1.00',
        { v: currentPredictors.select('VPD_hPa') }).rename('VPDScore');
    const spreadWeatherScore = windScore.multiply(0.55)
        .add(vpdScore.multiply(0.45)).rename('SpreadWeatherScore');

    return nesterovScore.multiply(0.45)
        .add(vegetationThresholdScore.multiply(0.25))
        .add(terrainThresholdScore.multiply(0.20))
        .add(spreadWeatherScore.multiply(0.10))
        .max(0).min(1).rename('FixedThresholdScore');
}

// ── Input asset (optional user-supplied fire hotspots) ───────────────────────

/**
 * Build input burn overlay từ 1 trong 2 nguồn:
 *   (a) `source.assetId` — GEE FeatureCollection asset (cách cũ)
 *   (b) `source.geojson` — GeoJSON FeatureCollection inline (cách mới — dùng
 *       cho ground truth từ PostGIS, không cần upload asset).
 *
 * Cả 2 đều expect properties: { severity 1-5, occurredAt }. Score được suy
 * từ severity (`(severity-1)/4` → 0-1) nếu không có `input_score` explicit.
 */
function buildInputImages(region, forestMask, source) {
    // Backward compat: nếu source là string → coi như assetId cũ.
    const assetId = typeof source === 'string' ? source : source?.assetId;
    const inlineGeoJson = typeof source === 'object' && source?.geojson;

    if (!assetId && !inlineGeoJson) {
        return {
            inputRiskScore:     ee.Image.constant(0).rename('InputRiskScore').toFloat().updateMask(forestMask).clip(region),
            inputCoverage:      ee.Image.constant(0).rename('InputCoverage').toByte().updateMask(forestMask).clip(region),
            confirmedInputMask: ee.Image.constant(0).rename('ConfirmedInputMask').toByte().updateMask(forestMask).clip(region),
            features:           null,
        };
    }

    // Build features: từ asset hoặc từ inline GeoJSON.
    let features;
    if (inlineGeoJson) {
        // Convert GeoJSON → ee.FeatureCollection. Đơn giản khi FC nhỏ (<1000).
        const eeFeatures = inlineGeoJson.features.map((f) => {
            const p = f.properties || {};
            const severity = Number(p.severity) || 3;
            const inputScore = Math.max(0, Math.min(1, (severity - 1) / 4));
            return ee.Feature(f.geometry, {
                input_score: inputScore,
                severity,
                confirmed:   1,   // GT được xác nhận field → confirmed=1
                occurredAt:  p.occurredAt || null,
                gt_id:       p.gt_id || null,
            });
        });
        features = ee.FeatureCollection(eeFeatures).filterBounds(region);
    } else {
        features = ee.FeatureCollection(assetId).filterBounds(region);
    }
    const buffered = features.map((f) => {
        const rawScore = ee.Number(ee.Algorithms.If(
            f.propertyNames().contains('input_score'),
            f.get('input_score'), 0));
        const safe = rawScore.max(0).min(1);
        return f.buffer(cfg.INPUT_BUFFER_M).copyProperties(f)
            .set('input_score_clamped', safe);
    });

    const inputRiskScore = ee.Image.constant(0).toFloat()
        .paint(buffered, 'input_score_clamped')
        .max(0).min(1).rename('InputRiskScore')
        .updateMask(forestMask).clip(region);
    const inputCoverage = ee.Image.constant(0).toByte()
        .paint(buffered, 1).unmask(0).rename('InputCoverage')
        .updateMask(forestMask).clip(region);
    const confirmed = buffered.filter(ee.Filter.eq('confirmed', 1));
    const confirmedInputMask = ee.Image.constant(0).toByte()
        .paint(confirmed, 1).unmask(0).rename('ConfirmedInputMask')
        .updateMask(forestMask).clip(region);
    return { inputRiskScore, inputCoverage, confirmedInputMask, features };
}

// ── Final blend + risk levels + confidence + priority ────────────────────────

function buildRiskProducts({
    currentPredictors,
    forestMask,
    fixedThresholdScore,
    datasetModelScore,
    inputImages,
    firmsInfluence,
    rfEnabled,
    region,
}) {
    const { inputRiskScore, inputCoverage, confirmedInputMask } = inputImages;

    const scoreWithInput = inputRiskScore.multiply(cfg.WEIGHT_INPUT_WITH_INPUT)
        .add(datasetModelScore.multiply(cfg.WEIGHT_RF_WITH_INPUT))
        .add(fixedThresholdScore.multiply(cfg.WEIGHT_THRESHOLD_WITH_INPUT))
        .rename('Risk_WithInput');
    const scoreWithoutInput = datasetModelScore.multiply(cfg.WEIGHT_RF)
        .add(fixedThresholdScore.multiply(cfg.WEIGHT_THRESHOLD))
        .rename('Risk_WithoutInput');

    const finalFireRiskScore = scoreWithoutInput
        .where(inputCoverage.eq(1), scoreWithInput)
        .max(0).min(1)
        .updateMask(forestMask)
        .rename('FinalFireRiskScore');

    const blendCase = ee.Image.constant(2)
        .where(inputCoverage.eq(1), 1)
        .updateMask(forestMask).rename('BlendCase');

    // Data-quality gating.
    // `validData` = S2 HOẶC LST có dữ liệu trong window (giữ tương thích cũ).
    // `fullyCurrent` = cả S2 VÀ LST đều có dữ liệu; là điều kiện chặt hơn
    // dùng để đánh dấu pixel mà cả vegetation lẫn thermal đều tươi mới.
    const s2Obs      = currentPredictors.select('S2_ObservedWindow').eq(1);
    const lstObs     = currentPredictors.select('LST_ObservedWindow').eq(1);
    const s2Fb       = currentPredictors.select('S2_FallbackWindow').eq(1);
    const lstFb      = currentPredictors.select('LST_FallbackWindow').eq(1);
    const validData  = s2Obs.or(lstObs).rename('DataObservedWindowMask');
    const fullyCurrent = s2Obs.and(lstObs).rename('DataFullyCurrentMask');
    const fallbackOnly = validData.not().and(s2Fb.or(lstFb)).rename('DataFallbackOnlyMask');
    const dataSourceClass = ee.Image.constant(0)
        .where(fallbackOnly.eq(1), 1)
        .where(validData.eq(1), 2)
        .where(fullyCurrent.eq(1), 3)
        .toByte().updateMask(forestMask).rename('DataSourceClass');

    // Model confidence 0-3.
    const observationWindowFraction = s2Obs.add(lstObs).divide(2).rename('ObservationWindowFraction');
    const baseConfidence   = ee.Image.constant(rfEnabled ? 0.65 : 0.40);
    const validityMult     = ee.Image.constant(0.6)
        .add(observationWindowFraction.multiply(0.4)).rename('ObservationWindowMultiplier');
    const modelConfidence  = baseConfidence.multiply(validityMult)
        .where(validData.eq(0), 0)
        .where(inputCoverage.eq(1).and(validData.eq(1)), 0.9)
        .where(confirmedInputMask.eq(1), 1.0)
        .updateMask(forestMask).rename('ModelConfidence');
    const modelConfidenceClass = ee.Image.constant(0)
        .where(validData.eq(1).and(modelConfidence.lt(0.5)), 1)
        .where(validData.eq(1).and(modelConfidence.gte(0.5)).and(modelConfidence.lt(0.75)), 2)
        .where(validData.eq(1).and(modelConfidence.gte(0.75)), 3)
        .toByte().updateMask(forestMask).rename('ModelConfidenceClass');

    // Risk level 0-5.
    const [b0, b1, b2, b3] = cfg.RISK_SCORE_BREAKS;
    const riskLevelRaw = finalFireRiskScore.expression(
        '(r < b0) ? 1 : (r < b1) ? 2 : (r < b2) ? 3 : (r < b3) ? 4 : 5',
        { r: finalFireRiskScore, b0, b1, b2, b3 },
    ).toByte();
    const riskLevel = riskLevelRaw.where(validData.eq(0), 0)
        .updateMask(forestMask).rename('RiskLevel');

    // Priority warning: model 3, FIRMS recent 4, confirmed input 5.
    const priorityFireWarning = ee.Image.constant(0)
        .where(riskLevel.gte(4).and(validData.eq(1)), 3)
        .where(firmsInfluence.eq(1), 4)
        .where(confirmedInputMask.eq(1), 5)
        .updateMask(riskLevel.gte(4).and(validData.eq(1))
            .or(firmsInfluence.eq(1))
            .or(confirmedInputMask.eq(1)))
        .rename('PriorityFireWarning');

    return {
        finalFireRiskScore: finalFireRiskScore.clip(region),
        riskLevel:          riskLevel.clip(region),
        blendCase:          blendCase.clip(region),
        dataSourceClass:    dataSourceClass.clip(region),
        modelConfidence:    modelConfidence.clip(region),
        modelConfidenceClass: modelConfidenceClass.clip(region),
        priorityFireWarning:  priorityFireWarning.clip(region),
        validData,
        fullyCurrent,
    };
}

// ── End-to-end runner ────────────────────────────────────────────────────────

/**
 * Full v8.1 fire-risk analysis for a region + anchor date.
 * Returns predictors, scores, riskLevel and derived layers so callers can
 * publish tiles, run reduceRegions, or export GeoTIFF.
 *
 * NOTE: async so mỗi bước dựng graph được mark qua stage logger (A → Z).
 * Không gọi evaluate() ở đây — mọi ee.Image trả về vẫn là lazy graph.
 *
 * @param {ee.FeatureCollection|ee.Geometry} region
 * @param {string} analysisDate                              'YYYY-MM-DD'
 * @param {object} [opts]
 * @param {boolean} [opts.enableRf=cfg.ENABLE_RF]            train + apply RF
 * @param {string}  [opts.inputFireAssetId=cfg.INPUT_FIRE_ASSET_ID]
 * @param {object}  [opts.logger]                            stage-logger reuse
 */
function runFireRiskAnalysis(region, analysisDate, opts = {}) {
    const enableRf         = opts.enableRf ?? cfg.ENABLE_RF;
    const inputFireAssetId = opts.inputFireAssetId ?? cfg.INPUT_FIRE_ASSET_ID;
    // NEW: inline GT từ PostGIS. Ưu tiên hơn assetId nếu present.
    const inputFireGeoJson = opts.inputFireGeoJson || null;
    // OOB accuracy: bật riêng, chỉ có ý nghĩa khi enableRf=true. Mặc định lấy
    // từ config (env FIRE_RISK_COMPUTE_OOB). Tốn 1 getInfo() thêm ~30-90s vì
    // force RF training materialize trên EE server.
    const computeOob = (opts.computeOob ?? cfg.COMPUTE_OOB) && enableRf;

    // Logger có thể được caller cung cấp để hợp nhất luồng A→Z của service +
    // pipeline. Nếu không, dựng logger cục bộ để pipeline vẫn có dấu vết.
    const log = opts.logger || makeStageLogger('FIRE-RISK-PL', { correlationId: analysisDate });

    const inputSourceDesc = inputFireGeoJson
        ? `inlineGT(${inputFireGeoJson.features?.length || 0} features)`
        : (inputFireAssetId || '(none)');
    log.mark('Pipeline config',
        `analysisDate=${analysisDate} enableRf=${enableRf} inputSource=${inputSourceDesc}`);

    // Toàn bộ khối "build" là graph EE lazy — timing chỉ đo dựng graph, không đo compute.
    const terrain = log.run('Build terrain bands (DEM + slope + aspect exposure) [LAZY]',
        () => Promise.resolve(getTerrain(region)));
    const fuel    = log.run('Build fuel info + forest mask [LAZY]',
        () => Promise.resolve(getFuelInfo(region)));
    // Đồng bộ ngay ở đây vì bên dưới cần forestMask/fuelK.
    // Await chỉ chờ log — chưa gọi evaluate().
    return (async () => {
        const terrainVal = await terrain;
        const fuelVal    = await fuel;
        const forestMask = fuelVal.forestMask;

        const currentPredictors = await log.run(
            'Build current predictor image (S2 30d + LST 30d + ERA5 + terrain + fuel + P Nesterov) [LAZY]',
            () => Promise.resolve(getPredictorImage(region, analysisDate, true,
                { terrain: terrainVal, fuel: fuelVal })),
            { note: `${PREDICTOR_BANDS.length} bands, fallback S2/LST 180d enabled` },
        );

        const fixedThresholdScore = await log.run(
            'Build fixed threshold score (P + veg + terrain + spread weather) [LAZY]',
            () => Promise.resolve(computeFixedThresholdScore(currentPredictors, fuelVal.fuelK)),
        );

        let datasetModelScore;
        let rfClassifier   = null;
        let oobPct         = null;
        let rfSkipReason   = null;   // populated khi RF bị skip do thiếu mẫu
        let trainingCounts = null;   // histogram nhãn thực tế (0/1)
        if (enableRf) {
            const trainingFC = await log.run(
                `Build RF training collection over ${cfg.TRAIN_MONTHS.length} months [LAZY]`,
                () => Promise.resolve(buildTrainingCollection(region, forestMask)),
                {
                    note: `MCD64A1 + FireCCI51 + FIRMS; ${cfg.TRAIN_SAMPLES_PER_CLASS}/class/month, scale=${cfg.TRAIN_SCALE_M}m tileScale=${cfg.TRAIN_HEAVY_TILE_SCALE}`,
                },
            );
            // Pre-train guard: bắt buộc có tối thiểu MIN_SAMPLES_PER_CLASS mẫu
            // cho MỖI lớp (0=no-fire, 1=fire). Nếu thiếu, fallback về threshold-only
            // để tránh RF learn trên tập lệch/mất một lớp (arrayFlatten 2 prob sai).
            const validation = await log.run(
                'GETINFO training-sample histogram (guard MIN_SAMPLES_PER_CLASS)',
                () => validateTrainingCounts(trainingFC),
                { note: `min=${cfg.MIN_SAMPLES_PER_CLASS}/class` },
            );
            trainingCounts = validation.counts;
            log.mark('Training sample counts',
                `no_fire=${validation.counts['0'] || 0} fire=${validation.counts['1'] || 0}`);

            if (!validation.ok) {
                rfSkipReason = `Insufficient samples: ${validation.missing.map((m) => `class=${m.class} n=${m.count}`).join('; ')} < ${cfg.MIN_SAMPLES_PER_CLASS}`;
                log.mark('⚠ RF skipped', rfSkipReason);
                datasetModelScore = await log.run(
                    'FALLBACK — DatasetModelScore = 0.85 × ThresholdScore (RF skipped) [LAZY]',
                    () => Promise.resolve(fixedThresholdScore.multiply(0.85).rename('DatasetModelScore')),
                );
                // Không train, không explain OOB.
            } else {
            // Split train + apply để giữ tham chiếu classifier cho OOB (tránh
            // train 2 lần). Vẫn LAZY: `trainRf` chỉ build graph.
            rfClassifier = await log.run(
                'Assemble RF classifier graph (train deferred) [LAZY]',
                () => Promise.resolve(trainRf(trainingFC)),
                { note: `${cfg.RF_TREES} trees, bag=${cfg.RF_BAG_FRACTION}` },
            );
            datasetModelScore = await log.run(
                'Classify RF probability (apply pre-trained classifier) [LAZY — deferred until evaluate()]',
                () => Promise.resolve(applyRfClassifier(currentPredictors, rfClassifier)),
            );
            // OOB accuracy: `.explain()` trả outOfBagErrorEstimate. getInfo()
            // force RF training materialize trên EE server, thường 30-90s. Chạy
            // trước khi evaluate() các reduceRegion để leverage cache RF.
            if (computeOob) {
                oobPct = await log.run(
                    'GETINFO OOB accuracy (forces sampling + RF training on EE)',
                    async () => {
                        const diagnostics = ee.Dictionary(rfClassifier.explain())
                            .select(['outOfBagErrorEstimate']);
                        const info = await eeGetInfo(diagnostics, cfg.OOB_TIMEOUT_MS);
                        const oobError = Number(info?.outOfBagErrorEstimate);
                        if (!Number.isFinite(oobError)) {
                            throw new Error('GEE classifier diagnostics did not return outOfBagErrorEstimate');
                        }
                        return Math.max(0, Math.min(100, (1 - oobError) * 100));
                    },
                    { note: `async getInfo(callback), timeout=${cfg.OOB_TIMEOUT_MS}ms` },
                );
                log.mark('OOB accuracy', `${oobPct != null ? oobPct.toFixed(2) : 'null'}%`);
            }
            }   // end else (validation.ok)
        } else {
            datasetModelScore = await log.run(
                'RF disabled — DatasetModelScore = 0.85 × ThresholdScore [LAZY]',
                () => Promise.resolve(fixedThresholdScore.multiply(0.85).rename('DatasetModelScore')),
            );
        }

        const [firmsRecentHotspot, firmsInfluence] = await log.run(
            `Build FIRMS recent hotspot + focal buffer (${cfg.FIRMS_RECENT_DAYS}d, ${cfg.FIRMS_BUFFER_M}m) [LAZY]`,
            () => Promise.resolve((() => {
                const analysisEnd = ee.Date(analysisDate);
                const firmsStart  = analysisEnd.advance(-cfg.FIRMS_RECENT_DAYS, 'day');
                const hot = getFirmsHotspot(region, firmsStart, analysisEnd)
                    .and(forestMask).selfMask().rename('FIRMS_RecentHotspot');
                const infl = hot.unmask(0)
                    .focalMax(cfg.FIRMS_BUFFER_M, 'circle', 'meters')
                    .gt(0).and(forestMask).rename('FIRMS_Influence');
                return [hot, infl];
            })()),
        );

        const inputImages = await log.run(
            'Build input burn overlay (GT inline hoặc asset → score/coverage/confirmed) [LAZY]',
            () => Promise.resolve(buildInputImages(region, forestMask,
                inputFireGeoJson
                    ? { geojson: inputFireGeoJson }
                    : inputFireAssetId,
            )),
        );

        const risk = await log.run(
            'Build risk products (blend + riskLevel + confidence + priority) [LAZY]',
            () => Promise.resolve(buildRiskProducts({
                currentPredictors,
                forestMask,
                fixedThresholdScore,
                datasetModelScore,
                inputImages,
                firmsInfluence,
                rfEnabled: enableRf,
                region,
            })),
        );

        return {
            // Predictors / diagnostics
            currentPredictors,
            fuelClass:            fuelVal.fuelClass,
            fuelK:                fuelVal.fuelK,
            forestMask,
            // Component scores
            fixedThresholdScore,
            datasetModelScore,
            // Fire evidence layers
            firmsRecentHotspot,
            firmsInfluence,
            inputImages,
            // Final products
            ...risk,
            // Metadata for callers
            rfEnabled:        enableRf,
            rfClassifier,             // ee.Classifier (null nếu enableRf=false hoặc rfSkipReason)
            oobPct,                   // number 0-100 (null nếu !computeOob hoặc !enableRf)
            rfSkipReason,             // string|null — lý do RF không train (thiếu mẫu, v.v.)
            trainingCounts,           // { '0': N, '1': N } | null — histogram nhãn training
            inputFireAssetId: inputFireAssetId || null,
            fuelSource:       fuelVal.source,
            // Metadata mô tả model — dùng cho snapshot / API disclaimer.
            modelMeta: {
                pipelineVersion:      'v8.2-audit-2026-07-24',
                predictionHorizonDays: 30,
                featureWindowDays:    cfg.FEATURE_WINDOW_DAYS,
                trainMonths:          cfg.TRAIN_MONTHS.length,
                nesterovPBreaks:      cfg.NESTEROV_P_BREAKS,
                riskScoreBreaks:      cfg.RISK_SCORE_BREAKS,
                minSamplesPerClass:   cfg.MIN_SAMPLES_PER_CLASS,
                effectiveResolution: {
                    outputScaleM:          cfg.EXPORT_SCALE_M,
                    trainScaleM:           cfg.TRAIN_SCALE_M,
                    vegetationNativeM:     20,     // Sentinel-2 B8/B11 native
                    thermalNativeM:        1000,   // MODIS LST_Day_1km
                    weatherNativeKm:       9,      // ERA5-Land ~0.1°
                    fuelNativeM:           500,    // MODIS MCD12Q1 / local asset
                },
                semantics: {
                    riskLevel:        'Cấp nguy cơ mô hình 1-5. KHÔNG phải cấp cảnh báo cháy chính thức theo QĐ 25/2022/QĐ-UBND.',
                    modelConfidence:  'Heuristic độ tin cậy 0-1 dựa vào độ tươi dữ liệu S2/LST và input coverage. KHÔNG phải khoảng tin cậy thống kê.',
                    nesterovProxyLevel: 'Cấp proxy tính từ P Nesterov với ERA5-Land Daily. KHÔNG phải cấp P chính thức từ số liệu khí tượng thủy văn.',
                },
            },
        };
    })();
}

module.exports = {
    PREDICTOR_BANDS,
    RF_PREDICTOR_BANDS,
    getTerrain,
    getFuelInfo,
    getS2Indices,
    getWeatherFeatures,
    getSafeLstFeatures,
    buildNesterovP,
    nesterovPToScore,
    nesterovPToProxyLevel,
    getPredictorImage,
    getTrainingLabels,
    getFirmsHotspot,
    buildTrainingCollection,
    trainRf,
    classifyRfProbability,
    applyRfClassifier,
    computeFixedThresholdScore,
    buildInputImages,
    buildRiskProducts,
    runFireRiskAnalysis,
};
