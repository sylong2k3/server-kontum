'use strict';

/**
 * Forest Classification Service (Phân loại lớp phủ rừng).
 *
 * Implements the 11-class Kon Tum forest classification from lopPhuRungFinal.txt v3.
 * Uses Landsat 5/7/8/9 + Sentinel-2 + Random Forest (200 trees).
 *
 * Pipeline:
 *   1. Build 3 composites: base (full year), dry (Jan-Apr), wet (Aug-Nov)
 *   2. Compute spectral indices (NDVI, NDWI, MNDWI, NDMI, NDBI, NBR, BSI, EVI)
 *      for base + seasonal amplitudes
 *   3. Add DEM bands (elevation, slope, aspect)
 *   4. Build pseudo-label images (threshold + Dynamic World / ESA WorldCover + JRC Water)
 *   5. Sample training data from pseudo-labels
 *   6. Train Random Forest (200 trees, 6 variables/split, seed=year)
 *   7. Classify + water post-processing (JRC stable water correction)
 *   8. Compute province-level area stats per class
 *   9. Compute per-district area stats via reduceRegions
 *  10. Send area-change alert if delta > ALERT_FOREST_CHANGE_PCT vs previous month
 *  11. Optional: export GeoTIFF to GCS → MinIO → GeoServer
 */

const cfg  = require('../configs/forest-classification');
const { ee, initializeEarthEngine } = require('../configs/gge');
const {
    eeEval,
    getEeMapId,
    getKonTumRegion,
    getKonTumDistricts,
    makeComposite,
    addIndices,
    getDemBands,
    todayUtc,
    fmtDate,
} = require('../utils/gee-satellite.util');
const repo = require('../repositories/forest-classification.repository');
const { BusinessLogicError } = require('../core/error.response');
const { StatusCodes } = require('../core/http-status-code');

// ── Build feature image ───────────────────────────────────────────────────────

/**
 * Build the full multi-band feature image used for RF classification.
 * Bands: 6 base optical + 8 base indices + seasonal NDVI/MNDWI/BSI/EVI
 *        + NDVI/EVI amplitudes + elevation/slope/aspect = 25 bands.
 */
function buildFeatureImage(year, region) {
    const base = makeComposite(year, cfg.BASE_START_MONTH, cfg.BASE_END_MONTH, region);
    const dry  = makeComposite(year, cfg.DRY_START_MONTH,  cfg.DRY_END_MONTH,  region)
        .unmask(base);
    const wet  = makeComposite(year, cfg.WET_START_MONTH,  cfg.WET_END_MONTH,  region)
        .unmask(base);

    const baseIdx = addIndices(base, 'base');
    const dryIdx  = addIndices(dry,  'dry');
    const wetIdx  = addIndices(wet,  'wet');

    const ndviAmp = wetIdx.select('wet_NDVI').subtract(dryIdx.select('dry_NDVI')).rename('NDVI_amp');
    const eviAmp  = wetIdx.select('wet_EVI') .subtract(dryIdx.select('dry_EVI')) .rename('EVI_amp');

    const { elevation, slope, aspect } = getDemBands(region);

    return base.addBands([
        baseIdx,
        dryIdx.select(['dry_NDVI','dry_MNDWI','dry_BSI','dry_EVI']),
        wetIdx.select(['wet_NDVI','wet_MNDWI','wet_EVI']),
        ndviAmp, eviAmp,
        elevation, slope, aspect,
    ]).toFloat();
}

// ── Threshold pseudo-labels (mirrors lopPhuRungFinal.txt §14.7–14.8) ─────────

/**
 * Build a priority mosaic from [{mask, classValue}] entries.
 * Later entries have higher priority (overwrite earlier).
 */
function buildPriorityLabel(entries, region) {
    const layers = entries.map(({ classValue, mask }) =>
        ee.Image.constant(classValue).toInt16().updateMask(mask),
    );
    return ee.ImageCollection(layers).mosaic()
        .rename('class').toInt16().clip(region);
}

