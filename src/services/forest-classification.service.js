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
    getKonTumRegion,
    getKonTumDistricts,
    getEeMapId,
} = require('../utils/gee-satellite.util');

// Palette 11-class trùng với §0 CẤU HÌNH LỚP trong docs/kontum_forest_classification_final.js.
const CLASSIFIED_VIZ = {
    bands:   ['classification'],
    min:     0,
    max:     cfg.CLASS_NAMES.length - 1,
    palette: cfg.CLASS_PALETTE,
};
const { runRfClassification } = require('./forest-classification.pipeline');
const { makeStageLogger } = require('../utils/stage-logger.util');
const repo = require('../repositories/forest-classification.repository');
const { BusinessLogicError } = require('../core/error.response');
const { StatusCodes } = require('../core/http-status-code');

// Full RF pipeline (feature image build, threshold + dataset pseudo-labels,
// stratified sampling, Random Forest training, JRC water correction) lives in
// forest-classification.pipeline.js and is shared with satellite.service.

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
    submitExport       = cfg.isGcsConfigured(),
    trigger            = 'cron',
    requestedBy        = null,
    groundTruthAssetId = process.env.FC_GROUND_TRUTH_ASSET_ID || '',
    gtBufferM          = parseInt(process.env.FC_GT_BUFFER_M, 10) || 60,
    minFieldTest       = parseInt(process.env.FC_MIN_FIELD_TEST, 10) || 10,
} = {}) {
    // Logger đánh dấu A → Z: khi bị time-out, log này cho biết đứng lại ở bước nào.
    const log = makeStageLogger('FOREST-CLS', {
        correlationId: `${year}-${String(month).padStart(2, '0')}`,
    });
    const startMs = Date.now();
    const hasGT   = Boolean(groundTruthAssetId);

    await log.run('Initialize Earth Engine session', () => initializeEarthEngine());

    let snapshot = await log.run('Upsert snapshot → status=computing', () =>
        repo.upsertSnapshot({
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
                ground_truth_asset_id: hasGT ? groundTruthAssetId : null,
                gt_buffer_m:    hasGT ? gtBufferM : null,
                blend_rule:     hasGT
                    ? 'Input 50% + Dataset 30% + Threshold 20%'
                    : 'Dataset 60% + Threshold 40%',
            },
        }));

    try {
        const region    = await log.run('Load Kon Tum region polygon',
            () => Promise.resolve(getKonTumRegion()));
        const districts = await log.run('Load Kon Tum districts collection',
            () => Promise.resolve(getKonTumDistricts()));

        // Steps 1-7: full RF pipeline (feature image, pseudo-labels, sampling,
        // training, JRC water correction). Sub-stage logs come from the pipeline
        // — same logger is forwarded so all A→Z markers show in one stream.
        const {
            classified,
            oobPct,
            testAccuracyPct,
            testKappa,
            quotas,
        } = await runRfClassification(
            year,
            region,
            region.geometry(),
            {
                seed: year * 1000 + month,
                groundTruthAssetId,
                gtBufferM,
                minFieldTest,
                logger: log,
            },
        );

        // Steps 8-9: các evaluate() được TÁCH tuần tự thay vì Promise.all —
        // song song sẽ khiến EE phân bổ bộ nhớ đồng thời cho cả hai, dễ vượt
        // ngưỡng và cùng lúc time-out mà không biết bước nào chậm.
        const provinceSummary = await log.run(
            'EVALUATE province area stats (reduceRegion sum groupBy class)',
            () => computeProvinceAreaStats(classified, region),
            { note: `scale=${cfg.AREA_STATS_SCALE_M}m tileScale=8 bestEffort` },
        );
        log.mark('Province area',
            `totalHa=${provinceSummary.totalHa}, classes=${Object.keys(provinceSummary.byClass || {}).length}`);

        const districtAreas = await log.run(
            'EVALUATE district area stats (reduceRegions sum groupBy class)',
            () => computeDistrictAreaStats(classified, districts),
            { note: `scale=${cfg.AREA_STATS_SCALE_M}m tileScale=8` },
        );
        log.mark('District area rows', `${districtAreas.length}`);

        // GEE tile URL — client render trực tiếp raster phân loại 11 lớp.
        // Không phụ thuộc GeoServer/GCS.
        let geeMapId = null;
        let geeTileUrl = null;
        try {
            const mapInfo = await log.run(
                'Register GEE map (11-class viz → geeTileUrl)',
                () => getEeMapId(classified, CLASSIFIED_VIZ),
                { note: 'ee.data.getMapId — tile URL for /latest response' },
            );
            geeMapId   = mapInfo.mapId  || null;
            geeTileUrl = mapInfo.tileUrl || null;
        } catch (err) {
            console.warn(`[FOREST-CLS] getEeMapId failed (non-fatal): ${err.message}`);
        }

        snapshot = await log.run('Update snapshot → status=completed', () =>
            repo.updateStatus(snapshot.id, 'completed', {
                province_summary: provinceSummary,
                oob_accuracy:     oobPct != null ? Math.round(oobPct * 100) / 100 : null,
                test_accuracy:    testAccuracyPct != null ? Math.round(testAccuracyPct * 100) / 100 : null,
                test_kappa:       testKappa != null ? Math.round(testKappa * 1000) / 1000 : null,
                sample_quotas:    quotas,
                computed_at:      new Date(),
                duration_ms:      Date.now() - startMs,
                gee_map_id:       geeMapId,
                gee_tile_url:     geeTileUrl,
                gee_tile_generated_at: geeTileUrl ? new Date() : null,
            }));

        await log.run('Persist district area rows',
            () => repo.replaceDistrictAreas(snapshot.id, districtAreas));

        const prevSnapshot = await log.run(
            'Fetch previous completed snapshot (for area-change alert)',
            () => repo.getPreviousCompleted(year, month),
        );
        await log.run('Evaluate + dispatch area-change alert',
            () => sendAreaChangeAlert(snapshot, prevSnapshot, provinceSummary));

        if (submitExport) {
            const taskName = await log.run(
                'Submit GEE raster export task (async)',
                () => submitExportTask(classified, year, month, region),
            );
            snapshot = await repo.updateStatus(snapshot.id, 'exporting', { gee_task_id: taskName });
        }

        log.summary();
        return snapshot;
    } catch (err) {
        log.summary();
        console.error(`[FOREST-CLS] runAnalysis ${year}-${month} failed:`, err.message);
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
        if (pending) return {
            snapshot: pending, districtAreas: [], stale: true, computing: true,
            geeTileUrl: null, geeMapId: null, classifiedViz: CLASSIFIED_VIZ,
        };
        throw new BusinessLogicError(
            'Chưa có dữ liệu phân loại rừng. Vui lòng thử lại sau.',
            ['FC_NO_DATA'],
            StatusCodes.SERVICE_UNAVAILABLE,
        );
    }
    const districtAreas = await repo.getDistrictAreas(snapshot.id);
    return {
        snapshot, districtAreas, stale: false, computing: false,
        geeTileUrl:    snapshot.gee_tile_url || null,
        geeMapId:      snapshot.gee_map_id   || null,
        classifiedViz: CLASSIFIED_VIZ,
    };
};

const getHistory = async ({ page = 1, limit = 24 } = {}) =>
    repo.listCompleted({ page, limit });

const refresh = async ({ year, month, groundTruthAssetId, gtBufferM, minFieldTest } = {}) => {
    const now = new Date();
    const y   = year  || now.getUTCFullYear();
    const m   = month || (now.getUTCMonth() + 1);
    return runAnalysis(y, m, {
        trigger: 'manual',
        ...(groundTruthAssetId ? { groundTruthAssetId } : {}),
        ...(gtBufferM != null    ? { gtBufferM }        : {}),
        ...(minFieldTest != null ? { minFieldTest }     : {}),
    });
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
