'use strict';

/**
 * Shared 11-class Kon Tum forest classification pipeline (v3).
 *
 * Mirrors lopPhuRungFinal.txt: Landsat 5/7/8/9 + Sentinel-2 seasonal
 * composites, spectral indices, DEM, threshold + Dynamic World +
 * ESA WorldCover + JRC GSW pseudo-labels, and Random Forest classifier.
 *
 * Consumed by both `forest-classification.service` (scheduled monthly
 * snapshot) and `satellite.service` (on-demand /satellite/classified).
 *
 * Region param convention:
 *   - Accepts either ee.FeatureCollection (default Kon Tum) or ee.Geometry
 *     (user-supplied ROI). All internal helpers work with either.
 *   - `sampleFromLabel` requires the geometry explicitly — pass
 *     `region.geometry()` for FC, or the Geometry itself for raw ROIs.
 */

const cfg = require('../configs/forest-classification');
const { ee } = require('../configs/gge');
const {
    eeEval,
    makeComposite,
    addIndices,
    getDemBands,
} = require('../utils/gee-satellite.util');
const { makeStageLogger } = require('../utils/stage-logger.util');

// ── Priority mosaic ───────────────────────────────────────────────────────────

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

// ── Feature image ─────────────────────────────────────────────────────────────

/**
 * Full multi-band feature image used for RF classification.
 * Bands: 6 base optical + 8 base indices + 4 dry + 3 wet + 2 amplitudes
 *        + elevation/slope/aspect = 26 bands.
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

    return {
        featureImage: base.addBands([
            baseIdx,
            dryIdx.select(['dry_NDVI', 'dry_MNDWI', 'dry_BSI', 'dry_EVI']),
            wetIdx.select(['wet_NDVI', 'wet_MNDWI', 'wet_EVI']),
            ndviAmp, eviAmp,
            elevation, slope, aspect,
        ]).toFloat(),
        base,
        dryIdx,
        wetIdx,
        demImage: elevation.addBands([slope, aspect]),
    };
}

// ── Threshold pseudo-labels (§14.7–14.8 in lopPhuRungFinal.txt) ──────────────

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

// ── Dataset pseudo-label (Dynamic World + ESA WorldCover + JRC GSW) ──────────

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

    const jrc     = ee.Image('JRC/GSW1_4/GlobalSurfaceWater').clip(region);
    const jrcOcc  = jrc.select('occurrence').unmask(0);
    const jrcRec  = jrc.select('recurrence').unmask(0);
    const jrcSeas = jrc.select('seasonality').unmask(0);
    const jrcMax  = jrc.select('max_extent').unmask(0);

    const jrcStable   = jrcOcc.gte(70).and(jrcRec.gte(70));
    const jrcSeasonal = jrcOcc.gte(25).and(jrcSeas.gte(3)).and(jrcMax.eq(1));

    const publicWater  = dwProb.select('water').gte(0.55)
        .or(worldCover.eq(80)).or(jrcStable).or(jrcSeasonal);
    const publicTree   = dwProb.select('trees').gte(0.65).or(worldCover.eq(10));
    const publicCrop   = dwProb.select('crops').gte(0.60).or(worldCover.eq(40));
    const publicOther  = dwProb.select('built').gte(0.60).or(worldCover.eq(50)).or(worldCover.eq(60));
    const publicGrass  = dwProb.select('grass').gte(0.55).or(worldCover.eq(20)).or(worldCover.eq(30));

    const publicNonNat  = publicOther.or(publicCrop).or(publicGrass).or(publicWater);
    const naturalForest = publicTree.and(publicNonNat.not());

    const tLabel = thresholdLabel;
    const tOther   = tLabel.eq(0);  const tIndCrop = tLabel.eq(1);  const tAgri   = tLabel.eq(2);
    const tMixed   = tLabel.eq(3);  const tEverGr  = tLabel.eq(4);  const tNeedle = tLabel.eq(5);
    const tDecid   = tLabel.eq(6);  const tBamboo  = tLabel.eq(7);  const tPlant  = tLabel.eq(8);
    const tWater   = tLabel.eq(9);  const tGrass   = tLabel.eq(10);

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

// ── Training-sample stratified sampler ───────────────────────────────────────

/**
 * @param regionGeom     ee.Geometry — pass region.geometry() if you have a FC.
 * @param exclusionMask  optional ee.Image (1 = keep, 0 = drop). Used to skip
 *                       pixels near ground-truth features so Dataset/Threshold
 *                       samples don't overlap with the independent input pool.
 */