function buildThresholdLabel(base, dryIdx, wetIdx, dem, region) {
    const ndvi     = base.normalizedDifference(['nir', 'red']);
    const mndwi    = base.normalizedDifference(['green', 'swir1']);
    const ndmi     = base.normalizedDifference(['nir', 'swir1']);
    const ndbi     = base.normalizedDifference(['swir1', 'nir']);
    const nbr      = base.normalizedDifference(['nir', 'swir2']);
    const bsi      = base.expression(
        '((SWIR + RED) - (NIR + BLUE)) / ((SWIR + RED) + (NIR + BLUE))',
        { SWIR: base.select('swir1'), RED: base.select('red'),
          NIR: base.select('nir'), BLUE: base.select('blue') });
    const evi      = base.expression(
        '2.5 * ((NIR - RED) / (NIR + 6 * RED - 7.5 * BLUE + 1))',
        { NIR: base.select('nir'), RED: base.select('red'), BLUE: base.select('blue') });

    const dryNDVI  = dryIdx.select('dry_NDVI');
    const wetNDVI  = wetIdx.select('wet_NDVI');
    const dryBSI   = dryIdx.select('dry_BSI');
    const wetEVI   = wetIdx.select('wet_EVI');
    const dryEVI   = dryIdx.select('dry_EVI');
    const dryMNDWI = dryIdx.select('dry_MNDWI');
    const ndviAmp  = wetNDVI.subtract(dryNDVI).rename('NDVI_amp');
    const elevation = dem.select('elevation');
    const slope    = dem.select('slope');

    // Threshold masks (mirrors §14.7 in lopPhuRungFinal.txt).
    const tOtherLand    = bsi.gt(0.18).and(ndvi.lt(0.28)).and(mndwi.lt(0.05)).and(ndbi.gt(-0.05));
    const tIndCrop      = wetNDVI.gte(0.60).and(wetNDVI.lte(0.88)).and(dryNDVI.gte(0.45))
        .and(ndviAmp.lte(0.24)).and(elevation.gte(300)).and(elevation.lte(1300))
        .and(slope.lte(18)).and(mndwi.lt(0.05)).and(bsi.lt(-0.02));
    const tAgri         = wetNDVI.gte(0.40).and(wetNDVI.lte(0.85)).and(dryNDVI.lte(0.58))
        .and(ndviAmp.gte(0.18)).and(elevation.lt(1000)).and(slope.lt(15)).and(mndwi.lt(0.10));
    const tMixed        = wetNDVI.gte(0.62).and(wetNDVI.lte(0.85)).and(dryNDVI.gte(0.55))
        .and(ndviAmp.lte(0.17)).and(elevation.gte(650)).and(slope.gte(8))
        .and(nbr.gte(0.30)).and(ndmi.gte(0.08));
    const tEvergreen    = wetNDVI.gte(0.72).and(dryNDVI.gte(0.65)).and(ndviAmp.lte(0.12))
        .and(evi.gte(0.38)).and(ndmi.gte(0.10)).and(nbr.gte(0.35))
        .and(bsi.lt(-0.10)).and(elevation.gte(450));
    const tNeedle       = wetNDVI.gte(0.48).and(wetNDVI.lte(0.78)).and(dryNDVI.gte(0.45))
        .and(dryNDVI.lte(0.74)).and(evi.gte(0.20)).and(evi.lte(0.45))
        .and(elevation.gte(900)).and(slope.gte(8))
        .and(base.select('swir1').gte(0.07)).and(nbr.gte(0.22));
    const tDeciduous    = wetNDVI.gte(0.55).and(dryNDVI.lte(0.50)).and(ndviAmp.gte(0.22))
        .and(elevation.gte(300)).and(elevation.lte(900)).and(slope.gte(6))
        .and(dryBSI.gte(-0.02)).and(wetEVI.gte(0.25)).and(mndwi.lt(0.05));
    const tBamboo       = wetNDVI.gte(0.55).and(wetNDVI.lte(0.78)).and(dryNDVI.gte(0.45))
        .and(dryNDVI.lte(0.72)).and(ndviAmp.gte(0.04)).and(ndviAmp.lte(0.22))
        .and(elevation.gte(300)).and(elevation.lte(1100)).and(slope.gte(5)).and(slope.lte(30))
        .and(evi.gte(0.22)).and(evi.lte(0.45)).and(ndmi.gte(0.05)).and(bsi.lt(-0.05));
    const tPlantation   = wetNDVI.gte(0.60).and(wetNDVI.lte(0.85)).and(dryNDVI.gte(0.45))
        .and(ndviAmp.lte(0.23)).and(elevation.lt(1000)).and(slope.lt(22))
        .and(nbr.gte(0.24)).and(ndmi.gte(0.06)).and(bsi.lt(-0.05));
    const tWater        = mndwi.gte(0.10).and(ndvi.lte(0.22))
        .or(mndwi.gte(0.02).and(ndvi.lte(0.30)).and(dryMNDWI.gte(-0.05)));
    const tGrassShrub   = wetNDVI.gte(0.35).and(wetNDVI.lte(0.65)).and(dryNDVI.gte(0.18))
        .and(dryNDVI.lte(0.50)).and(ndviAmp.gte(0.06)).and(bsi.lt(0.15))
        .and(mndwi.lt(0.05)).and(slope.lt(30));

    const nonNatural = tOtherLand.or(tIndCrop).or(tAgri).or(tGrassShrub).or(tWater);

    return buildPriorityLabel([
        { classValue: 0, mask: tOtherLand },
        { classValue: 3, mask: tMixed.and(nonNatural.not()) },
        { classValue: 4, mask: tEvergreen.and(nonNatural.not()) },
        { classValue: 8, mask: tPlantation },
        { classValue: 7, mask: tBamboo.and(nonNatural.not()) },
        { classValue: 6, mask: tDeciduous.and(nonNatural.not()) },
        { classValue: 5, mask: tNeedle.and(nonNatural.not()) },
        { classValue: 10, mask: tGrassShrub },
        { classValue: 2,  mask: tAgri },
        { classValue: 1,  mask: tIndCrop },
        { classValue: 9,  mask: tWater },
    ], region);
}

