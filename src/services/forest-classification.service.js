'use strict';

/**
 * Forest Classification Service (Phân loại lớp phủ rừng).
 *
 * Implements the 13-class Kon Tum forest classification schema v5.3.
 * The scheduled/admin flow uses the same lite Random Forest mode as
 * `/satellite/classified` so interactive GEE operations stay within quota.
 *
 * Pipeline:
 *   1. Build 3 composites: base (full year), dry (Jan-Apr), wet (Aug-Nov)
 *   2. Compute spectral indices (NDVI, NDWI, MNDWI, NDMI, NDBI, NBR, BSI, EVI)
 *      for base + seasonal amplitudes
 *   3. Add DEM bands (elevation, slope, aspect)
 *   4. Build threshold pseudo-labels (optional dataset labels via config)
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
    getKonTumDistrictsGeoJson,
    getEeMapId,
} = require('../utils/gee-satellite.util');

// Palette 13-class trùng với docs/kontum_forest_classification_final.js.
const CLASSIFIED_VIZ = {
    bands:   ['classification'],
    min:     0,
    max:     cfg.CLASS_NAMES.length - 1,
    palette: cfg.CLASS_PALETTE,
};
const { runRfClassification } = require('./forest-classification.pipeline');
const { makeStageLogger } = require('../utils/stage-logger.util');
const repo = require('../repositories/forest-classification.repository');
const geeQueue = require('../queues/gee-task.queue');
const districtRasterWorker = require('../workers/districtRasterExport.worker');
const geeAnalysisProcess = require('../workers/geeAnalysisProcess.worker');
const { BusinessLogicError } = require('../core/error.response');
const { StatusCodes } = require('../core/http-status-code');

// Full RF pipeline (feature image build, threshold + dataset pseudo-labels,
// stratified sampling, Random Forest training, JRC water correction) lives in
// forest-classification.pipeline.js and is shared with satellite.service.

// ── Debug helper ────────────────────────────────────────────────────────────
// FC_DEBUG=true (hoặc NODE_ENV=development) → in `[FOREST-CLS:DBG] ...` cho
// các checkpoint không critical (entry/exit public API, kết quả URL,
// auto-ingest decision). Info/warn/error luôn ghi bất kể flag.
const DEBUG = process.env.FC_DEBUG === 'true'
    || process.env.NODE_ENV === 'development';
const dbg = (tag, msg) => { if (DEBUG) console.debug(`[FOREST-CLS:DBG:${tag}] ${msg}`); };
const dbgTime = (tag, msg, t0) => {
    if (DEBUG) console.debug(`[FOREST-CLS:DBG:${tag}] ${msg} (${Date.now() - t0}ms)`);
};

// ── Area stats ────────────────────────────────────────────────────────────────

async function computeProvinceAreaStats(classified, region, scaleM) {
    const areaImg = ee.Image.pixelArea().divide(10000).addBands(classified.rename('class'));
    const result  = await eeEval(
        areaImg.reduceRegion({
            reducer:    ee.Reducer.sum().group({ groupField: 1, groupName: 'class' }),
            geometry:   region.geometry(),
            scale:      scaleM || cfg.AREA_STATS_SCALE_M,
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

async function computeDistrictAreaStats(classified, districts, scaleM) {
    const areaImg = ee.Image.pixelArea().divide(10000).addBands(classified.rename('class'));
    const reduced = areaImg.reduceRegions({
        collection: districts,
        reducer:    ee.Reducer.sum().group({ groupField: 1, groupName: 'class' }),
        scale:      scaleM || cfg.AREA_STATS_SCALE_M,
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

// ── Alert notification: top-3 changes ──────────────────────────────────────
// So sánh từng class giữa snapshot hiện tại vs prev, sort theo |change%| desc,
// gửi notification liệt kê 3 class biến động mạnh nhất. Chỉ trigger nếu class
// top-1 vượt ngưỡng ALERT_FOREST_CHANGE_PCT (default 2%).
//
// Cấu trúc payload:
//   title: "Cảnh báo biến động rừng YYYY/MM"
//   message: "Top 3 lớp biến động so với YYYY/MM trước:\n
//             1. <name>: +X.X% (a → b ha)\n
//             2. <name>: -Y.Y% ...\n
//             3. <name>: +Z.Z% ..."
async function sendTop3ChangesAlert(snapshot, prevSnapshot, provinceSummary) {
    try {
        const prevSummary = prevSnapshot?.province_summary;
        if (!prevSummary) {
            dbg('ALERT', 'skip — no previous snapshot for comparison');
            return;
        }
        const notifSvc = require('./notification.service');

        // Tính change cho MỌI class (kể cả class 0 "Đất khác"). Class có prev=0
        // và curr>0 → % = Infinity, treat as "mới xuất hiện" với +100%.
        const changes = [];
        for (let i = 0; i < cfg.CLASS_NAMES.length; i++) {
            const prevHa = Number(prevSummary.byClass?.[i]) || 0;
            const currHa = Number(provinceSummary.byClass?.[i]) || 0;
            if (prevHa === 0 && currHa === 0) continue;   // Class trống cả 2 kỳ → bỏ
            const pct = prevHa === 0
                ? 100                                     // Mới xuất hiện
                : ((currHa - prevHa) / prevHa) * 100;
            changes.push({
                classId:  i,
                name:     cfg.CLASS_NAMES[i],
                prevHa,
                currHa,
                deltaHa:  currHa - prevHa,
                pct,
                absPct:   Math.abs(pct),
            });
        }
        // Sort theo |change%| desc → 3 class biến động nhất.
        changes.sort((a, b) => b.absPct - a.absPct);
        const top3 = changes.slice(0, 3);
        if (top3.length === 0) return;

        // Ngưỡng trigger: class top-1 phải vượt ALERT_FOREST_CHANGE_PCT.
        const threshold = cfg.ALERT_FOREST_CHANGE_PCT;
        if (top3[0].absPct < threshold) {
            dbg('ALERT', `skip — top-1 change ${top3[0].absPct.toFixed(2)}% < threshold ${threshold}%`);
            return;
        }

        const period    = `${snapshot.year}/${String(snapshot.month).padStart(2,'0')}`;
        const prevPeriod = `${prevSnapshot.year}/${String(prevSnapshot.month).padStart(2,'0')}`;
        const lines = top3.map((c, idx) => {
            const sign = c.pct >= 0 ? '+' : '';
            return `  ${idx + 1}. ${c.name}: ${sign}${c.pct.toFixed(1)}% ` +
                   `(${c.prevHa.toLocaleString('vi')} → ${c.currHa.toLocaleString('vi')} ha)`;
        });
        const title = `Cảnh báo biến động rừng ${period}`;
        const body = `So sánh với ${prevPeriod}. Top 3 lớp biến động mạnh nhất:\n${lines.join('\n')}`;
        for (const role of ['system_admin', 'so_nnmt', 'ubnd_tinh']) {
            await notifSvc.broadcastToRole(role, {
                type: 'forest_change_alert',
                title,
                body,
                data: { snapshotId: snapshot.id, period, previousPeriod: prevPeriod, top3 },
                channel: 'alert',
            });
        }
        console.log(`[FOREST] top-3 alert dispatched period=${period} vs ${prevPeriod} top1=${top3[0].name} ${top3[0].pct.toFixed(1)}%`);
    } catch (err) {
        console.warn('[FOREST] Alert notification failed:', err.message);
    }
}

// ── Main analysis ─────────────────────────────────────────────────────────────

async function executeAnalysis(year, month, {
    trigger            = 'cron',
    requestedBy        = null,
    groundTruthAssetId = process.env.FC_GROUND_TRUTH_ASSET_ID || '',
    gtBufferM          = parseInt(process.env.FC_GT_BUFFER_M, 10) || 60,
    minFieldTest       = parseInt(process.env.FC_MIN_FIELD_TEST, 10) || 10,
    // NEW (033): cửa sổ query GT trước analysis. Mặc định 180 ngày (đủ đa dạng
    // sample cho RF 11 class). Env FC_GT_WINDOW_DAYS override.
    gtWindowDays       = Number(process.env.FC_GT_WINDOW_DAYS) || 180,
} = {}) {
    // Logger đánh dấu A → Z: khi bị time-out, log này cho biết đứng lại ở bước nào.
    const log = makeStageLogger('FOREST-CLS', {
        correlationId: `${year}-${String(month).padStart(2, '0')}`,
    });
    const startMs = Date.now();

    // Entry log — luôn ghi (không cần DEBUG) để trace tất cả run.
    console.log(
        `[FOREST-CLS] runAnalysis START period=${year}/${month} trigger=${trigger} ` +
        `hasGtAsset=${Boolean(groundTruthAssetId)} ` +
        `gtWindow=${gtWindowDays}d gtBuffer=${gtBufferM}m minFieldTest=${minFieldTest} ` +
        `requestedBy=${requestedBy || 'system'} debug=${DEBUG}`,
    );

    // NOTE (033): GT query moved INTO try/catch below (line ~200) — nếu
    // migration 033 chưa chạy, `getGtForAnalysis` throw ở tầng ngoài sẽ khiến
    // không tạo được snapshot → UI treo. Giờ snapshot LUÔN được tạo trước,
    // GT fail sẽ đi vào catch → status=failed + error_message rõ ràng.
    let gtData = { counts: { zones: 0, points: 0, byClass: {} }, zones: { features: [] }, points: { features: [] } };
    let groundTruthGeoJson = null;
    // hasGT computed lại sau khi query xong; hiện tại chỉ dựa asset ID.
    let hasGT = Boolean(groundTruthAssetId);

    let snapshot = await log.run('Create snapshot (new attempt) → status=computing', () =>
        repo.createSnapshot({
            year, month,
            status: 'computing',
            trigger,
            requested_by: requestedBy,
            download_scale_m: cfg.DOWNLOAD_SCALE_M,
            model_params: {
                version:        'v3-lite',
                mode:           'lite',
                rf_trees:       cfg.LITE_RF_TREES,
                rf_vars_split:  cfg.RF_VARIABLES_PER_SPLIT,
                bag_fraction:   cfg.RF_BAG_FRACTION,
                samples:        cfg.LITE_SAMPLES_PER_CLASS,
                sample_scale_m: cfg.LITE_SAMPLE_SCALE_M,
                area_scale_m:   200,
                download_scale_m: cfg.DOWNLOAD_SCALE_M,
                skip_stats:     true,
                ground_truth_asset_id: hasGT ? groundTruthAssetId : null,
                gt_buffer_m:    hasGT ? gtBufferM : null,
                blend_rule:     cfg.LITE_USE_DATASET_LABELS
                    ? (hasGT
                        ? 'Input 50% + Dataset 30% + Threshold 20%'
                        : 'Dataset 60% + Threshold 40%')
                    : (hasGT ? 'Input 50% + Threshold 50%' : 'Threshold 100%'),
            },
        }));

    try {
        await log.run('Initialize Earth Engine session', () => initializeEarthEngine());

        // ── GT query MOVED HERE (033 safety) ──────────────────────────────
        // Snapshot đã tạo → nếu GT fail sẽ đi vào catch bên dưới, set
        // status=failed + error_message thay vì crash silently.
        // Migration 033 chưa chạy → try/catch riêng để không kill toàn bộ
        // pipeline: log warning + tiếp tục với GT rỗng (fallback về dataset).
        try {
            const gtSvc = require('./forest-gt.service');
            const analysisEndDate = new Date(Date.UTC(year, month, 0));
            gtData = await log.run(
                `Fetch ground truth (window ${gtWindowDays}d before ${analysisEndDate.toISOString().slice(0, 10)})`,
                () => gtSvc.getGtForAnalysis(analysisEndDate, gtWindowDays),
            );
            log.mark('Ground truth',
                `zones=${gtData.counts.zones} points=${gtData.counts.points} byClass=${JSON.stringify(gtData.counts.byClass)}`);
            if (gtData.counts.zones + gtData.counts.points > 0) {
                groundTruthGeoJson = {
                    type: 'FeatureCollection',
                    features: [...gtData.zones.features, ...gtData.points.features],
                };
                hasGT = true;
            }
        } catch (gtErr) {
            // Migration 033 chưa chạy (table thiếu) → 42P01. Không block
            // pipeline: giữ hasGT=false, pipeline fallback về dataset blend.
            const code = gtErr.code || gtErr.name || '';
            console.warn(`[FOREST-CLS] GT query FAILED (${code}) — fallback không GT: ${gtErr.message}`);
            log.mark('Ground truth', `SKIPPED (${code}) — chạy migration 033 để enable`);
        }

        const region    = await log.run('Load Kon Tum region polygon',
            () => Promise.resolve(getKonTumRegion()));
        const districts = await log.run('Load Kon Tum districts collection',
            () => Promise.resolve(getKonTumDistricts()));

        // Cùng pattern satellite `/classified` — liteMode để tránh đồ thị full
        // vượt budget GEE. Admin vẫn lấy riêng OOB qua getInfo(callback), nhưng
        // bỏ test/kappa khi chưa có ground truth độc lập.
        // Full v3 mode (200 trees + DW+WC+JRC
        // dataset labels + 30m sample) đã proven vượt budget khi chạy cron.
        // Lite mode: threshold-only pseudo-labels + 80 trees + 100m sample →
        // graph nhẹ, getMapId trả trong ~15-30s. Chấp nhận sai số accuracy
        // vài % — snapshot vẫn dùng được để so sánh liên tháng.
        const rfResult = await runRfClassification(
            year,
            region,
            region.geometry(),
            {
                // v4.1: truyền thêm month để pipeline neo season windows đúng
                // (base = 12 tháng trước end-of-month, green/dry/defol chọn
                // cửa sổ gần nhất kết thúc ≤ anchor).
                month,
                // Seed = year*100+month (default trong pipeline nếu không truyền).
                // Đồng bộ với satellite `/classified` khi cùng năm + tháng + ROI.
                seed: year * 100 + month,
                groundTruthAssetId,
                groundTruthGeoJson,
                gtBufferM,
                minFieldTest,
                logger:    log,
                // Snapshot nghiệp vụ phải chạy đúng cấu hình v5.3 đầy đủ:
                // 1.800 mẫu, 100 cây RF và toàn bộ prior.
                liteMode:           false,
                computeOob:         true,
                computeTestMetrics: false,
            },
        );
        const { classified, quotas, oobPct } = rfResult;
        // Bản chưa reproject 200m — dùng cho getDownloadURL để GEE materialize
        // trực tiếp ở scale download (500m) thay vì burst compute ở 200m rồi
        // resample. Tránh HTTP 400 "User memory limit exceeded" khi ingest.
        // Fallback về `classified` cho backward-compat với pipeline cũ.
        const classifiedForDownload = rfResult.classifiedNative || classified;
        const modelMeta = rfResult.modelMeta || null;
        const testAccuracyPct = null, testKappa = null;

        // v5.3 thống kê ở 100 m (1 pixel xấp xỉ 1 ha), đồng bộ script chuẩn.
        const AREA_SCALE_M = cfg.AREA_STATS_SCALE_M;
        const provinceSummary = await log.run(
            'EVALUATE province area stats (reduceRegion sum groupBy class)',
            () => computeProvinceAreaStats(classified, region, AREA_SCALE_M),
            { note: `scale=${AREA_SCALE_M}m tileScale=8 bestEffort` },
        );
        log.mark('Province area',
            `totalHa=${provinceSummary.totalHa}, classes=${Object.keys(provinceSummary.byClass || {}).length}`);

        const districtAreas = await log.run(
            'EVALUATE district area stats (reduceRegions sum groupBy class, coarse 200m)',
            () => computeDistrictAreaStats(classified, districts, AREA_SCALE_M),
            { note: `scale=${AREA_SCALE_M}m tileScale=8` },
        );
        log.mark('District area rows', `${districtAreas.length}`);

        // GEE tile URL — client render trực tiếp raster phân loại 13 lớp.
        // Không phụ thuộc GeoServer/GCS.
        let geeMapId = null;
        let geeTileUrl = null;
        try {
            const mapInfo = await log.run(
                'Register GEE map (13-class viz → geeTileUrl)',
                () => getEeMapId(classified, CLASSIFIED_VIZ),
                { note: 'ee.data.getMapId — tile URL for /latest response' },
            );
            geeMapId   = mapInfo.mapId  || null;
            geeTileUrl = mapInfo.tileUrl || null;
        } catch (err) {
            console.warn(`[FOREST-CLS] getEeMapId failed (non-fatal): ${err.message}`);
        }

        // Seed export state; materialize raster huyện được chuyển sang worker
        // nền sau khi snapshot completed.
        const districtGeoJson = getKonTumDistrictsGeoJson();
        const areaByDistrict = new Map();
        for (const row of districtAreas) {
            const code = row.district_code ? String(row.district_code) : null;
            if (!code) continue;
            if (!areaByDistrict.has(code)) {
                areaByDistrict.set(code, {
                    name:    row.district_name,
                    byClass: {},
                });
            }
            const bag = areaByDistrict.get(code);
            bag.byClass[row.class_id] = (bag.byClass[row.class_id] || 0)
                + Number(row.area_ha || 0);
        }
        const districtSkeletons = districtGeoJson.map((district) => ({
            district_code: district.ADM2_CODE,
            district_name: district.ADM2_NAME,
        }));
        const seededDistrictExports = await log.run(
            `Seed ${districtSkeletons.length} forest_district_exports (status=pending)`,
            () => repo.insertDistrictExports(
                snapshot.id,
                districtSkeletons,
                cfg.DOWNLOAD_SCALE_M,
            ),
        );

        // Piggyback modelMeta vào province_summary._modelMeta (không cần migration).
        const provinceSummaryWithMeta = modelMeta
            ? { ...provinceSummary, _modelMeta: modelMeta }
            : provinceSummary;

        const forestHa = cfg.FOREST_CLASS_IDS.reduce(
            (sum, classId) => sum + Number(provinceSummary.byClass?.[classId] || 0),
            0,
        );
        const districtExportSummary = {
            scaleM:    cfg.DOWNLOAD_SCALE_M,
            total:     districtGeoJson.length,
            completed: 0,
            failed:    0,
            skipped:   0,
            pending:   districtGeoJson.length,
            totalHa:   provinceSummary.totalHa,
            forestHa:  Math.round(forestHa * 100) / 100,
            byClass:   provinceSummary.byClass || {},
        };

        // Persist số liệu huyện trước khi công bố snapshot completed để client
        // không thấy trạng thái hoàn tất nhưng districtAreas còn rỗng.
        await log.run('Persist district area rows',
            () => repo.replaceDistrictAreas(snapshot.id, districtAreas));

        snapshot = await log.run('Update snapshot → status=completed', () =>
            repo.updateStatus(snapshot.id, 'completed', {
                province_summary: provinceSummaryWithMeta,
                oob_accuracy:     oobPct != null ? Math.round(oobPct * 100) / 100 : null,
                test_accuracy:    testAccuracyPct != null ? Math.round(testAccuracyPct * 100) / 100 : null,
                test_kappa:       testKappa != null ? Math.round(testKappa * 1000) / 1000 : null,
                sample_quotas:    quotas,
                computed_at:      new Date(),
                duration_ms:      Date.now() - startMs,
                gee_map_id:       geeMapId,
                gee_tile_url:     geeTileUrl,
                gee_tile_generated_at: geeTileUrl ? new Date() : null,
                // gee_download_url NULL — FE lấy per-huyện qua district_exports.
                gee_download_url: null,
                district_export_summary: districtExportSummary,
                download_scale_m: cfg.DOWNLOAD_SCALE_M,
                gt_zone_count:    gtData.counts.zones,
                gt_point_count:   gtData.counts.points,
                gt_window_days:   gtWindowDays,
            }));

        districtRasterWorker.enqueue({
            kind:       'forest-classification',
            snapshotId: snapshot.id,
            label:      `Forest district rasters ${year}-${String(month).padStart(2, '0')} snapshot=${snapshot.id}`,
            run: () => runForestDistrictRasterExport({
                snapshot,
                year,
                month,
                districtGeoJson,
                areaByDistrict,
                classifiedForDownload,
                seededDistrictExports,
                provinceSummary,
            }),
        }).catch((error) => {
            console.error(
                `[FOREST-CLS] district raster worker snapshot=${snapshot.id} failed: ${error.message}`,
            );
        });

        const prevSnapshot = await log.run(
            'Fetch previous completed snapshot (for area-change alert)',
            () => repo.getPreviousCompleted(year, month),
        );
        await log.run('Evaluate + dispatch top-3 changes alert',
            () => sendTop3ChangesAlert(snapshot, prevSnapshot, provinceSummary));

        log.summary();

        // Dedup notification (migration 040): chỉ gửi noti lần đầu completed
        // của kỳ (year, month). Attempt retry hoặc admin refresh sau khi có
        // completed sẽ KHÔNG spam noti tới 3 role nữa.
        _safe(async () => {
            const prior = await repo.countPriorCompletedAttempts(snapshot.id).catch(() => 0);
            if (prior > 0) {
                console.log(`[FOREST-CLS] notification SKIP — đã có ${prior} attempt completed trước (dedup theo year/month)`);
                return;
            }
            await _notifyForestClassificationCompleted(snapshot, provinceSummary);
        });

        return snapshot;
    } catch (err) {
        log.summary();
        console.error(`[FOREST-CLS] runAnalysis ${year}-${month} failed:`, err.message);
        await repo.updateStatus(snapshot.id, 'failed', { error_message: err.message });
        _safe(() => _notifyForestClassificationFailed(year, month, err.message));
        throw err;
    }
}

async function runForestDistrictRasterExport({
    snapshot,
    year,
    month,
    districtGeoJson,
    areaByDistrict,
    classifiedForDownload,
    seededDistrictExports,
    provinceSummary,
}) {
    const tag = `${year}${String(month).padStart(2, '0')}`;
    const rowByCode = new Map();
    for (const row of seededDistrictExports) {
        rowByCode.set(String(row.district_code || ''), row);
    }

    const counters = {
        completed: 0,
        failed:    0,
        skipped:   0,
    };
    const total = seededDistrictExports.length;
    const totalForestHa = cfg.FOREST_CLASS_IDS.reduce(
        (sum, classId) => sum + Number(provinceSummary.byClass?.[classId] || 0),
        0,
    );
    const persistSummary = () => repo.updateDistrictExportSummary(snapshot.id, {
        scaleM: cfg.DOWNLOAD_SCALE_M,
        total,
        ...counters,
        pending: Math.max(
            0,
            total - counters.completed - counters.failed - counters.skipped,
        ),
        totalHa:  provinceSummary.totalHa,
        forestHa: Math.round(totalForestHa * 100) / 100,
        byClass:  provinceSummary.byClass || {},
    });

    console.info(
        `[FOREST-EXPORT] START snapshot=${snapshot.id} `
        + `period=${year}-${String(month).padStart(2, '0')} districts=${total}`,
    );

    for (const district of districtGeoJson) {
        const code = String(district.ADM2_CODE || '');
        const row = rowByCode.get(code);
        if (!row) {
            console.warn(
                `[FOREST-EXPORT] snapshot=${snapshot.id} district=${code || 'null'} `
                + 'không có district_export row',
            );
            continue;
        }

        const startedAt = Date.now();
        await repo.updateDistrictExport(row.id, {
            status:        'computing',
            started_at:    new Date(),
            error_message: null,
        });

        const bag = areaByDistrict.get(code) || { byClass: {} };
        const byClass = bag.byClass;
        let totalHa = 0;
        let forestHa = 0;
        for (const [classId, hectares] of Object.entries(byClass)) {
            totalHa += Number(hectares) || 0;
            if (cfg.FOREST_CLASS_IDS.includes(Number(classId))) {
                forestHa += Number(hectares) || 0;
            }
        }

        if (totalHa === 0) {
            await repo.updateDistrictExport(row.id, {
                status:         'skipped',
                area_by_class:  byClass,
                total_area_ha:  0,
                forest_area_ha: 0,
                duration_ms:    Date.now() - startedAt,
                completed_at:   new Date(),
                error_message:  'no pixels classified',
            });
            counters.skipped += 1;
            await persistSummary();
            continue;
        }

        const fileBase = `forest_class_${code}_${tag}`;
        try {
            const districtGeom = district.epsg && district.epsg !== 4326
                ? ee.Geometry(district.geometry, `EPSG:${district.epsg}`, false)
                : ee.Geometry(district.geometry);
            const timeoutMs = Number(process.env.FC_DOWNLOAD_TIMEOUT_MS)
                || 5 * 60_000;
            const url = await new Promise((resolve, reject) => {
                const timer = setTimeout(
                    () => reject(new Error(
                        `getDownloadURL timeout huyện=${code} sau ${timeoutMs}ms`,
                    )),
                    timeoutMs,
                );
                classifiedForDownload
                    .updateMask(classifiedForDownload.gt(0))
                    .visualize(CLASSIFIED_VIZ)
                    .clip(districtGeom)
                    .getDownloadURL(
                        {
                            name:        fileBase,
                            scale:       cfg.DOWNLOAD_SCALE_M || 150,
                            region:      districtGeom,
                            crs:         'EPSG:4326',
                            format:      'GEO_TIFF',
                            filePerBand: false,
                            maxPixels:   1e9,
                        },
                        (downloadUrl, error) => {
                            clearTimeout(timer);
                            if (error) {
                                reject(new Error(String(error.message || error)));
                            } else {
                                resolve(downloadUrl);
                            }
                        },
                    );
            });

            await repo.updateDistrictExport(row.id, {
                status:                'completed',
                area_by_class:         byClass,
                total_area_ha:         Math.round(totalHa * 100) / 100,
                forest_area_ha:        Math.round(forestHa * 100) / 100,
                gee_download_url:      url,
                gee_download_filename: `${fileBase}.zip`,
                gee_generated_at:      new Date(),
                duration_ms:           Date.now() - startedAt,
                completed_at:          new Date(),
                error_message:         null,
            });
            counters.completed += 1;

            await _autoIngestDistrict(snapshot, {
                exportId: row.id,
                code,
                name: district.ADM2_NAME,
                url,
                byClass,
                totalHa,
                forestHa,
            }, year, month).catch((error) => {
                console.warn(
                    `[FOREST-EXPORT] auto-ingest district=${code} `
                    + `failed (export vẫn completed): ${error.message}`,
                );
            });
        } catch (error) {
            console.warn(
                `[FOREST-EXPORT] snapshot=${snapshot.id} district=${code} `
                + `failed: ${error.message}`,
            );
            await repo.updateDistrictExport(row.id, {
                status:         'failed',
                area_by_class:  byClass,
                total_area_ha:  Math.round(totalHa * 100) / 100,
                forest_area_ha: Math.round(forestHa * 100) / 100,
                error_message:  error.message,
                duration_ms:    Date.now() - startedAt,
                completed_at:   new Date(),
            });
            counters.failed += 1;
        }

        await persistSummary();
        console.info(
            `[FOREST-EXPORT] PROGRESS snapshot=${snapshot.id} `
            + `completed=${counters.completed} failed=${counters.failed} `
            + `skipped=${counters.skipped}/${total}`,
        );
    }

    const summary = await persistSummary();
    console.info(
        `[FOREST-EXPORT] DONE snapshot=${snapshot.id} `
        + `completed=${counters.completed} failed=${counters.failed} `
        + `skipped=${counters.skipped}/${total}`,
    );
    return summary;
}

// Chặn hai request manual/user/cron cùng materialize một graph GEE cho cùng kỳ.
// Các caller đến sau dùng chung Promise và nhận cùng snapshot kết quả.
const activeRuns = new Map();
function runAnalysis(year, month, options = {}) {
    const key = `${year}-${String(month).padStart(2, '0')}`;
    const active = activeRuns.get(key);
    if (active) {
        console.warn(`[FOREST-CLS] runAnalysis DEDUPE period=${key} — reuse active run`);
        return active;
    }

    const run = geeQueue.enqueue({
        key:      `analysis:forest-classification:${key}`,
        label:    `Forest classification ${key}`,
        priority: 100,
        run:      () => (
            process.env.GEE_ANALYSIS_CHILD === 'true'
                ? executeAnalysis(year, month, options)
                : geeAnalysisProcess.run({
                    kind:    'forest-classification',
                    payload: { year, month, options },
                })
        ),
    })
        .catch(async (error) => {
            if (process.env.GEE_ANALYSIS_CHILD !== 'true') {
                await repo.failActiveRunsForPeriod(year, month, error.message)
                    .catch((dbError) => {
                        console.error(
                            `[FOREST-CLS] cannot close interrupted child run `
                            + `period=${key}: ${dbError.message}`,
                        );
                    });
            }
            throw error;
        })
        .finally(() => activeRuns.delete(key));
    activeRuns.set(key, run);
    return run;
}

// ── Notification / auto-ingest helpers ──────────────────────────────────────
const _safe = (fn) => {
    try {
        const r = fn();
        if (r?.catch) r.catch((e) => console.warn('[FOREST-CLS] async helper err:', e.message));
    } catch (e) {
        console.warn('[FOREST-CLS] sync helper err:', e.message);
    }
};

async function _notifyForestClassificationCompleted(snapshot, provinceSummary) {
    const notifSvc = require('./notification.service');
    const period = `${snapshot.year}-${String(snapshot.month).padStart(2, '0')}`;
    const byClass = provinceSummary?.byClass || {};
    const totalHa = Number(provinceSummary?.totalHa) || 0;
    const forestHa = cfg.FOREST_CLASS_IDS.reduce(
        (sum, classId) => sum + (Number(byClass[classId]) || 0),
        0,
    );
    const body = `Đã hoàn thành phân loại 11 lớp cho kỳ ${period}. `
        + `Tổng diện tích ${Math.round(totalHa).toLocaleString('vi')} ha; `
        + `diện tích rừng ${Math.round(forestHa).toLocaleString('vi')} ha. `
        + 'Raster GeoServer đang được xử lý tự động.';
    const data = {
        snapshotId: snapshot.id,
        year: snapshot.year,
        month: snapshot.month,
        period,
        totalHa,
        forestHa,
    };

    for (const role of ['system_admin', 'so_nnmt', 'ubnd_tinh']) {
        await notifSvc.broadcastToRole(role, {
            type: 'forest_classification_completed',
            title: `Phân loại lớp phủ rừng ${period} hoàn thành`,
            body,
            data,
            channel: 'system',
        }).catch((err) => {
            console.warn(`[FOREST-CLS] notify role=${role} failed:`, err.message);
        });
    }
}

async function _notifyForestClassificationFailed(year, month, errorMessage) {
    const notifSvc = require('./notification.service');
    const period = `${year}-${String(month).padStart(2, '0')}`;
    await notifSvc.broadcastToRole('system_admin', {
        type: 'forest_classification_failed',
        title: `Phân loại lớp phủ rừng ${period} thất bại`,
        body: errorMessage?.slice(0, 200) || 'Không rõ lỗi',
        data: { year, month, period, error: errorMessage },
        channel: 'system',
    }).catch(() => {});
}

async function _autoIngestDistrict(snapshot, districtRow, year, month) {
    if (!districtRow?.url) return;
    const ingestSvc = require('./raster-ingest.service');
    const tag       = `${year}${String(month).padStart(2, '0')}`;
    const code      = districtRow.code || 'unknown';
    const layerCode = `forest_class_${code}_${tag}_s${snapshot.id}`;
    console.log(`[FOREST-CLS] auto-ingest district=${code} enqueue snapshot=${snapshot.id} layer=${layerCode}`);
    const { job, deduplicated } = await ingestSvc.enqueue({
        sourceUrl:  districtRow.url,
        layerCode,
        nameVi:     `Phân loại rừng ${year}-${String(month).padStart(2, '0')} — ${districtRow.name || code}`,
        isPublic:   true,
        category:   'forest_district',
        requestParams: {
            linkedResource: { type: 'forest_district', id: snapshot.id, districtCode: code },
            year, month,
            scale_m:        cfg.DOWNLOAD_SCALE_M || 150,
            autoIngested:   true,
            // Xem ghi chú tương tự ở fire-risk.service.js _autoIngestDistrict —
            // enqueue() không có param layerGroup riêng, phải nhét vào requestParams
            // để _upsertRasterLayer đọc được job.request_params.layer_group.
            layer_group:    'phan_loai_rung',
        },
        user: null,
        lang: 'vi',
    });
    if (job.layer_code !== layerCode) {
        throw new Error(
            `Raster ingest job #${job.id} belongs to ${job.layer_code}, expected ${layerCode}.`,
        );
    }
    if (districtRow.exportId) {
        await repo.updateDistrictExport(districtRow.exportId, {
            raster_ingest_job_id: job.id,
        });
    }
    console.log(`[FOREST-CLS] auto-ingest district=${code} ${deduplicated ? 'DEDUPE' : 'ENQUEUED'} → job=${job.id} status=${job.status}`);
}

// GCS export path (submitExportTask/pollExports) đã BỎ — flow mới dùng
// getDownloadURL + raster-ingest queue (`_autoIngestSnapshot`) giống fire-risk.
// Đơn giản hơn, không phụ thuộc GCS bucket, không cần cron poll.

// ── Public API ────────────────────────────────────────────────────────────────

const roundComparisonValue = (value) => Math.round((Number(value) || 0) * 100) / 100;

const buildAreaMetric = (currentHa, previousHa) => {
    const current = roundComparisonValue(currentHa);
    const previous = roundComparisonValue(previousHa);
    const deltaHa = roundComparisonValue(current - previous);
    const changePct = previous > 0
        ? roundComparisonValue((deltaHa / previous) * 100)
        : (current === 0 ? 0 : null);
    return { currentHa: current, previousHa: previous, deltaHa, changePct };
};

const sumForestByClass = (byClass = {}) => cfg.FOREST_CLASS_IDS.reduce(
    (sum, classId) => sum + (Number(byClass[classId]) || 0),
    0,
);

const sumAllByClass = (byClass = {}) => Object.values(byClass).reduce(
    (sum, areaHa) => sum + (Number(areaHa) || 0),
    0,
);

const summarizeDistrict = (district) => {
    const byClass = {};
    let totalHa = 0;
    for (const item of (district?.classes || [])) {
        const classId = Number(item.classId);
        const areaHa = Number(item.areaHa) || 0;
        byClass[classId] = areaHa;
        totalHa += areaHa;
    }
    return { byClass, totalHa, forestHa: sumForestByClass(byClass) };
};

const buildSnapshotComparison = async (snapshot, districtAreas) => {
    if (!snapshot || !['completed', 'published'].includes(snapshot.status)) return null;

    const previousSnapshot = await repo.getPreviousCompleted(snapshot.year, snapshot.month);
    if (!previousSnapshot?.province_summary) return null;

    const currentSummary = snapshot.province_summary || {};
    const previousSummary = previousSnapshot.province_summary || {};
    const currentByClass = currentSummary.byClass || {};
    const previousByClass = previousSummary.byClass || {};
    const previousDistrictAreas = await repo.getDistrictAreas(previousSnapshot.id);
    const currentDistrictMap = new Map(
        (districtAreas || []).map((item) => [item.districtCode || item.districtName, item]),
    );
    const previousDistrictMap = new Map(
        previousDistrictAreas.map((item) => [item.districtCode || item.districtName, item]),
    );
    const districtKeys = new Set([...currentDistrictMap.keys(), ...previousDistrictMap.keys()]);

    const classes = cfg.CLASS_NAMES.map((className, classId) => ({
        classId,
        className,
        ...buildAreaMetric(currentByClass[classId], previousByClass[classId]),
    }));
    const districts = previousDistrictAreas.length > 0 ? [...districtKeys].map((key) => {
        const current = currentDistrictMap.get(key);
        const previous = previousDistrictMap.get(key);
        const currentStats = summarizeDistrict(current);
        const previousStats = summarizeDistrict(previous);
        return {
            districtCode: current?.districtCode || previous?.districtCode || null,
            districtName: current?.districtName || previous?.districtName || null,
            forest: buildAreaMetric(currentStats.forestHa, previousStats.forestHa),
        };
    }) : [];

    return {
        previousSnapshot: {
            id: previousSnapshot.id,
            year: previousSnapshot.year,
            month: previousSnapshot.month,
            computedAt: previousSnapshot.computed_at || null,
            publishedAt: previousSnapshot.published_at || null,
        },
        province: {
            total: buildAreaMetric(
                currentSummary.totalHa ?? sumAllByClass(currentByClass),
                previousSummary.totalHa ?? sumAllByClass(previousByClass),
            ),
            forest: buildAreaMetric(
                sumForestByClass(currentByClass),
                sumForestByClass(previousByClass),
            ),
            classes,
        },
        districts,
    };
};

const getLatest = async () => {
    const t0 = Date.now();
    let snapshot = await repo.getLatestCompleted();
    const newest = await repo.getLatest();
    const activeStatuses = new Set(['pending', 'computing', 'exporting']);
    const newestUpdatedAt = new Date(
        newest?.updated_at || newest?.created_at || 0,
    ).getTime();
    const activeMaxAgeMs = Number(process.env.FC_ACTIVE_RUN_MAX_AGE_MS)
        || 45 * 60 * 1000;
    const hasFreshActiveRun = newest
        && activeStatuses.has(newest.status)
        && Number.isFinite(newestUpdatedAt)
        && Date.now() - newestUpdatedAt < activeMaxAgeMs
        && (!snapshot || Number(newest.id) > Number(snapshot.id));
    if (hasFreshActiveRun) {
        dbgTime(
            'GET_LATEST',
            `active id=${newest.id} status=${newest.status} y/m=${newest.year}/${newest.month}`,
            t0,
        );
        return {
            snapshot: newest,
            districtAreas: [],
            stale: true,
            computing: true,
            comparison: null,
        };
    }
    if (!snapshot) {
        if (newest) {
            dbgTime('GET_LATEST', `pending id=${newest.id} status=${newest.status} y/m=${newest.year}/${newest.month}`, t0);
            return {
                snapshot: newest,
                districtAreas: [],
                stale: true,
                computing: activeStatuses.has(newest.status),
                comparison: null,
            };
        }
        dbgTime('GET_LATEST', 'no snapshot in DB → throw FC_NO_DATA', t0);
        throw new BusinessLogicError(
            'Chưa có dữ liệu phân loại rừng. Vui lòng thử lại sau.',
            ['FC_NO_DATA'],
            StatusCodes.SERVICE_UNAVAILABLE,
        );
    }
    if (snapshot.status === 'completed') {
        await repo.reconcileDistrictExportArtifacts(snapshot.id);
        const promoted = await repo.markPublishedIfDistrictsReady(snapshot.id);
        if (promoted) snapshot = promoted;
    }
    const districtAreas = await repo.getDistrictAreas(snapshot.id);
    const comparison = await buildSnapshotComparison(snapshot, districtAreas);
    dbgTime('GET_LATEST',
        `snapshot=${snapshot.id} y/m=${snapshot.year}/${snapshot.month} status=${snapshot.status} ` +
        `districts=${districtAreas.length} hasLayer=${Boolean(snapshot.geoserver_layer)} ` +
        `hasDlUrl=${Boolean(snapshot.gee_download_url)}`, t0);
    return {
        snapshot, districtAreas, comparison, stale: false, computing: false,
    };
};

const getHistory = async ({
    page = 1,
    limit = 24,
    hasGeoserverLayer,
    requireCompleteDistrictSet = false,
} = {}) => {
    const t0 = Date.now();
    const result = await repo.listCompleted({
        page,
        limit,
        hasGeoserverLayer,
        requireCompleteDistrictSet,
    });
    dbgTime('GET_HISTORY',
        `page=${page} limit=${limit} hasGeoserverLayer=${hasGeoserverLayer ?? 'all'} ` +
        `→ items=${result.items.length} total=${result.total}`, t0);
    return result;
};

const refresh = async ({ year, month, groundTruthAssetId, gtBufferM, minFieldTest } = {}) => {
    const now = new Date();
    const y   = year  || now.getUTCFullYear();
    const m   = month || (now.getUTCMonth() + 1);
    console.log(`[FOREST-CLS] refresh (manual) triggered for period=${y}/${m}`);
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
 * @returns {{ snapshot, districtAreas, comparison, cached, computing }}
 */