function sampleFromLabel(featureImage, labelImage, nSamples, regionGeom, seed, exclusionMask, scaleM) {
    let bands = featureImage.addBands(labelImage.rename('class').toInt16());
    if (exclusionMask) {
        bands = bands.updateMask(exclusionMask);
    }
    return bands.stratifiedSample({
        numPoints:   nSamples,
        classBand:   'class',
        classValues: ee.List.sequence(0, cfg.CLASS_NAMES.length - 1),
        classPoints: ee.List.repeat(nSamples, cfg.CLASS_NAMES.length),
        region:      regionGeom,
        scale:       scaleM || cfg.SAMPLE_SCALE_M,
        seed,
        geometries:  true,
        tileScale:   16,
        dropNulls:   true,
    });
}

// ── Ground-truth / input sample support (v3) ─────────────────────────────────

/**
 * Stratified-sample pixels underneath the user-provided ground-truth
 * FeatureCollection. Each feature must carry a `class` property (0-10).
 *
 * Points/polygons are painted onto a class image; the same feature image is
 * then sampled at that class band. Uses no explicit classValues/classPoints
 * so classes that are absent from the FC don't force zero-sized strata.
 */
function sampleGroundTruth(featureImage, groundTruthFC, nSamplesPerClass, regionGeom, seed) {
    const classImage = ee.Image().byte()
        .paint(groundTruthFC, 'class')
        .rename('class')
        .toInt16();
    const bands = featureImage.addBands(classImage);
    return bands.stratifiedSample({
        numPoints:  nSamplesPerClass,
        classBand:  'class',
        region:     regionGeom,
        scale:      cfg.SAMPLE_SCALE_M,
        seed,
        geometries: true,
        tileScale:  16,
        dropNulls:  true,
    });
}

/**
 * Build a binary mask that is 0 within `bufferM` metres of any ground-truth
 * feature and 1 elsewhere. Consumed by `sampleFromLabel` to prevent pseudo-
 * label samples from bleeding into the independent input pool.
 */
function buildExclusionMask(groundTruthFC, bufferM, region) {
    if (!bufferM || bufferM <= 0) return null;
    const buffered = groundTruthFC.map((f) => f.buffer(bufferM));
    const painted  = ee.Image().byte().paint(buffered, 1).unmask(0);
    return painted.not().clip(region);
}

// ── End-to-end runner ────────────────────────────────────────────────────────

/**
 * Full RF classification pipeline for one year over a region.
 * Returns the classified image + OOB accuracy + intermediates for reuse.
 *
 * Sample quotas (§14.1 in lopPhuRungFinal v3):
 *   With ground truth:    Input 50% • Dataset 30% • Threshold 20%
 *   Without ground truth: Input  0% • Dataset 60% • Threshold 40%
 *
 * @param {number} year
 * @param region        ee.FeatureCollection or ee.Geometry
 * @param regionGeom    ee.Geometry — pass region.geometry() if FC.
 * @param {object} opts
 * @param {number} [opts.seed]                   RF seed (defaults to year).
 * @param {string} [opts.groundTruthAssetId]     GEE FeatureCollection asset
 *                                               with a `class` property (0-10).
 * @param {number} [opts.gtBufferM=60]           Exclusion radius (metres)
 *                                               around ground-truth features
 *                                               for Dataset/Threshold sampling.
 * @param {number} [opts.minFieldTest=10]        Min input test samples/class.
 */