// ── RF classification ─────────────────────────────────────────────────────────

/**
 * Sample training data from a label image and return an ee.FeatureCollection.
 */
function sampleFromLabel(featureImage, labelImage, nSamples, region, seed) {
    const bands = featureImage.addBands(labelImage.rename('class').toInt16());
    return bands.stratifiedSample({
        numPoints:   nSamples,
        classBand:   'class',
        classValues: ee.List.sequence(0, cfg.CLASS_NAMES.length - 1),
        classPoints: ee.List.repeat(nSamples, cfg.CLASS_NAMES.length),
        region:      region.geometry(),
        scale:       cfg.SAMPLE_SCALE_M,
        seed,
        geometries:  true,
        tileScale:   16,
        dropNulls:   true,
    });
}

/**
 * Build dataset pseudo-label from Dynamic World + ESA WorldCover + JRC Water.
 */
function buildDatasetLabel(featureImage, thresholdLabel, year, region) {
    const canUseDW = year >= 2016;
    const startDate = ee.Date.fromYMD(year, cfg.BASE_START_MONTH, 1);
    const endDate   = ee.Date.fromYMD(year, cfg.BASE_END_MONTH,   1).advance(1, 'month');

    const dwBands = ['water','trees','grass','flooded_vegetation','crops','shrub_and_scrub','built','bare'];
    let dwProb = ee.Image.constant([0,0,0,0,0,0,0,0]).rename(dwBands).clip(region);

    if (canUseDW) {
        dwProb = ee.ImageCollection('GOOGLE/DYNAMICWORLD/V1')
            .filterBounds(region)
            .filterDate(startDate, endDate)
            .select(dwBands).mean().unmask(0).clip(region);
    }

    const useWC = year >= 2019 && year <= 2023;
    let worldCover = ee.Image.constant(-999).rename('Map').clip(region);
    if (useWC) {
        worldCover = ee.Image(ee.ImageCollection('ESA/WorldCover/v200').first())
            .select('Map').clip(region);
    }

    const jrc      = ee.Image('JRC/GSW1_4/GlobalSurfaceWater').clip(region);
    const jrcOcc   = jrc.select('occurrence').unmask(0);
    const jrcRec   = jrc.select('recurrence').unmask(0);
    const jrcSeas  = jrc.select('seasonality').unmask(0);
    const jrcMax   = jrc.select('max_extent').unmask(0);

    const jrcStable   = jrcOcc.gte(70).and(jrcRec.gte(70));
    const jrcSeasonal = jrcOcc.gte(25).and(jrcSeas.gte(3)).and(jrcMax.eq(1));

    const publicWater  = dwProb.select('water').gte(0.55)
        .or(worldCover.eq(80)).or(jrcStable).or(jrcSeasonal);
    const publicTree   = dwProb.select('trees').gte(0.65).or(worldCover.eq(10));
    const publicCrop   = dwProb.select('crops').gte(0.60).or(worldCover.eq(40));
    const publicOther  = dwProb.select('built').gte(0.60).or(worldCover.eq(50)).or(worldCover.eq(60));
    const publicGrass  = dwProb.select('grass').gte(0.55).or(worldCover.eq(20)).or(worldCover.eq(30));

    const publicNonNat = publicOther.or(publicCrop).or(publicGrass).or(publicWater);
    const naturalForest = publicTree.and(publicNonNat.not());

    // Reuse threshold masks for fine detail.
    const tLabel = thresholdLabel;
    const tOther   = tLabel.eq(0); const tIndCrop = tLabel.eq(1); const tAgri    = tLabel.eq(2);
    const tMixed   = tLabel.eq(3); const tEverGr  = tLabel.eq(4); const tNeedle  = tLabel.eq(5);
    const tDecid   = tLabel.eq(6); const tBamboo  = tLabel.eq(7); const tPlant   = tLabel.eq(8);
    const tWater   = tLabel.eq(9); const tGrass   = tLabel.eq(10);

    return buildPriorityLabel([
        { classValue: 0, mask: publicOther.and(tOther) },
        { classValue: 3, mask: naturalForest.and(tMixed) },
        { classValue: 4, mask: naturalForest.and(tEverGr) },
        { classValue: 8, mask: publicTree.and(tPlant).and(publicWater.not()).and(publicOther.not()) },
        { classValue: 7, mask: naturalForest.and(tBamboo) },
        { classValue: 6, mask: naturalForest.and(tDecid) },
        { classValue: 5, mask: naturalForest.and(tNeedle) },
        { classValue: 10, mask: publicGrass.and(tGrass) },
        { classValue: 2,  mask: publicCrop.and(tAgri) },
        { classValue: 1,  mask: publicCrop.and(tIndCrop) },
        { classValue: 9,  mask: publicWater.and(tWater) },
    ], region);
}

