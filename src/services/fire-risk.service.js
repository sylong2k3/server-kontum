'use strict';

/**
 * Fire Risk Service (EP-06 — Cảnh báo cháy rừng), v8.1.
 *
 * Delegates the GEE pipeline to `fire-risk.pipeline.js`, which mirrors
 * docs/kontum_fire_warning_final.js:
 *   - Predictors: 30-day S2 (NDVI/NDMI/NBR) + LST + ERA5 + terrain + fuelK
 *   - P Nesterov with daily rain-reset (QĐ 25/2022 lookup)
 *   - Optional Random Forest classifier trained on 20 dry-season months
 *     of MCD64A1 + FireCCI51 + FIRMS labels
 *   - Blend: 50% input + 30% dataset + 20% threshold (with INPUT)
 *            60% dataset + 40% threshold (without INPUT)
 *   - Data-quality Level 0 when neither S2 nor LST observed in the window
 *   - Priority warning: model risk (3) | FIRMS recent (4) | confirmed input (5)
 *
 * This service adds server-side concerns: DB snapshots, district reduceRegions,
 * area statistics, GeoTIFF export → GCS → MinIO → GeoServer publish.
 *
 * Node.js GEE SDK note:
 *   Use .evaluate(callback) (promisified via eeEvaluate) instead of print().
 *   Heavy computations use tileScale 4-16 to avoid EE memory errors.
 */

const fs     = require('fs');
const path   = require('path');
const cfg    = require('../configs/fire-risk');
const { ee, initializeEarthEngine } = require('../configs/gge');
const repo   = require('../repositories/fire-risk.repository');
const {
    eeEval: eeEvaluate,
    getKonTumRegion,
    getKonTumDistricts,
    getKonTumDistrictsSource,
    getKonTumBoundarySource,
    getEeMapId,
    todayUtc,
    fmtDate,
} = require('../utils/gee-satellite.util');

// Palette + range của RiskLevel 1-5 — trùng với §22 trong docs/kontum_fire_warning_final.js.
// Pixel level=0 (không đủ dữ liệu / ngoài rừng) SẼ BỊ MASK trước khi visualize
// → GeoTIFF output có nodata → GeoServer render trong suốt, KHÔNG còn nền trắng
// đè lên basemap. Palette bây giờ chỉ define 5 cấp thực sự.
const RISK_LEVEL_VIZ = {
    bands:   ['RiskLevel'],
    min:     1,
    max:     5,
    palette: ['00a65a', 'f6e84a', 'f39c12', 'e74c3c', '7b241c'],
};

// NOTE — HARD-CODED, KHÔNG dùng env override.
// User đã quyết định 1 file duy nhất tại `data/RanhGioiTinh_Polygon.geojson`.
const KON_TUM_PROVINCE_PATH = path.resolve(__dirname, '../../data/RanhGioiTinh_Polygon.geojson');
let _cachedProvinceGeoJson = null;

/**
 * Đọc polygon tỉnh Kon Tum từ RanhGioiTinh_Polygon.geojson. Cache singleton.
 * Trả về { geometry, properties } với geometry đã strip Z (WGS84 2D).
 * KHÔNG evaluate() qua GEE — đọc thẳng file, chi phí ~ms.
 *
 * Properties file gốc gồm: Ma_DVHC (mã đơn vị hành chính), Ten_tinh (tên tiếng
 * Việt có dấu), Dien_tich (diện tích ha), Dan_so, Matdo_dans, MapID, Shape_Leng,
 * Shape_Area — được preserve nguyên để client hiển thị/log.
 */
function loadLocalProvinceGeoJson() {
    if (_cachedProvinceGeoJson) return _cachedProvinceGeoJson;
    try {
        const raw = fs.readFileSync(KON_TUM_PROVINCE_PATH, 'utf8');
        const doc = JSON.parse(raw);
        const feature = doc.type === 'FeatureCollection'
            ? doc.features?.[0]
            : (doc.type === 'Feature' ? doc : null);
        const geom = feature?.geometry
            || (doc.type === 'Polygon' || doc.type === 'MultiPolygon' ? doc : null);
        if (!geom) throw new Error('Không thấy geometry hợp lệ');
        _cachedProvinceGeoJson = {
            type:        geom.type,
            coordinates: _stripZ(geom.coordinates),   // 3D [x,y,0] → 2D [x,y]
            _properties: feature?.properties || {},   // preserve Ten_tinh, Ma_DVHC, …
        };
        return _cachedProvinceGeoJson;
    } catch (err) {
        console.warn(`[FIRE-RISK] Không đọc được ${KON_TUM_PROVINCE_PATH}: ${err.message}`);
        return null;
    }
}

function _stripZ(coords) {
    if (typeof coords[0] === 'number') return coords.slice(0, 2);
    return coords.map(_stripZ);
}

