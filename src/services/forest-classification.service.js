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
        await notifSvc.createSystemNotification({
            title:   `Cảnh báo biến động rừng ${period}`,
            message: `So sánh với ${prevPeriod}. Top 3 lớp biến động mạnh nhất:\n${lines.join('\n')}`,
            type:    'warning',
        });
        console.log(`[FOREST] top-3 alert dispatched period=${period} vs ${prevPeriod} top1=${top3[0].name} ${top3[0].pct.toFixed(1)}%`);
    } catch (err) {
        console.warn('[FOREST] Alert notification failed:', err.message);
    }
}

// ── Main analysis ─────────────────────────────────────────────────────────────

async function runAnalysis(year, month, {
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

        // Cùng pattern satellite `/classified` — liteMode + skipStats để tránh
        // GEE `evaluate()` timeout 5 phút. Full v3 mode (200 trees + DW+WC+JRC
        // dataset labels + 30m sample) đã proven vượt budget khi chạy cron.
        // Lite mode: threshold-only pseudo-labels + 80 trees + 100m sample →
        // graph nhẹ, getMapId trả trong ~15-30s. Chấp nhận sai số accuracy
        // vài % — snapshot vẫn dùng được để so sánh liên tháng.
        const { classified, quotas } = await runRfClassification(
            year,
            region,
            region.geometry(),
            {
                // Seed nhỏ — pipeline nhân với 2000 khi derive cho dataset
                // sample, phải bảo đảm không vượt int32 (2^31-1). Cũ:
                // `year*1000+month` → 2026007 → *2000 → overflow. Xem
                // commit fix clampSeed trong pipeline.
                seed: year * 20 + month,
                groundTruthAssetId,
                groundTruthGeoJson,
                gtBufferM,
                minFieldTest,
                logger:    log,
                // KEY CHANGES:
                liteMode:  true,   // skip DW+WC+JRC dataset labels
                skipStats: true,   // skip OOB/test/kappa evaluate() → tránh timeout
            },
        );
        // Metrics rỗng vì skipStats=true — vẫn lưu null trong DB.
        const oobPct = null, testAccuracyPct = null, testKappa = null;

        // Area stats — dùng coarse scale (200m) như satellite `/classified` để
        // reduceRegion mất ~10-20s thay vì 5+ phút. Chấp nhận sai số ±3% cho
        // trend liên tháng. AREA_STATS_SCALE_M cũ = 60m → replace 200m.
        const AREA_SCALE_M = 200;
        const provinceSummary = await log.run(
            'EVALUATE province area stats (reduceRegion sum groupBy class, coarse 200m)',
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

        // GEE download URL clip theo ranh giới tỉnh — GeoTIFF trần (image/tiff)
        // valid ~24h. Server auto-ingest sẽ pull về MinIO trước khi hết hạn.
        // Non-fatal: nếu getDownloadURL lỗi, snapshot vẫn completed, chỉ thiếu
        // link download + không auto-publish GeoServer (admin có thể refresh sau).
        // .visualize() → RGB 3-band để mở ra là ảnh MÀU (không cần palette metadata).
        let geeDownloadUrl = null;
        try {
            const tag = `${year}${String(month).padStart(2, '0')}`;
            const fileBase = `forest_class_kontum_${tag}`;
            const dlStart = Date.now();
            geeDownloadUrl = await log.run(
                'Generate GEE download URL (classified visualize → GeoTIFF RGB)',
                () => new Promise((resolve) => {
                    const timer = setTimeout(() => resolve(null), 60_000);
                    classified
                        // Mask class=0 ("Đất khác") để pixel không thuộc rừng
                        // render trong suốt trên WMS overlay — cùng cơ chế
                        // đã fix fire-risk.
                        .updateMask(classified.gt(0))
                        .visualize(CLASSIFIED_VIZ)
                        .clip(region.geometry())
                        .getDownloadURL(
                            {
                                name:        fileBase,
                                // DOWNLOAD_SCALE_M (200m) coarse hơn EXPORT
                                // (60m) — WMS tile 256px không cần độ chi
                                // tiết cao; scale 60m gây GEE timeout 30s.
                                scale:       cfg.DOWNLOAD_SCALE_M || 200,
                                region:      region.geometry(),
                                crs:         'EPSG:4326',
                                format:      'GEO_TIFF',
                                filePerBand: false,
                            },
                            (url) => { clearTimeout(timer); resolve(url || null); },
                        );
                }),
            );
            if (geeDownloadUrl) {
                dbgTime('DOWNLOAD_URL', `ok fileBase=${fileBase} len=${geeDownloadUrl.length}`, dlStart);
            } else {
                console.warn(`[FOREST-CLS] getDownloadURL TIMEOUT/NULL (30s) — snapshot ${year}/${month} sẽ không auto-ingest`);
            }
        } catch (err) {
            console.warn(`[FOREST-CLS] getDownloadURL failed (non-fatal): ${err.message}`);
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
                gee_download_url: geeDownloadUrl,
                gt_zone_count:    gtData.counts.zones,
                gt_point_count:   gtData.counts.points,
                gt_window_days:   gtWindowDays,
            }));

        await log.run('Persist district area rows',
            () => repo.replaceDistrictAreas(snapshot.id, districtAreas));

        const prevSnapshot = await log.run(
            'Fetch previous completed snapshot (for area-change alert)',
            () => repo.getPreviousCompleted(year, month),
        );
        await log.run('Evaluate + dispatch top-3 changes alert',
            () => sendTop3ChangesAlert(snapshot, prevSnapshot, provinceSummary));

        log.summary();

        // ── Auto ingest → MinIO → GeoServer (persistent COG) ──────────────
        // Cùng cơ chế fire-risk: cron chạy xong tự enqueue raster-ingest job.
        // Job worker (poll 15s) tự pick up. Snapshot được back-link
        // `geoserver_layer` khi ingest complete (queue service).
        // KHÔNG throw nếu enqueue fail — không được chặn pipeline chính.
        _safe(() => _autoIngestSnapshot(snapshot, geeDownloadUrl, year, month));

        return snapshot;
    } catch (err) {
        log.summary();
        console.error(`[FOREST-CLS] runAnalysis ${year}-${month} failed:`, err.message);
        await repo.updateStatus(snapshot.id, 'failed', { error_message: err.message });
        throw err;
    }
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