// ── Area stats ────────────────────────────────────────────────────────────────

async function computeProvinceAreaStats(classified, region) {
    const areaImg = ee.Image.pixelArea().divide(10000).addBands(classified.rename('class'));
    const result  = await eeEval(
        areaImg.reduceRegion({
            reducer:    ee.Reducer.sum().group({ groupField: 1, groupName: 'class' }),
            geometry:   region.geometry(),
            scale:      cfg.AREA_STATS_SCALE_M,
            bestEffort: true,
            maxPixels:  1e13,
            tileScale:  8,
        }),
    );
    const groups  = result.groups || [];
    const byClass = {};
    let   totalHa = 0;
    for (const g of groups) {
        const ha = Math.round((g.sum || 0) * 100) / 100;
        byClass[g.class] = ha;
        totalHa += ha;
    }
    return { byClass, totalHa: Math.round(totalHa * 100) / 100 };
}

async function computeDistrictAreaStats(classified, districts) {
    const areaImg = ee.Image.pixelArea().divide(10000).addBands(classified.rename('class'));
    const reduced = areaImg.reduceRegions({
        collection: districts,
        reducer:    ee.Reducer.sum().group({ groupField: 1, groupName: 'class' }),
        scale:      cfg.AREA_STATS_SCALE_M,
        tileScale:  8,
    });

    const fcResult = await eeEval(reduced);
    const distStats = [];

    for (const feat of (fcResult.features || [])) {
        const p      = feat.properties || {};
        const groups = p.groups || [];
        for (const g of groups) {
            const classId = g.class;
            const ha      = Math.round((g.sum || 0) * 100) / 100;
            if (ha <= 0) continue;
            distStats.push({
                district_code: p.ADM2_CODE  || null,
                district_name: p.ADM2_NAME  || p.ADM1_NAME || null,
                class_id:      classId,
                class_name:    cfg.CLASS_NAMES[classId] || `Class ${classId}`,
                area_ha:       ha,
            });
        }
    }
    return distStats;
}