/**
 * Centroid xấp xỉ từ bbox của GeoJSON geometry (Polygon / MultiPolygon).
 * Client dùng cho fly-to. Trả { lng, lat } hoặc null.
 */
function computeCentroid(geometry) {
    if (!geometry?.coordinates) return null;
    let minX =  Infinity, minY =  Infinity;
    let maxX = -Infinity, maxY = -Infinity;
    const walk = (arr) => {
        if (typeof arr[0] === 'number') {
            const [x, y] = arr;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        } else {
            for (const inner of arr) walk(inner);
        }
    };
    walk(geometry.coordinates);
    if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
    return {
        lng: (minX + maxX) / 2,
        lat: (minY + maxY) / 2,
    };
}
const { runFireRiskAnalysis } = require('./fire-risk.pipeline');
const { pollGeeTask, publishRasterToMinio } = require('../utils/gee-export.helper');
const { makeStageLogger } = require('../utils/stage-logger.util');
const { BusinessLogicError } = require('../core/error.response');
const { StatusCodes } = require('../core/http-status-code');

// ── District statistics ───────────────────────────────────────────────────────

/**
 * Compute per-district area (ha) by risk level using reduceRegions.
 * Returns plain JS object from GEE evaluate().
 */
async function computeDistrictStats(riskLevel, pNesterov, s2Observed45, blendCase, modelConfidenceClass, districts, region) {
    const SCALE = 500;
    const TILE  = 8;

    // Histogram of risk levels + blend case + confidence per district;
    // mean of P Nesterov + S2 observation coverage.
    const histImg = riskLevel.rename('riskLevel')
        .addBands(blendCase.rename('blendCase'))
        .addBands(modelConfidenceClass.rename('confidenceClass'))
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
        // Centroid tính client-side từ bounding box của polygon — dùng làm điểm
        // đặt fire icon marker. Server không tự gọi ee.Geometry.centroid() vì
        // sẽ thêm 1 evaluate() phụ; bbox mean quá đủ chính xác cho placement.
        const centroid = computeCentroid(feat.geometry);
        const hist = p.riskLevel_histogram || {};
        const blendHist = p.blendCase_histogram || {};
        const confHist  = p.confidenceClass_histogram || {};
        // Convert pixel counts to ha: 1 pixel at 500m scale = 25 ha.
        const pixelHa = (SCALE / 1000) ** 2 * 100; // km² → ha
        const levelDist = {};
        // Level 0 = no observation; include for coverage totals but exclude from risk.
        for (let l = 0; l <= 5; l++) {
            const ha = (hist[String(l)] || 0) * pixelHa;
            levelDist[l] = Math.round(ha * 100) / 100;
        }
        return {
            unitCode:          p.ADM2_CODE  || null,
            name:              p.ADM2_NAME  || p.ADM1_NAME || null,
            // Polygon huyện: reduceRegions giữ nguyên geometry của mỗi feature
            // đầu vào. Đây là mảnh khoá để client vẽ được feature lên bản đồ
            // (không còn null → không còn fallback lat/lng = 0,0).
            geometry:          feat.geometry || null,
            // Điểm centroid từ bbox polygon — client cắm fire-icon marker ở đây.
            // Nếu geometry null (fallback FAO cache cũ), centroid cũng null,
            // client sẽ dùng bảng KONTUM_DISTRICT_CENTROIDS làm dự phòng.
            centroid,
            riskLevelDist:     levelDist,
            blendCaseHa: {
                withInput:    Math.round((blendHist['1'] || 0) * pixelHa * 100) / 100,
                withoutInput: Math.round((blendHist['2'] || 0) * pixelHa * 100) / 100,
            },
            confidenceHa: {
                none:   Math.round((confHist['0'] || 0) * pixelHa * 100) / 100,
                low:    Math.round((confHist['1'] || 0) * pixelHa * 100) / 100,
                medium: Math.round((confHist['2'] || 0) * pixelHa * 100) / 100,
                high:   Math.round((confHist['3'] || 0) * pixelHa * 100) / 100,
            },
            pNesterovMean: Math.round((p.pNesterov_mean || 0) * 100) / 100,
            s2Coverage:    Math.round((p.s2Obs_mean || 0) * 1000) / 1000,
        };
    });

    return stats;
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
        mean:        Math.round((result.NesterovP_mean || 0) * 10) / 10,
        max:         Math.round((result.NesterovP_max  || 0) * 10) / 10,
        p10:         Math.round((result['NesterovP_p10'] || 0) * 10) / 10,
        p50:         Math.round((result['NesterovP_p50'] || 0) * 10) / 10,
        p90:         Math.round((result['NesterovP_p90'] || 0) * 10) / 10,
        levelBreaks: { p1, p2, p3, p4 },
    };
}

// ── Raster export (async, GCS → MinIO → GeoServer) ───────────────────────────