const queryForPeriod = async (year, month, userId = null) => {
    const existing = await repo.getByYearMonth(year, month);

    if (existing) {
        if (['completed', 'published'].includes(existing.status)) {
            const districtAreas = await repo.getDistrictAreas(existing.id);
            const comparison = await buildSnapshotComparison(existing, districtAreas);
            return { snapshot: existing, districtAreas, comparison, cached: true, computing: false };
        }
        if (['computing', 'exporting'].includes(existing.status)) {
            return {
                snapshot: existing, districtAreas: [], comparison: null,
                cached: false, computing: true,
            };
        }
        // failed / pending → fall through to re-trigger
    }

    // Trigger analysis in the background — respond immediately with computing=true.
    runAnalysis(year, month, { trigger: 'user', requestedBy: userId })
        .catch((err) => console.error(`[FOREST] user query y=${year} m=${month}:`, err.message));

    // Analysis chạy trong child process nên chờ ngắn để lấy ID attempt mới.
    // Không trả lại row `failed` cũ với computing=true khi child đang bootstrap.
    let pending = null;
    const previousId = existing?.id || null;
    for (let attempt = 0; attempt < 20; attempt++) {
        const candidate = await repo.getByYearMonth(year, month);
        if (
            candidate
            && candidate.id !== previousId
            && ['pending', 'computing'].includes(candidate.status)
        ) {
            pending = candidate;
            break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!pending) pending = { id: null, year, month, status: 'computing' };

    return {
        snapshot: pending, districtAreas: [], comparison: null,
        cached: false, computing: true,
    };
};

/**
 * Full audit log of all forest classification runs.
 * Includes every trigger (cron/manual/user), timing, OOB accuracy, errors.
 */
// ── Snapshot by ID ────────────────────────────────────────────────────────────

/**
 * Get a specific snapshot with district areas and nearest prior-period comparison.
 * Used by clients to poll a user-triggered analysis.
 */
const getSnapshotById = async (id) => {
    const snapshot = await repo.getById(id);
    if (!snapshot) return null;
    const districtAreas = ['completed', 'published'].includes(snapshot.status)
        ? await repo.getDistrictAreas(snapshot.id)
        : [];
    const comparison = await buildSnapshotComparison(snapshot, districtAreas);
    return { snapshot, districtAreas, comparison };
};

module.exports = {
    runAnalysis,
    getLatest,
    getHistory,
    refresh,
    queryForPeriod,
    getSnapshotById,
};
