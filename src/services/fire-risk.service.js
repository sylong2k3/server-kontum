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

    let snapshot = await log.run('Create snapshot (new attempt) → status=computing', () =>
        repo.createSnapshot({
            analysis_date: analysisDate,
            status: 'computing',
            export_scale_m: cfg.EXPORT_SCALE_M,
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
            rfSkipReason,
            trainingCounts,
            modelMeta,
        } = analysis;
        const pNesterov    = currentPredictors.select('NesterovP').rename('NesterovP');
        // Band renamed 'S2_Observed45' → 'S2_ObservedWindow' để trung tính về
        // độ dài cửa sổ (FEATURE_WINDOW_DAYS mặc định 30, không phải 45).
        // Alias `s2Observed45` giữ tên biến JS cũ chỉ để giảm diff downstream.
        const s2Observed45 = currentPredictors.select('S2_ObservedWindow').rename('S2_ObservedWindow');

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

        // Download URL — chia PER HUYỆN thay vì 1 URL toàn tỉnh (migration 040).
        // Lý do: EXPORT_SCALE_M mới = 100m → toàn tỉnh 9.677 km² × 3 band RGB
        // ≈ 30M pixel → GeoTIFF ~120MB, vượt maxPixels 1e9 và dễ timeout GEE.
        // Chia theo huyện: mỗi huyện ~50-1500 km² → ~5M pixel/huyện, an toàn.
        // Diện tích toàn tỉnh = Σ area huyện (aggregate ở dashboard/query).
        //
        // Persist state per huyện vào fire.fire_risk_district_exports — mỗi
        // row có riêng gee_download_url + area_stats. Nếu 1 huyện fail, các
        // huyện khác vẫn completed, snapshot vẫn có thể publish.
        let geeDownloadUrl      = null;      // Giữ NULL — không còn URL toàn tỉnh
        let geeDownloadFilename = null;
        const districtExportRows = [];
        try {
            const dateTag = analysisDate.replace(/-/g, '');
            // Reuse geometry từ districtStats đã có (đã evaluate xong, chứa
            // ADM2_CODE/ADM2_NAME + geometry). Không cần evaluate() lại.
            const skeletons = districtStats.map((d) => ({
                district_code: d.unitCode ? String(d.unitCode) : null,
                district_name: d.name || null,
                geometry:      d.geometry || null,
            }));

            // Chèn skeleton rows status=pending vào bảng district_exports.
            const seeded = await log.run(
                `Seed ${skeletons.length} district_exports (status=pending)`,
                () => repo.insertDistrictExports(snapshot.id, skeletons, cfg.EXPORT_SCALE_M),
            );

            // Map district_code → row id để update patch sau.
            const rowByCode = new Map();
            for (const r of seeded) rowByCode.set(r.district_code, r);

            let completed = 0, failed = 0, skipped = 0;
            for (const d of districtStats) {
                const code = d.unitCode ? String(d.unitCode) : null;
                const row  = rowByCode.get(code);
                if (!row) continue;
                const t0 = Date.now();
                await repo.updateDistrictExport(row.id, {
                    status: 'computing', started_at: new Date(),
                });

                // Tính tổng area level 1-5 của huyện (dùng để aggregate lên tỉnh).
                const levelDist  = d.riskLevelDist || {};
                let districtHa = 0;
                for (let l = 1; l <= 5; l++) districtHa += Number(levelDist[l]) || 0;

                if (districtHa === 0 || !d.geometry) {
                    await repo.updateDistrictExport(row.id, {
                        status:        'skipped',
                        area_stats:    d,
                        total_area_ha: 0,
                        duration_ms:   Date.now() - t0,
                        completed_at:  new Date(),
                        error_message: !d.geometry ? 'district geometry missing' : 'no pixels ≥ level 1',
                    });
                    skipped += 1;
                    continue;
                }

                const fileBase = `fire_risk_${code || 'unknown'}_${dateTag}`;
                try {
                    const districtGeom = ee.Geometry(d.geometry);
                    // Timeout 2 phút/huyện — fire-risk graph nhẹ hơn forest classify
                    // (không có RF 13-class training), 60s vẫn có thể đủ nhưng
                    // GEE trong Restricted Mode hay bị 429/slow → nới lên để
                    // tránh timeout khi quota bị siết. Env FIRE_RISK_DOWNLOAD_TIMEOUT_MS
                    // override nếu cần.
                    const DL_TIMEOUT_MS = Number(process.env.FIRE_RISK_DOWNLOAD_TIMEOUT_MS) || 120_000;
                    const url = await new Promise((resolve, reject) => {
                        const timer = setTimeout(
                            () => reject(new Error(`getDownloadURL timeout huyện=${code} sau ${DL_TIMEOUT_MS}ms`)),
                            DL_TIMEOUT_MS,
                        );
                        riskLevel
                            .updateMask(riskLevel.gt(0))
                            .visualize(RISK_LEVEL_VIZ)
                            .clip(districtGeom)
                            .getDownloadURL(
                                {
                                    name:        fileBase,
                                    scale:       cfg.EXPORT_SCALE_M || 100,
                                    region:      districtGeom,
                                    crs:         'EPSG:4326',
                                    format:      'GEO_TIFF',
                                    filePerBand: false,
                                    maxPixels:   1e9,
                                },
                                (u, err) => {
                                    clearTimeout(timer);
                                    if (err) reject(new Error(String(err.message || err)));
                                    else resolve(u);
                                },
                            );
                    });
                    await repo.updateDistrictExport(row.id, {
                        status:                'completed',
                        area_stats:            d,
                        total_area_ha:         Math.round(districtHa * 100) / 100,
                        gee_download_url:      url,
                        gee_download_filename: `${fileBase}.zip`,
                        gee_generated_at:      new Date(),
                        duration_ms:           Date.now() - t0,
                        completed_at:          new Date(),
                    });
                    districtExportRows.push({ code, name: d.name, url, districtHa });
                    completed += 1;
                } catch (dErr) {
                    console.warn(`[FIRE-RISK] district=${code} download fail: ${dErr.message}`);
                    await repo.updateDistrictExport(row.id, {
                        status:        'failed',
                        area_stats:    d,
                        total_area_ha: Math.round(districtHa * 100) / 100,
                        error_message: dErr.message,
                        duration_ms:   Date.now() - t0,
                        completed_at:  new Date(),
                    });
                    failed += 1;
                }
            }
            log.mark('District downloads',
                `completed=${completed} failed=${failed} skipped=${skipped} of ${skeletons.length}`);
        } catch (err) {
            console.warn(`[FIRE-RISK] district-chunked download setup failed (non-fatal): ${err.message}`);
        }

        // Nhét model_meta vào JSONB `province_summary` (piggyback) để không
        // cần thêm migration. Consumer đọc `provinceSummary._modelMeta`.
        const provinceSummaryWithMeta = {
            ...provinceSummary,
            _modelMeta: {
                ...modelMeta,
                rfSkipReason:   rfSkipReason || null,
                trainingCounts: trainingCounts || null,
            },
        };

        // Aggregate district_exports → 1 object summary lưu ở snapshot cho FE.
        const districtExportSummary = {
            scaleM:  cfg.EXPORT_SCALE_M,
            total:   districtExportRows.length,
            byLevel: provinceSummary.riskLevelDist,
            totalHa: Object.values(provinceSummary.riskLevelDist || {})
                .reduce((s, v) => s + (Number(v) || 0), 0),
        };

        snapshot = await log.run('Update snapshot → status=completed', () =>
            repo.updateStatus(snapshot.id, 'completed', {
                province_summary:  provinceSummaryWithMeta,
                district_stats:    districtStats,
                p_nesterov_stats:  pNesterovStats,
                s2_coverage_ratio: provinceSummary.s2CoverageRatio,
                computed_at:       new Date(),
                gee_map_id:        geeMapId,
                gee_tile_url:      geeTileUrl,
                gee_tile_generated_at: geeTileUrl ? new Date() : null,
                // gee_download_url giữ NULL — client lấy URL per huyện từ
                // fire_risk_district_exports (endpoint mới sẽ list).
                gee_download_url:  null,
                district_export_summary: districtExportSummary,
                gt_zone_count:     gtData.counts.zones,
                gt_point_count:    gtData.counts.points,
                gt_window_days:    gtWindowDays,
                oob_accuracy:      oobPct != null ? Number(oobPct.toFixed(2)) : null,
                export_scale_m:    cfg.EXPORT_SCALE_M,
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
        // Sau migration 040: mỗi huyện có 1 URL riêng thay vì 1 URL tỉnh.
        // Enqueue N ingest job (1/huyện) — thay vì 1 job như trước. Nếu job
        // nào fail vẫn không kéo theo snapshot fail.
        for (const dRow of districtExportRows) {
            _safe(() => _autoIngestDistrict(snapshot, dRow, analysisDate));
        }

        // ── Notification khi phân tích thành công ─────────────────────────
        // Gửi broadcast tới role admin + sở NN&MT + UBND tỉnh — CHỈ 1 LẦN
        // cho mỗi analysis_date. Nếu đã có attempt completed trước đó (VD
        // watchdog retry, hoặc admin refresh thủ công sau khi cron xong),
        // KHÔNG gửi noti lần 2 để tránh spam người dùng.
        _safe(async () => {
            const prior = await repo.countPriorCompletedAttempts(snapshot.id).catch(() => 0);
            if (prior > 0) {
                console.log(`[FIRE-RISK] notification SKIP — đã có ${prior} attempt completed trước (dedup theo analysis_date)`);
                return;
            }
            await _notifyFireRiskCompleted(snapshot, provinceSummary);
        });

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

async function _autoIngestDistrict(snapshot, districtRow, analysisDate) {
    if (!districtRow?.url) return;
    const ingestSvc = require('./raster-ingest.service');
    const dateTag   = String(analysisDate).slice(0, 10).replace(/-/g, '');
    const code      = districtRow.code || 'unknown';
    const layerCode = `fire_risk_${code}_${dateTag}`;
    console.log(`[FIRE-RISK] auto-ingest district=${code} enqueue snapshot=${snapshot.id} layer=${layerCode}`);
    const { job, deduplicated } = await ingestSvc.enqueue({
        sourceUrl:  districtRow.url,
        layerCode,
        nameVi:     `Cảnh báo cháy rừng ${analysisDate} — ${districtRow.name || code}`,
        isPublic:   true,
        category:   'fire_risk_district',
        requestParams: {
            linkedResource: { type: 'fire_risk_district', id: snapshot.id, districtCode: code },
            analysis_date:  analysisDate,
            scale_m:        cfg.EXPORT_SCALE_M || 100,
            autoIngested:   true,
        },
        user: null,
        lang: 'vi',
    });
    console.log(`[FIRE-RISK] auto-ingest district=${code} ${deduplicated ? 'DEDUPE' : 'ENQUEUED'} → job=${job.id} status=${job.status}`);
}

// Format `analysis_date` (DATE trong Postgres → JS Date theo local tz) về
// "YYYY-MM-DD" trong VN tz. Trước đây dùng `toISOString().slice(0,10)` — bị
// lệch 1 ngày (UTC vs VN +7) → notification title in ra "2026-07-23" cho
// analysis run ngày 2026-07-24. Cùng bug với watchdog fire-risk.job.js.
function _formatDateVN(dateLike) {
    if (dateLike == null || dateLike === '') return '';
    const d = dateLike instanceof Date ? dateLike : new Date(dateLike);
    if (!Number.isFinite(d.getTime())) return String(dateLike).slice(0, 10);
    const tz = process.env.FIRE_RISK_CRON_TZ || 'Asia/Ho_Chi_Minh';
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(d).reduce((a, p) => {
        if (p.type !== 'literal') a[p.type] = p.value;
        return a;
    }, {});
    return `${parts.year}-${parts.month}-${parts.day}`;
}

async function _notifyFireRiskCompleted(snapshot, provinceSummary) {
    const notifSvc = require('./notification.service');
    const dateStr  = _formatDateVN(snapshot.analysis_date);
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
    const dateStr  = _formatDateVN(analysisDate);
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