/**
 * Submit GEE export task to Google Cloud Storage.
 * Returns GEE task name string, or `null` when GCS is not configured.
 *getKonTumBoundarySource
 * Trả về null thay vì throw để analysis pipeline không fail toàn bộ khi
 * người vận hành chưa cấu hình GEE_GCS_BUCKET — DB snapshot + tile URL
 * vẫn được giữ, chỉ bỏ bước xuất GeoTIFF sang GeoServer.
 */
async function submitGeeExportTask(riskLevel, analysisDate) {
    if (!cfg.isGcsConfigured()) {
        console.warn('[FIRE-RISK] GEE_GCS_BUCKET chưa cấu hình — bỏ qua raster export. ' +
            'Set biến môi trường GEE_GCS_BUCKET + GOOGLE_APPLICATION_CREDENTIALS để bật.');
        return null;
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

// ── District → province aggregation ──────────────────────────────────────────

/**
 * Aggregate provinceSummary trực tiếp từ mảng districtStats — thay cho
 * reduceRegion province riêng biệt. Tiết kiệm 1 evaluate() (~24s) và loại
 * bỏ bug: reduceRegion province từng trả riskLevelDist=0 khi geodesic/CRS
 * lệch với reduceRegions của districts.
 *
 * Trọng số weightHa = Σ(riskLevelDist[1..5]) — diện tích ha thực có kết quả
 * phân loại (level ≥ 1). Chỉ dùng nội bộ để tính avgRiskLevel, s2Cov, pNest,
 * KHÔNG expose ra response vì trùng khái niệm với "sinh khối rừng" dễ gây
 * hiểu nhầm ở FE.
 *
 * @param {Array<object>} districtStats — output của computeDistrictStats
 * @returns {object} shape giống computeProvinceSummary cũ (không có totalForestHa)
 */
function aggregateProvinceFromDistricts(districtStats) {
    const riskLevelDist = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    const blendCaseHa   = { withInput: 0, withoutInput: 0 };
    const confidenceHa  = { none: 0, low: 0, medium: 0, high: 0 };
    let weightedRiskSum = 0; // Σ(level × ha) — dùng tính avgRiskLevel
    let weightedPSum    = 0; // Σ(pNesterovMean × weightHa)
    let weightedS2Sum   = 0; // Σ(s2Coverage × weightHa)

    for (const d of districtStats || []) {
        const dist = d.riskLevelDist || {};
        let dWeight = 0;
        for (let l = 0; l <= 5; l++) {
            const ha = Number(dist[l]) || 0;
            riskLevelDist[l] += ha;
            if (l >= 1) {
                weightedRiskSum += l * ha;
                dWeight += ha;
            }
        }
        blendCaseHa.withInput    += Number(d.blendCaseHa?.withInput)    || 0;
        blendCaseHa.withoutInput += Number(d.blendCaseHa?.withoutInput) || 0;
        confidenceHa.none        += Number(d.confidenceHa?.none)   || 0;
        confidenceHa.low         += Number(d.confidenceHa?.low)    || 0;
        confidenceHa.medium      += Number(d.confidenceHa?.medium) || 0;
        confidenceHa.high        += Number(d.confidenceHa?.high)   || 0;
        if (dWeight > 0) {
            weightedPSum  += (Number(d.pNesterovMean) || 0) * dWeight;
            weightedS2Sum += (Number(d.s2Coverage)    || 0) * dWeight;
        }
    }

    let maxLevel = 0;
    for (let l = 5; l >= 1; l--) if ((riskLevelDist[l] || 0) > 0) { maxLevel = l; break; }
    const totalWeight = riskLevelDist[1] + riskLevelDist[2] + riskLevelDist[3]
                      + riskLevelDist[4] + riskLevelDist[5];
    const round2 = (n) => Math.round(n * 100) / 100;
    const round3 = (n) => Math.round(n * 1000) / 1000;

    return {
        maxLevel,
        riskLevelDist: Object.fromEntries(
            Object.entries(riskLevelDist).map(([k, v]) => [k, round2(v)]),
        ),
        avgRiskLevel: totalWeight > 0
            ? Math.round((weightedRiskSum / totalWeight) * 100) / 100
            : null,
        blendCaseHa: {
            withInput:    round2(blendCaseHa.withInput),
            withoutInput: round2(blendCaseHa.withoutInput),
        },
        confidenceHa: {
            none:   round2(confidenceHa.none),
            low:    round2(confidenceHa.low),
            medium: round2(confidenceHa.medium),
            high:   round2(confidenceHa.high),
        },
        pNesterovProvMean: totalWeight > 0 ? round2(weightedPSum  / totalWeight) : 0,
        s2CoverageRatio:   totalWeight > 0 ? round3(weightedS2Sum / totalWeight) : 0,
    };
}

// ── District-level vector features ───────────────────────────────────────────

/**
 * Build fire_risk_features rows từ districtStats: mỗi huyện + mỗi cấp có
 * diện tích > 0 → 1 row. Geometry là polygon huyện (từ reduceRegions output,
 * đã ở EPSG:4326). Persist geojson → PostGIS ST_GeomFromGeoJSON.
 *
 * @param {string} snapshotId
 * @param {Array<object>} districtStats — output của computeDistrictStats
 * @returns {Array<object>} rows cho repo.replaceFeatures
 */
function buildFeaturesFromDistrictStats(snapshotId, districtStats) {
    const rows = [];
    for (const d of districtStats || []) {
        const dist = d.riskLevelDist || {};
        const geoJsonText = d.geometry
            ? JSON.stringify({ type: d.geometry.type, coordinates: d.geometry.coordinates })
            : null;
        const centroid = d.centroid || null;
        const pMean    = Number.isFinite(d.pNesterovMean) ? d.pNesterovMean : null;
        const s2Cov    = Number.isFinite(d.s2Coverage)    ? d.s2Coverage    : null;
        for (let l = 1; l <= 5; l++) {
            const areaHa = Number(dist[l]) || 0;
            if (areaHa <= 0) continue;
            rows.push({
                risk_level:      l,
                district_code:   d.unitCode ? String(d.unitCode) : null,
                district_name:   d.name || null,
                area_ha:         areaHa,
                p_nesterov_mean: pMean,
                ndvi_mean:       null,
                properties: {
                    s2Coverage: s2Cov,
                    centroid,
                    scope:      'district',
                },
                geojson: geoJsonText,
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
async function runAnalysis(analysisDate, {
    submitExport      = cfg.isGcsConfigured(),
    enableRf          = cfg.ENABLE_RF,
    inputFireAssetId  = cfg.INPUT_FIRE_ASSET_ID,
    // OOB accuracy diagnostic (chỉ dùng khi enableRf=true). Mặc định lấy từ
    // cfg.COMPUTE_OOB (env FIRE_RISK_COMPUTE_OOB). Bật thêm 30-90s vì force
    // train RF materialize trên EE server, đổi lại có metric chất lượng model.
    computeOob        = cfg.COMPUTE_OOB,
    // Cửa sổ query GT trước analysisDate (mặc định 30 ngày, cùng cửa sổ predictor S2).
    // Bỏ qua override khi caller explicit pass qua env FIRE_RISK_GT_WINDOW_DAYS.
    gtWindowDays      = Number(process.env.FIRE_RISK_GT_WINDOW_DAYS) || 30,
} = {}) {
    // Logger A → Z: mọi bước dựng graph + mọi evaluate() đều được đánh dấu
    // để khi time-out xảy ra, ta biết chính xác bước nào bị nghẽn.
    const log = makeStageLogger('FIRE-RISK', { correlationId: analysisDate });

    await log.run('Initialize Earth Engine session', () => initializeEarthEngine());

    let snapshot = await log.run('Upsert snapshot → status=computing', () =>
        repo.upsertSnapshot({
            analysis_date: analysisDate,
            status: 'computing',
            model_params: {
                version:             'v8.1',
                feature_window_days: cfg.FEATURE_WINDOW_DAYS,
                s2_fallback_days:    cfg.S2_FALLBACK_DAYS,
                lst_fallback_days:   cfg.LST_FALLBACK_DAYS,
                nesterov_lookback:   cfg.NESTEROV_LOOKBACK_DAYS,
                nesterov_p_breaks:   cfg.NESTEROV_P_BREAKS,
                risk_score_breaks:   cfg.RISK_SCORE_BREAKS,
                rf_enabled:          enableRf,
                rf_compute_oob:      enableRf && computeOob,
                rf_trees:            cfg.RF_TREES,
                rf_bag_fraction:     cfg.RF_BAG_FRACTION,
                train_months:        cfg.TRAIN_MONTHS,
                train_scale_m:       cfg.TRAIN_SCALE_M,
                train_samples:       cfg.TRAIN_SAMPLES_PER_CLASS,
                negative_eligible_mode: cfg.NEGATIVE_ELIGIBLE_MODE,
                input_fire_asset_id: inputFireAssetId || null,
                blend_rule: inputFireAssetId
                    ? '50% input + 30% dataset + 20% threshold (with INPUT); 60% dataset + 40% threshold (without INPUT)'
                    : '60% dataset + 40% threshold',
                export_scale_m:      cfg.EXPORT_SCALE_M,
                official_thresholds_verified: false,
            },
        }));

    try {
        // ─────────────────────────────────────────────────────────────────
        // Region tính toán = polygon tỉnh Kon Tum (RanhGioiTinh_Polygon.geojson,
        // WGS84 MultiPolygon 2 mảnh). Đọc + strip Z trong `getKonTumBoundaryGeometry()`.
        //
        // Districts = polygon huyện (`RanhGioiHuyen_Polygon.geojson` GADM v2 WGS84,
        // fallback FAO/GAUL/2015/level2 — util tự log source).
        // reduceRegions output geometry EPSG:4326 → an toàn để persist PostGIS.
        // ─────────────────────────────────────────────────────────────────
        const region = await log.run(
            'Load Kon Tum region polygon (local RanhGioiTinh_Polygon.geojson, fallback FAO/GAUL)',
            () => Promise.resolve(getKonTumRegion()),
        );
        const provinceSource = getKonTumBoundarySource();
        log.mark('Province source', `source=${provinceSource}` +
            (provinceSource === 'FAO_GAUL_2015_LEVEL1' ? ' ⚠ dùng FAO fallback, cân nhắc copy file local' : ''));

        const districts = await log.run(
            'Load Kon Tum districts collection (local geojson, fallback FAO/GAUL)',
            () => Promise.resolve(getKonTumDistricts()),
        );
        const districtsSource = getKonTumDistrictsSource();
        log.mark('Districts source', `source=${districtsSource}` +
            (districtsSource === 'FAO_GAUL_2015_LEVEL2' ? ' ⚠ dùng FAO fallback, cân nhắc copy file local' : ''));


        const provinceGeoJson  = loadLocalProvinceGeoJson();
        const provinceCentroid = computeCentroid(provinceGeoJson);
        log.mark('Province polygon loaded',
            `type=${provinceGeoJson?.type} centroid=(${provinceCentroid?.lng?.toFixed(3)}, ${provinceCentroid?.lat?.toFixed(3)})`);

        // Query ground truth từ PostGIS trong cửa sổ (analysisDate - gtWindowDays,
        // analysisDate). Merge zones (polygon) + points (buffered → polygon)
        // thành 1 FeatureCollection duy nhất truyền vào pipeline làm inline
        // input burn overlay (thay thế bước upload GEE asset thủ công).
        //
        // Wrap trong try/catch riêng: migration 032 chưa chạy → table thiếu →
        // SQL error 42P01. Fallback không GT thay vì kill toàn bộ pipeline.
        let inputFireGeoJson = null;
        // Hoisted: dùng lại ở stage AA (Update snapshot → gt_zone_count/gt_point_count).
        // Default 0/0 để cả nhánh catch (bảng GT thiếu) vẫn ghi được snapshot completed.
        let gtData = { counts: { zones: 0, points: 0 }, zones: { features: [] }, points: { features: [] } };
        try {
            const gtSvc = require('./fire-gt.service');
            gtData = await log.run(
                `Fetch ground truth (window ${gtWindowDays}d)`,
                () => gtSvc.getGtForAnalysis(analysisDate, gtWindowDays),
            );
            log.mark('Ground truth', `zones=${gtData.counts.zones} points=${gtData.counts.points}`);

            if (gtData.counts.zones + gtData.counts.points > 0) {
                inputFireGeoJson = {
                    type: 'FeatureCollection',
                    features: [
                        ...gtData.zones.features,
                        // Points giữ raw để pipeline tự buffer INPUT_BUFFER_M.
                        ...gtData.points.features,
                    ],
                };
            }
        } catch (gtErr) {
            const code = gtErr.code || gtErr.name || '';
            console.warn(`[FIRE-RISK] GT query FAILED (${code}) — fallback không GT: ${gtErr.message}`);
            log.mark('Ground truth', `SKIPPED (${code}) — chạy migration 032 để enable`);
        }

        // runFireRiskAnalysis đã được instrument sẵn — các sub-stage của
        // pipeline sẽ chèn tiếp vào cùng bộ logger A→Z.
        const analysis = await runFireRiskAnalysis(region, analysisDate, {
            enableRf,
            computeOob,
            inputFireAssetId,
            inputFireGeoJson,
            logger: log,
        });

        const {
            currentPredictors,
            riskLevel,
            blendCase,
            modelConfidenceClass,
            oobPct,
        } = analysis;
        const pNesterov    = currentPredictors.select('NesterovP').rename('NesterovP');
        const s2Observed45 = currentPredictors.select('S2_Observed45').rename('S2_Observed45');

        // 1 evaluate() heavy cho districts. Bỏ hoàn toàn reduceRegion province
        // riêng — provinceSummary được aggregate từ districtStats phía dưới
        // (tiết kiệm ~24s + đảm bảo nhất quán giữa 2 khung số).
        const districtStats = await log.run(
            'EVALUATE district stats (reduceRegions freq-histogram + mean × 5 bands)',
            () => computeDistrictStats(riskLevel, pNesterov, s2Observed45,
                blendCase, modelConfidenceClass, districts, region),
            { note: 'scale=500m tileScale=8' },
        );
        // NOTE — log per-row snapshot để chẩn đoán khi số row bất thường
        // (VD chỉ 1 row với unitCode=null → loader không load được ADM
        // properties, hoặc file huyện có 1 feature duy nhất).
        log.mark('District stats',
            `rows=${districtStats.length} ` +
            `codes=[${districtStats.map((d) => d.unitCode ?? 'null').join(',')}]`);
        if (districtStats.length <= 1 || districtStats.every((d) => d.unitCode == null)) {
            console.warn(
                `[FIRE-RISK] ⚠ districtStats bất thường — rows=${districtStats.length}, ` +
                `codes null=${districtStats.filter((d) => d.unitCode == null).length}. ` +
                `Kiểm tra file huyện ${KON_TUM_PROVINCE_PATH.replace('RanhGioiTinh', 'RanhGioiHuyen')}. ` +
                `Sample row 0: ${JSON.stringify(districtStats[0] || null).slice(0, 300)}`,
            );
        }

        const provinceSummary = aggregateProvinceFromDistricts(districtStats);
        log.mark('Province summary (aggregated)',
            `maxLevel=${provinceSummary.maxLevel} avgLvl=${provinceSummary.avgRiskLevel} pMean=${provinceSummary.pNesterovProvMean} s2Cov=${provinceSummary.s2CoverageRatio}`);

        const pNesterovStats = await log.run(
            'EVALUATE P Nesterov percentile stats (province-level)',
            () => computePNesterovStats(pNesterov, region),
            { note: 'scale=500m tileScale=4 maxPixels=1e10' },
        );
        log.mark('P Nesterov',
            `mean=${pNesterovStats.mean} p90=${pNesterovStats.p90} max=${pNesterovStats.max}`);

        // GEE tile URL cho RiskLevel — client render trực tiếp từ Earth Engine.
        // Không phụ thuộc GCS/GeoServer. Nếu getMapId lỗi, log nhưng KHÔNG fail
        // snapshot: stats DB đã có, tile chỉ là kênh hiển thị.
        let geeMapId = null;
        let geeTileUrl = null;
        try {
            // Mask level=0 (không đủ data / ngoài rừng) trước khi getMapId để
            // tile PNG có alpha=0 tại pixel không dữ liệu → không đè trắng
            // lên basemap khi client render overlay.
            const riskLevelForViz = riskLevel.updateMask(riskLevel.gt(0));
            const mapInfo = await log.run(
                'Register GEE map (riskLevel viz → geeTileUrl)',
                () => getEeMapId(riskLevelForViz, RISK_LEVEL_VIZ),
                { note: 'ee.data.getMapId — tile URL for /latest response' },
            );
            geeMapId   = mapInfo.mapId  || null;
            geeTileUrl = mapInfo.tileUrl || null;
        } catch (err) {
            console.warn(`[FIRE-RISK] getEeMapId failed (non-fatal): ${err.message}`);
        }

        // Download URL clip theo ranh giới tỉnh Kon Tum (RanhGioiTinh_Polygon).
        // GEE `image.getDownloadURL` trả 1 GeoTIFF nén .zip, valid ~24h.
        // Region = province polygon (WGS84 2D). Scale 500m matches raster gốc.
        // Non-fatal: nếu lỗi (image quá lớn hoặc GEE timeout), snapshot vẫn
        // completed, chỉ thiếu link download — user có thể refresh sau.
        //
        // Dùng callback API vì `image.getDownloadURL()` trong Node SDK là
        // async callback, không phải Promise.
        // Ảnh trước đây `.toInt8()` (band đơn 0-5) → download về xem là ĐEN TRẮNG
        // vì không có palette metadata trong GeoTIFF. Chuyển sang `.visualize()` với
        // cùng palette dùng cho tile → GeoTIFF 3 band RGB uint8, mở ra là ảnh MÀU.
        let geeDownloadUrl      = null;
        let geeDownloadFilename = null;
        try {
            const fileBase = `fire_risk_kontum_${analysisDate.replace(/-/g, '')}`;
            geeDownloadUrl = await log.run(
                'Generate GEE download URL (riskLevel visualize → GeoTIFF RGB, filePerBand=false)',
                () => new Promise((resolve) => {
                    const timer = setTimeout(() => resolve(null), 30_000);
                    // Mask pixel level=0 giống flow tile — output TIFF sẽ có
                    // nodata tại các pixel không dữ liệu (GEE lưu ở alpha band
                    // hoặc metadata). GeoServer coverage sẽ render trong suốt
                    // cho các pixel này, không còn ô trắng phủ basemap.
                    riskLevel
                        .updateMask(riskLevel.gt(0))
                        .visualize(RISK_LEVEL_VIZ)
                        .clip(region.geometry())
                        .getDownloadURL(
                            {
                                name:        fileBase,
                                scale:       cfg.EXPORT_SCALE_M || 500,
                                region:      region.geometry(),
                                crs:         'EPSG:4326',
                                format:      'GEO_TIFF',
                                // KHÔNG chia band ra 3 file — trả 1 GeoTIFF
                                // 3-band RGB duy nhất (user chỉ cần unzip
                                // 1 lần thấy 1 ảnh màu đủ, không phải 3 file).
                                filePerBand: false,
                                maxPixels:   1e9,
                            },
                            (url, err) => {
                                clearTimeout(timer);
                                if (err) {
                                    console.warn(`[FIRE-RISK] getDownloadURL err: ${err.message || err}`);
                                }
                                resolve(err ? null : url);
                            },
                        );
                }),
                { note: 'filePerBand=false → 1 file GeoTIFF RGB (không phải 3 file per band)' },
            );
            if (geeDownloadUrl) geeDownloadFilename = `${fileBase}.zip`;
        } catch (err) {
            console.warn(`[FIRE-RISK] getDownloadURL failed (non-fatal): ${err.message}`);
        }

        snapshot = await log.run('Update snapshot → status=completed', () =>
            repo.updateStatus(snapshot.id, 'completed', {
                province_summary:  provinceSummary,
                district_stats:    districtStats,
                p_nesterov_stats:  pNesterovStats,
                s2_coverage_ratio: provinceSummary.s2CoverageRatio,
                computed_at:       new Date(),
                gee_map_id:        geeMapId,
                gee_tile_url:      geeTileUrl,
                gee_tile_generated_at: geeTileUrl ? new Date() : null,
                gee_download_url:  geeDownloadUrl,
                gt_zone_count:     gtData.counts.zones,
                gt_point_count:    gtData.counts.points,
                gt_window_days:    gtWindowDays,
                oob_accuracy:      oobPct != null ? Number(oobPct.toFixed(2)) : null,
            }));

        const featureRows = buildFeaturesFromDistrictStats(snapshot.id, districtStats);
        await log.run(`Persist ${featureRows.length} district-level feature rows`,
            () => repo.replaceFeatures(snapshot.id, featureRows));

        if (submitExport) {
            const taskName = await log.run(
                'Submit GEE raster export task (async → GCS)',
                () => submitGeeExportTask(riskLevel, analysisDate),
            );
            // submitGeeExportTask returns null when GCS is not configured — in that
            // case keep status='completed' (all stats persisted) and skip export.
            if (taskName) {
                snapshot = await repo.updateStatus(snapshot.id, 'exporting', {
                    gee_task_id: taskName,
                });
            } else {
                log.mark('Raster export skipped', 'GEE_GCS_BUCKET chưa cấu hình');
            }
        }

        log.summary();

        // ── Auto ingest → MinIO → GeoServer (persistent COG) ──────────────
        // Không cần admin bấm nút thủ công — cron chạy xong sẽ tự enqueue
        // raster-ingest job. Job worker (poll 15s) tự pick up. Snapshot
        // được back-link `geoserver_layer` khi ingest complete (queue service).
        // KHÔNG throw nếu enqueue fail — không được chặn pipeline chính.
        _safe(() => _autoIngestSnapshot(snapshot, geeDownloadUrl, analysisDate));

        // ── Notification khi phân tích thành công ─────────────────────────
        // Gửi broadcast tới role admin + sở NN&MT + UBND tỉnh.
        _safe(() => _notifyFireRiskCompleted(snapshot, provinceSummary));

        return snapshot;
    } catch (err) {
        log.summary();
        console.error(`[FIRE-RISK] runAnalysis ${analysisDate} failed:`, err.message);
        await repo.updateStatus(snapshot.id, 'failed', {
            error_message: err.message,
        });
        _safe(() => _notifyFireRiskFailed(analysisDate, err.message));
        throw err;
    }
}

// ── Notification / auto-ingest helpers ──────────────────────────────────────
const _safe = (fn) => { try { const r = fn(); if (r?.catch) r.catch((e) => console.warn('[FIRE-RISK] async helper err:', e.message)); } catch (e) { console.warn('[FIRE-RISK] sync helper err:', e.message); } };

async function _autoIngestSnapshot(snapshot, geeDownloadUrl, analysisDate) {
    if (!geeDownloadUrl) {
        console.log('[FIRE-RISK] auto-ingest SKIP — no gee_download_url');
        return;
    }
    if (snapshot.geoserver_layer) {
        console.log(`[FIRE-RISK] auto-ingest SKIP — snapshot=${snapshot.id} already has geoserver_layer=${snapshot.geoserver_layer}`);
        return;
    }
    const ingestSvc = require('./raster-ingest.service');
    const dateTag = String(analysisDate).slice(0, 10).replace(/-/g, '');
    const layerCode = `fire_risk_${dateTag}`;
    console.log(`[FIRE-RISK] auto-ingest enqueue snapshot=${snapshot.id} layer=${layerCode}`);
    const { job, deduplicated } = await ingestSvc.enqueue({
        sourceUrl:  geeDownloadUrl,
        layerCode,
        nameVi:     `Cảnh báo cháy rừng ${analysisDate}`,
        isPublic:   true,
        category:   'fire_risk',
        requestParams: {
            linkedResource: { type: 'fire_risk', id: snapshot.id },
            analysis_date:  analysisDate,
            scale_m:        cfg.EXPORT_SCALE_M || 500,
            autoIngested:   true,   // trace: enqueue tự động vs admin bấm
        },
        user: null,  // system-triggered
        lang: 'vi',
    });
    console.log(`[FIRE-RISK] auto-ingest ${deduplicated ? 'DEDUPE' : 'ENQUEUED'} → job=${job.id} status=${job.status}`);
}

async function _notifyFireRiskCompleted(snapshot, provinceSummary) {
    const notifSvc = require('./notification.service');
    const dateStr  = (snapshot.analysis_date instanceof Date
        ? snapshot.analysis_date.toISOString().slice(0, 10)
        : String(snapshot.analysis_date).slice(0, 10));
    const dist    = provinceSummary?.riskLevelDist || {};

    // Min/max/avg từ province summary (đã tính trong pipeline).
    let minLvl = null, maxLvl = null;
    for (let l = 1; l <= 5; l++) {
        if ((Number(dist[l]) || 0) > 0) { if (minLvl == null) minLvl = l; maxLvl = l; }
    }
    const avg = provinceSummary?.avgRiskLevel;

    // Highest-priority level dictates notification severity.
    const isHigh = (maxLvl || 0) >= 4;
    const type   = isHigh ? 'fire_risk_high' : 'fire_risk_completed';
    const title  = isHigh
        ? `⚠ Cảnh báo cháy rừng cao ngày ${dateStr}`
        : `Cảnh báo cháy rừng ${dateStr} hoàn thành`;
    const body   = `Cấp: ${minLvl ?? '—'}–${maxLvl ?? '—'} (TB ${avg?.toFixed?.(2) ?? '—'}). `
                 + `Xem chi tiết trong "Cảnh báo cháy rừng".`;
    const data   = {
        snapshotId: snapshot.id, analysisDate: dateStr,
        avgLevel: avg, minLevel: minLvl, maxLevel: maxLvl,
    };

    // Gửi tới các role liên quan. Bỏ role phân quyền check ở đây — RBAC
    // audience decoupled với việc tạo notification.
    for (const role of ['system_admin', 'so_nnmt', 'ubnd_tinh']) {
        await notifSvc.broadcastToRole(role, {
            type, title, body, data,
            channel: isHigh ? 'alert' : 'system',
        }).catch((e) => console.warn(`[FIRE-RISK] notify role=${role} failed:`, e.message));
    }
}

async function _notifyFireRiskFailed(analysisDate, errMsg) {
    const notifSvc = require('./notification.service');
    const dateStr  = String(analysisDate).slice(0, 10);
    await notifSvc.broadcastToRole('system_admin', {
        type:    'fire_risk_failed',
        title:   `Phân tích cháy rừng ${dateStr} thất bại`,
        body:    errMsg?.slice(0, 200) || 'Không rõ lỗi',
        data:    { analysisDate: dateStr, error: errMsg },
        channel: 'system',
    }).catch(() => {});
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
    const rows = await repo.getFeatures(snapshot.id, { minLevel: minRiskLevel });
    const features = rows.map(toPublicFeatureRow);
    return {
        snapshot,
        features,
        stale:        false,
        computing:    false,
    };
};

/**
 * Get GeoJSON FeatureCollection of fire risk features for the map.
 */
const getMap = async ({ minRiskLevel = 4 } = {}) => {
    const snapshot = await repo.getLatestCompleted();
    if (!snapshot) {
        return {
            type: 'FeatureCollection',
            features: [],
        };
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
            s2Coverage: r.properties?.s2Coverage ?? null,
            centroid: r.properties?.centroid ?? null,
        },
    }));
    return {
        type: 'FeatureCollection',
        features,
    };
};

const toPublicFeatureRow = (row) => ({
    id: row.id,
    risk_level: row.risk_level,
    district_code: row.district_code,
    district_name: row.district_name,
    area_ha: row.area_ha,
    properties: {
        s2Coverage: row.properties?.s2Coverage ?? null,
        centroid: row.properties?.centroid ?? null,
    },
    geometry: row.geometry,
});

/**
 * List completed snapshots (history).
 */
const getHistory = async ({ page = 1, limit = 30, hasGeoserverLayer } = {}) =>
    repo.listCompleted({ page, limit, hasGeoserverLayer });

/**
 * Trigger manual analysis for today (admin only).
 * Accepts optional v8.1 overrides: enableRf, inputFireAssetId.
 */
const refresh = async ({ analysisDate, submitExport, enableRf, inputFireAssetId, computeOob } = {}) => {
    const date = analysisDate || todayUtc();
    return runAnalysis(date, {
        ...(submitExport     !== undefined ? { submitExport }     : {}),
        ...(enableRf         !== undefined ? { enableRf }         : {}),
        ...(inputFireAssetId !== undefined ? { inputFireAssetId } : {}),
        ...(computeOob       !== undefined ? { computeOob }       : {}),
    });
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