// ── Alert notification ────────────────────────────────────────────────────────

async function sendAreaChangeAlert(snapshot, prevSnapshot, provinceSummary) {
    try {
        const notifSvc = require('./notification.service');
        const prevSummary = prevSnapshot?.province_summary;
        if (!prevSummary) return;

        let prevForestHa = 0;
        let currForestHa = 0;
        for (const classId of cfg.FOREST_CLASS_IDS) {
            prevForestHa += prevSummary.byClass?.[classId] || 0;
            currForestHa += provinceSummary.byClass?.[classId] || 0;
        }
        if (prevForestHa === 0) return;

        const changePct = Math.abs((currForestHa - prevForestHa) / prevForestHa * 100);
        if (changePct < cfg.ALERT_FOREST_CHANGE_PCT) return;

        const direction = currForestHa < prevForestHa ? 'giảm' : 'tăng';
        await notifSvc.createSystemNotification({
            title:   `Cảnh báo thay đổi diện tích rừng ${snapshot.year}/${snapshot.month}`,
            message: `Diện tích rừng Kon Tum ${direction} ${changePct.toFixed(1)}% so với tháng trước ` +
                     `(từ ${prevForestHa.toLocaleString('vi')} ha → ${currForestHa.toLocaleString('vi')} ha).`,
            type:    'warning',
        });
    } catch (err) {
        console.warn('[FOREST] Alert notification failed:', err.message);
    }
}

// ── Main analysis ─────────────────────────────────────────────────────────────

async function runAnalysis(year, month, {
    submitExport = cfg.isGcsConfigured(),
    trigger      = 'cron',
    requestedBy  = null,
} = {}) {
    await initializeEarthEngine();
    const startMs = Date.now();

    let snapshot = await repo.upsertSnapshot({
        year, month,
        status: 'computing',
        trigger,
        requested_by: requestedBy,
        model_params: {
            version:        'v3',
            rf_trees:       cfg.RF_TREES,
            rf_vars_split:  cfg.RF_VARIABLES_PER_SPLIT,
            bag_fraction:   cfg.RF_BAG_FRACTION,
            samples:        cfg.SAMPLES_PER_CLASS,
            sample_scale_m: cfg.SAMPLE_SCALE_M,
            area_scale_m:   cfg.AREA_STATS_SCALE_M,
        },
    });

    try {
        const region    = getKonTumRegion();
        const districts = getKonTumDistricts();

        // Step 1-3: build feature image.
        const featureImage = buildFeatureImage(year, region);
        const base  = makeComposite(year, cfg.BASE_START_MONTH, cfg.BASE_END_MONTH, region);
        const dry   = makeComposite(year, cfg.DRY_START_MONTH,  cfg.DRY_END_MONTH,  region).unmask(base);
        const wet   = makeComposite(year, cfg.WET_START_MONTH,  cfg.WET_END_MONTH,  region).unmask(base);
        const dryIdx = addIndices(dry, 'dry');
        const wetIdx = addIndices(wet, 'wet');
        const { elevation, slope, aspect } = getDemBands(region);
        const demImage = elevation.addBands([slope, aspect]);

        // Step 4: build pseudo-labels.
        const thresholdLabel = buildThresholdLabel(base, dryIdx, wetIdx, demImage, region);
        const datasetLabel   = buildDatasetLabel(featureImage, thresholdLabel, year, region);

        // Step 5: sample training data (80% threshold, 20% pseudo-dataset).
        const tSeed     = year * 1000 + month;
        const dSeed     = year * 2000 + month;
        const thresholdSamples = sampleFromLabel(featureImage, thresholdLabel,
            Math.ceil(cfg.SAMPLES_PER_CLASS * 0.4), region, tSeed);
        const datasetSamples   = sampleFromLabel(featureImage, datasetLabel,
            Math.ceil(cfg.SAMPLES_PER_CLASS * 0.6), region, dSeed);
        const trainSet = thresholdSamples.merge(datasetSamples);

        // Step 6: train Random Forest.
        const classifier = ee.Classifier.smileRandomForest({
            numberOfTrees:     cfg.RF_TREES,
            variablesPerSplit: cfg.RF_VARIABLES_PER_SPLIT,
            minLeafPopulation: cfg.RF_MIN_LEAF_POPULATION,
            bagFraction:       cfg.RF_BAG_FRACTION,
            seed:              year,
        }).train({
            features:        trainSet,
            classProperty:   'class',
            inputProperties: featureImage.bandNames(),
        });

        // OOB accuracy.
        const rfInfo      = ee.Dictionary(classifier.explain());
        const oobAccuracy = ee.Number(1)
            .subtract(ee.Number(rfInfo.get('outOfBagErrorEstimate')))
            .multiply(100);
        const oobPct = await eeEval(oobAccuracy);

        // Step 7: classify + JRC water correction.
        const jrc        = ee.Image('JRC/GSW1_4/GlobalSurfaceWater').clip(region);
        const jrcStable  = jrc.select('occurrence').unmask(0).gte(70)
            .and(jrc.select('recurrence').unmask(0).gte(70));
        const mndwiBase  = base.normalizedDifference(['green', 'swir1']);

        const classifiedRaw = featureImage.classify(classifier).rename('classification')
            .toByte().clip(region);
        const classified    = classifiedRaw
            .where(jrcStable.and(mndwiBase.gte(-0.05)), 9)
            .rename('classification').toByte().clip(region);

        // Step 8-9: area stats.
        const [provinceSummary, districtAreas] = await Promise.all([
            computeProvinceAreaStats(classified, region),
            computeDistrictAreaStats(classified, districts),
        ]);

        // Update snapshot.
        snapshot = await repo.updateStatus(snapshot.id, 'completed', {
            province_summary: provinceSummary,
            oob_accuracy:     Math.round(oobPct * 100) / 100,
            computed_at:      new Date(),
            duration_ms:      Date.now() - startMs,
        });

        // Save district areas.
        await repo.replaceDistrictAreas(snapshot.id, districtAreas);

        // Step 10: area change alert.
        const prevSnapshot = await repo.getPreviousCompleted(year, month);
        await sendAreaChangeAlert(snapshot, prevSnapshot, provinceSummary);

        // Step 11: optional raster export.
        if (submitExport) {
            const taskName = await submitExportTask(classified, year, month, region);
            snapshot = await repo.updateStatus(snapshot.id, 'exporting', { gee_task_id: taskName });
        }

        return snapshot;
    } catch (err) {
        await repo.updateStatus(snapshot.id, 'failed', { error_message: err.message });
        throw err;
    }
}