async function _autoIngestSnapshot(snapshot, geeDownloadUrl, year, month) {
    if (!geeDownloadUrl) {
        console.log('[FOREST-CLS] auto-ingest SKIP — no gee_download_url');
        return;
    }
    if (snapshot.geoserver_layer) {
        console.log(`[FOREST-CLS] auto-ingest SKIP — snapshot=${snapshot.id} already has geoserver_layer=${snapshot.geoserver_layer}`);
        return;
    }
    // Lazy require để tránh circular dependency với raster-ingest.service.
    const ingestSvc = require('./raster-ingest.service');
    const tag = `${year}${String(month).padStart(2, '0')}`;
    const layerCode = `forest_class_${tag}`;
    const t0 = Date.now();
    dbg('AUTO_INGEST', `enqueue prep snapshot=${snapshot.id} layer=${layerCode} scale=${cfg.DOWNLOAD_SCALE_M || 200}m urlLen=${geeDownloadUrl.length}`);
    console.log(`[FOREST-CLS] auto-ingest enqueue snapshot=${snapshot.id} layer=${layerCode}`);
    const { job, deduplicated } = await ingestSvc.enqueue({
        sourceUrl:  geeDownloadUrl,
        layerCode,
        nameVi:     `Phân loại rừng ${year}-${String(month).padStart(2, '0')}`,
        isPublic:   true,
        category:   'forest',
        requestParams: {
            linkedResource: { type: 'forest', id: snapshot.id },
            year,
            month,
            scale_m:        cfg.DOWNLOAD_SCALE_M || 200,   // scale URL sinh thật
            autoIngested:   true,   // trace: enqueue tự động vs admin bấm
        },
        user: null,  // system-triggered
        lang: 'vi',
    });
    console.log(`[FOREST-CLS] auto-ingest ${deduplicated ? 'DEDUPE' : 'ENQUEUED'} → job=${job.id} status=${job.status}`);
    dbgTime('AUTO_INGEST', `done job=${job.id} deduplicated=${Boolean(deduplicated)}`, t0);
}

// GCS export path (submitExportTask/pollExports) đã BỎ — flow mới dùng
// getDownloadURL + raster-ingest queue (`_autoIngestSnapshot`) giống fire-risk.
// Đơn giản hơn, không phụ thuộc GCS bucket, không cần cron poll.

// ── Public API ────────────────────────────────────────────────────────────────

const getLatest = async () => {
    const t0 = Date.now();
    const snapshot = await repo.getLatestCompleted();
    if (!snapshot) {
        const pending = await repo.getLatest();
        if (pending) {
            dbgTime('GET_LATEST', `pending id=${pending.id} status=${pending.status} y/m=${pending.year}/${pending.month}`, t0);
            return {
                snapshot: pending, districtAreas: [], stale: true, computing: true,
                geeTileUrl: null, geeMapId: null, classifiedViz: CLASSIFIED_VIZ,
            };
        }
        dbgTime('GET_LATEST', 'no snapshot in DB → throw FC_NO_DATA', t0);
        throw new BusinessLogicError(
            'Chưa có dữ liệu phân loại rừng. Vui lòng thử lại sau.',
            ['FC_NO_DATA'],
            StatusCodes.SERVICE_UNAVAILABLE,
        );
    }
    const districtAreas = await repo.getDistrictAreas(snapshot.id);
    dbgTime('GET_LATEST',
        `snapshot=${snapshot.id} y/m=${snapshot.year}/${snapshot.month} status=${snapshot.status} ` +
        `districts=${districtAreas.length} hasLayer=${Boolean(snapshot.geoserver_layer)} ` +
        `hasDlUrl=${Boolean(snapshot.gee_download_url)}`, t0);
    return {
        snapshot, districtAreas, stale: false, computing: false,
        geeTileUrl:    snapshot.gee_tile_url || null,
        geeMapId:      snapshot.gee_map_id   || null,
        classifiedViz: CLASSIFIED_VIZ,
    };
};

const getHistory = async ({ page = 1, limit = 24, hasGeoserverLayer } = {}) => {
    const t0 = Date.now();
    const result = await repo.listCompleted({ page, limit, hasGeoserverLayer });
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
    getLatest,
    getHistory,
    refresh,
    queryForPeriod,
    getLogs,
    getSnapshotById,
};