async function runRfClassification(year, region, regionGeom, opts = {}) {
    const {
        seed, groundTruthAssetId = '', gtBufferM = 60, minFieldTest = 10,
        // Skip blocking eeEval calls (OOB accuracy, test metrics).
        // Use for on-demand tile generation where metadata is not critical.
        skipStats = false,
        logger,
        // Lite mode is for /satellite/classified on-demand: same 11-class
        // essence but a much lighter graph so getMapId returns in seconds
        // instead of hitting GEE "Please try again" at ~200 s.
        //   • skip Dynamic World + ESA WorldCover + JRC GSW dataset labels
        //   • fewer samples per class, coarser sample scale
        //   • fewer RF trees
        // Threshold pseudo-labels still exercise all 11 classes.
        liteMode = false,
    } = opts;
    const rfSeed  = seed ?? year;
    const hasGT   = Boolean(groundTruthAssetId);
    const total   = liteMode ? cfg.LITE_SAMPLES_PER_CLASS : cfg.SAMPLES_PER_CLASS;
    const useDatasetLabels = !liteMode || cfg.LITE_USE_DATASET_LABELS;

    // Local logger nếu caller không truyền — mọi bước sau đây đều được đánh dấu.
    const log = logger || makeStageLogger(
        liteMode ? 'FOREST-CLS-RF-LITE' : 'FOREST-CLS-RF',
        { correlationId: year },
    );

    // ── Quotas per source ────────────────────────────────────────────────
    // Lite mode: khi bỏ dataset labels, quota Dataset gộp vào Threshold.
    const inputQuota     = hasGT ? Math.round(total * 0.5) : 0;
    const datasetQuota   = useDatasetLabels
        ? (hasGT ? Math.round(total * 0.3) : Math.round(total * 0.6))
        : 0;
    const thresholdQuota = total - inputQuota - datasetQuota;
    const inputTestQuota = Math.max(minFieldTest, Math.round(total * 0.2));

    log.mark(liteMode ? 'RF quotas (LITE)' : 'RF quotas',
        `hasGT=${hasGT} input=${inputQuota} dataset=${datasetQuota} threshold=${thresholdQuota} inputTest=${inputTestQuota} scale=${liteMode ? cfg.LITE_SAMPLE_SCALE_M : cfg.SAMPLE_SCALE_M}m trees=${liteMode ? cfg.LITE_RF_TREES : cfg.RF_TREES}`);

    // Toàn bộ các bước "build" chỉ dựng graph GEE (lazy) — nhanh, không time-out.
    // Chỉ khi gọi eeEval() mới đẩy đồ thị lên Earth Engine để tính thật.
    const { featureImage, base, dryIdx, wetIdx, demImage } = await log.run(
        'Build feature image (base+dry+wet composites + indices + DEM) [LAZY]',
        () => Promise.resolve(buildFeatureImage(year, region)),
        { note: 'Landsat 5/7/8/9 + S2, 3 composites, 8 indices ×3, elev/slope/aspect' },
    );

    const thresholdLabel = await log.run(
        'Build threshold pseudo-label (11 masks + priority mosaic) [LAZY]',
        () => Promise.resolve(buildThresholdLabel(base, dryIdx, wetIdx, demImage, region)),
    );
    // Trong lite mode, DynamicWorld + ESA WorldCover + JRC GSW là 3 external
    // dataset lớn — bỏ đi giúp getMapId trả trong ~15-30s thay vì timeout.
    let datasetLabel = null;
    if (useDatasetLabels) {
        datasetLabel = await log.run(
            'Build dataset pseudo-label (DynamicWorld + ESA WorldCover + JRC GSW) [LAZY]',
            () => Promise.resolve(buildDatasetLabel(featureImage, thresholdLabel, year, region)),
        );
    } else {
        log.mark('Dataset pseudo-label', 'SKIPPED (liteMode) — threshold labels only');
    }

    // ── Ground-truth split + exclusion mask ──────────────────────────────
    let inputTrainSamples = ee.FeatureCollection([]);
    let inputTestSamples  = ee.FeatureCollection([]);
    let exclusionMask     = null;

    if (hasGT) {
        await log.run(
            `Build ground-truth pool (asset=${groundTruthAssetId}) [LAZY]`,
            async () => {
                const gtFC = ee.FeatureCollection(groundTruthAssetId)
                    .filter(ee.Filter.notNull(['class']));
                const gtWithSplit = gtFC.randomColumn('split_random', rfSeed + 101);
                const gtTrainFC   = gtWithSplit.filter(ee.Filter.lt('split_random', 0.7));
                const gtTestFC    = gtWithSplit.filter(ee.Filter.gte('split_random', 0.7));

                exclusionMask     = buildExclusionMask(gtFC, gtBufferM, region);
                inputTrainSamples = sampleGroundTruth(featureImage, gtTrainFC, inputQuota,
                    regionGeom, rfSeed + 501);
                inputTestSamples  = sampleGroundTruth(featureImage, gtTestFC, inputTestQuota,
                    regionGeom, rfSeed + 502);
            },
        );
    }

    // ── Dataset + Threshold pseudo-label samples (with exclusion) ────────
    const sampleScaleM = liteMode ? cfg.LITE_SAMPLE_SCALE_M : cfg.SAMPLE_SCALE_M;
    const thresholdSamples = await log.run(
        'Sample threshold pool via stratifiedSample [LAZY]',
        () => Promise.resolve(sampleFromLabel(featureImage, thresholdLabel,
            thresholdQuota, regionGeom, rfSeed * 1000 + 1, exclusionMask, sampleScaleM)),
        { note: `numPoints=${thresholdQuota} scale=${sampleScaleM}m tileScale=16` },
    );
    const datasetSamples = useDatasetLabels
        ? await log.run(
            'Sample dataset pool via stratifiedSample [LAZY]',
            () => Promise.resolve(sampleFromLabel(featureImage, datasetLabel,
                datasetQuota, regionGeom, rfSeed * 2000 + 1, exclusionMask, sampleScaleM)),
            { note: `numPoints=${datasetQuota} scale=${sampleScaleM}m tileScale=16` },
        )
        : ee.FeatureCollection([]);

    const trainSet = inputTrainSamples
        .merge(thresholdSamples)
        .merge(datasetSamples);

    const rfTrees = liteMode ? cfg.LITE_RF_TREES : cfg.RF_TREES;
    const classifier = await log.run(
        'Assemble RF classifier graph (train + explain deferred) [LAZY]',
        () => Promise.resolve(
            ee.Classifier.smileRandomForest({
                numberOfTrees:     rfTrees,
                variablesPerSplit: cfg.RF_VARIABLES_PER_SPLIT,
                minLeafPopulation: cfg.RF_MIN_LEAF_POPULATION,
                bagFraction:       cfg.RF_BAG_FRACTION,
                seed:              rfSeed,
            }).train({
                features:        trainSet,
                classProperty:   'class',
                inputProperties: featureImage.bandNames(),
            }),
        ),
        { note: `trees=${rfTrees} bag=${cfg.RF_BAG_FRACTION}` },
    );

    // Đây là điểm evaluate() ĐẦU TIÊN, kéo toàn bộ đồ thị (composite → indices
    // → threshold → dataset → sampling → RF train) chạy trên EE.
    // Nếu time-out xảy ra ở stage này → điểm nghẽn nằm ở sampling/training.
    let oobPct = null;
    if (!skipStats) {
        oobPct = await log.run(
            'EVALUATE OOB accuracy (forces sampling + RF training on EE)',
            async () => {
                const rfInfo      = ee.Dictionary(classifier.explain());
                const oobAccuracy = ee.Number(1)
                    .subtract(ee.Number(rfInfo.get('outOfBagErrorEstimate')))
                    .multiply(100);
                return eeEval(oobAccuracy);
            },
            { note: 'blocking evaluate() — first heavy call' },
        );
        log.mark('OOB accuracy', `${oobPct != null ? oobPct.toFixed(2) : 'null'}%`);
    }

    // ── Independent test accuracy from ground-truth holdout ──────────────
    let testAccuracyPct = null;
    let testKappa       = null;
    if (!skipStats && hasGT) {
        await log.run(
            'EVALUATE independent test accuracy + kappa (ground-truth holdout)',
            async () => {
                const classOrder = ee.List.sequence(0, cfg.CLASS_NAMES.length - 1);
                const validated  = inputTestSamples.classify(classifier);
                const matrix     = validated.errorMatrix('class', 'classification', classOrder);
                const testSize   = await eeEval(inputTestSamples.size());
                if (testSize > 0) {
                    testAccuracyPct = await eeEval(ee.Number(matrix.accuracy()).multiply(100));
                    testKappa       = await eeEval(matrix.kappa());
                }
            },
        );
    }

    // JRC stable-water post-correction (§14.13 in the GEE script).
    const classified = await log.run(
        'Classify + JRC stable-water correction [LAZY]',
        () => Promise.resolve((() => {
            const jrc       = ee.Image('JRC/GSW1_4/GlobalSurfaceWater').clip(region);
            const jrcStable = jrc.select('occurrence').unmask(0).gte(70)
                .and(jrc.select('recurrence').unmask(0).gte(70));
            const mndwiBase = base.normalizedDifference(['green', 'swir1']);
            const raw       = featureImage.classify(classifier).rename('classification')
                .toByte().clip(region);
            return raw.where(jrcStable.and(mndwiBase.gte(-0.05)), 9)
                .rename('classification').toByte().clip(region);
        })()),
    );

    return {
        classified,
        oobPct,
        testAccuracyPct,
        testKappa,
        hasGroundTruth: hasGT,
        quotas: { inputQuota, datasetQuota, thresholdQuota, inputTestQuota },
        featureImage,
        base,
        trainSet,
        inputTestSamples,
    };
}

module.exports = {
    buildPriorityLabel,
    buildFeatureImage,
    buildThresholdLabel,
    buildDatasetLabel,
    sampleFromLabel,
    sampleGroundTruth,
    buildExclusionMask,
    runRfClassification,
};