// ── Raster export ─────────────────────────────────────────────────────────────

async function submitExportTask(classified, year, month, region) {
    if (!cfg.isGcsConfigured()) throw new Error('GEE_GCS_BUCKET not configured');
    const tag      = `${year}${String(month).padStart(2, '0')}`;
    const filePrefix = `forest_classification/kontum_forest_${tag}`;

    const task = ee.batch.Export.image.toCloudStorage({
        image:          classified.toInt8(),
        description:    `forest_class_${tag}`,
        bucket:         cfg.GCS_BUCKET,
        fileNamePrefix: filePrefix,
        scale:          cfg.EXPORT_SCALE_M,
        maxPixels:      1e13,
        region:         region.geometry(),
        fileFormat:     'GeoTIFF',
        formatOptions:  { cloudOptimized: true },
    });
    task.start();
    const status = await eeEval(task.status());
    return status.name || status.id || String(task);
}

async function pollExports() {
    const exporting = await repo.listExporting();
    for (const snap of exporting) {
        try {
            const tag     = `${snap.year}${String(snap.month).padStart(2, '0')}`;
            const gcsPath = `forest_classification/kontum_forest_${tag}`;

            const { pollGeeTask, publishRasterToMinio } = require('../utils/gee-export.helper');
            const state = await pollGeeTask(snap.gee_task_id);

            if (state === 'COMPLETED') {
                const published = await publishRasterToMinio({
                    gcsPath, bucket: cfg.MINIO_BUCKET,
                    fileName:  `kontum_forest_${tag}.tif`,
                    minioKey:  `forest_classification/kontum_forest_${tag}.tif`,
                    storeName: `forest_class_${tag}`,
                });
                if (published) {
                    await repo.updateStatus(snap.id, 'published', {
                        ...published, published_at: new Date(),
                    });
                }
            } else if (['FAILED','CANCELLED','TIMEOUT'].includes(state)) {
                await repo.updateStatus(snap.id, 'failed', {
                    error_message: `GEE export task ${state}: ${snap.gee_task_id}`,
                });
            }
        } catch (err) {
            console.error(`[FOREST] pollExports error for snapshot ${snap.id}:`, err.message);
        }
    }
}

// ── Public API ────────────────────────────────────────────────────────────────

const getLatest = async () => {
    const snapshot = await repo.getLatestCompleted();
    if (!snapshot) {
        const pending = await repo.getLatest();
        if (pending) return { snapshot: pending, districtAreas: [], stale: true, computing: true };
        throw new BusinessLogicError(
            'Chưa có dữ liệu phân loại rừng. Vui lòng thử lại sau.',
            ['FC_NO_DATA'],
            StatusCodes.SERVICE_UNAVAILABLE,
        );
    }
    const districtAreas = await repo.getDistrictAreas(snapshot.id);
    return { snapshot, districtAreas, stale: false, computing: false };
};

const getHistory = async ({ page = 1, limit = 24 } = {}) =>
    repo.listCompleted({ page, limit });

const refresh = async ({ year, month } = {}) => {
    const now = new Date();
    const y   = year  || now.getUTCFullYear();
    const m   = month || (now.getUTCMonth() + 1);
    return runAnalysis(y, m, { trigger: 'manual' });
};

// ── On-demand user query (cache-first) ────────────────────────────────────────

/**
 * User-facing on-demand query for a specific year/month.
 *
 * - Returns cached completed result immediately (no recompute).
 * - If the period is already computing, returns status so the caller can poll.
 * - If not found or previously failed, triggers a new async analysis and returns
 *   the pending snapshot so the caller can poll GET /snapshot/:id.
 *
 * @param {number} year
 * @param {number} month   1-12
 * @param {number|null} userId  Authenticated user id (for logging)
 * @returns {{ snapshot, districtAreas, cached, computing }}
 */
const queryForPeriod = async (year, month, userId = null) => {
    const existing = await repo.getByYearMonth(year, month);

    if (existing) {
        if (['completed', 'published'].includes(existing.status)) {
            const districtAreas = await repo.getDistrictAreas(existing.id);
            return { snapshot: existing, districtAreas, cached: true, computing: false };
        }
        if (['computing', 'exporting'].includes(existing.status)) {
            return { snapshot: existing, districtAreas: [], cached: false, computing: true };
        }
        // failed / pending → fall through to re-trigger
    }

    // Trigger analysis in the background — respond immediately with computing=true.
    runAnalysis(year, month, { trigger: 'user', requestedBy: userId })
        .catch((err) => console.error(`[FOREST] user query y=${year} m=${month}:`, err.message));

    // Return the freshly upserted computing snapshot (or placeholder if upsert is
    // racing — runAnalysis will set status='computing' in its own upsertSnapshot call).
    const pending = await repo.getByYearMonth(year, month)
        || { id: null, year, month, status: 'computing' };

    return { snapshot: pending, districtAreas: [], cached: false, computing: true };
};

// ── Admin logs ────────────────────────────────────────────────────────────────

/**
 * Full audit log of all forest classification runs.
 * Includes every trigger (cron/manual/user), timing, OOB accuracy, errors.
 */
const getLogs = async ({ page = 1, limit = 24, status = null } = {}) =>
    repo.listAll({ page, limit, status });

// ── Snapshot by ID ────────────────────────────────────────────────────────────

/**
 * Get a specific snapshot with district areas.
 * Used by clients to poll a user-triggered analysis.
 */
const getSnapshotById = async (id) => {
    const snapshot = await repo.getById(id);
    if (!snapshot) return null;
    const districtAreas = ['completed', 'published'].includes(snapshot.status)
        ? await repo.getDistrictAreas(snapshot.id)
        : [];
    return { snapshot, districtAreas };
};

module.exports = {
    runAnalysis,
    pollExports,
    getLatest,
    getHistory,
    refresh,
    queryForPeriod,
    getLogs,
    getSnapshotById,
};
