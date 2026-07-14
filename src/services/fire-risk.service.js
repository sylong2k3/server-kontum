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
    getEeMapId,
    todayUtc,
    fmtDate,
} = require('../utils/gee-satellite.util');

// Palette + range của RiskLevel 0-5 — trùng với §22 trong docs/kontum_fire_warning_final.js.
// riskPaletteExtended: 0=trắng (không đủ dữ liệu), 1-5 theo cấp cháy chính thức.
const RISK_LEVEL_VIZ = {
    bands:   ['RiskLevel'],
    min:     0,
    max:     5,
    palette: ['ffffff', '00a65a', 'f6e84a', 'f39c12', 'e74c3c', '7b241c'],
};

// Đường dẫn polygon tỉnh Kon Tum (RanhGioiTinh_Polygon.geojson) — dùng cho
// stats scope tỉnh cùng client render outline. Có thể override qua env
// `KON_TUM_BOUNDARY_GEOJSON` (chia sẻ với gee-satellite.util).
const KON_TUM_PROVINCE_PATH = process.env.KON_TUM_BOUNDARY_GEOJSON
    || path.resolve(__dirname, '../../data/RanhGioiTinh_Polygon.geojson');
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
        let totalForestHa = 0;
        // Level 0 = no observation; include for coverage totals but exclude from risk.
        for (let l = 0; l <= 5; l++) {
            const ha = (hist[String(l)] || 0) * pixelHa;
            levelDist[l] = Math.round(ha * 100) / 100;
            if (l >= 1) totalForestHa += ha;
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
async function computeProvinceSummary(riskLevel, pNesterov, s2Observed45, blendCase, modelConfidenceClass, dataSourceClass, region) {
    const SCALE = 500;
    const pixelHa = (SCALE / 1000) ** 2 * 100;

    const reduced = riskLevel
        .addBands(pNesterov.rename('pNesterov'))
        .addBands(s2Observed45.rename('s2Obs'))
        .addBands(blendCase.rename('blendCase'))
        .addBands(modelConfidenceClass.rename('confidenceClass'))
        .addBands(dataSourceClass.rename('dataSource'))
        .reduceRegion({
            reducer:   ee.Reducer.frequencyHistogram()
                .combine(ee.Reducer.mean(), null, true),
            geometry:  region.geometry(),
            scale:     SCALE,
            tileScale: 8,
            maxPixels: 1e10,
        });

    const result = await eeEvaluate(reduced);
    const hist       = result.riskLevel_histogram || {};
    const blendHist  = result.blendCase_histogram || {};
    const confHist   = result.confidenceClass_histogram || {};
    const dsHist     = result.dataSource_histogram || {};
    // Chỉ giữ phân bố diện tích theo cấp (ha). Bỏ totalForestHa + avgRiskLevel
    // theo yêu cầu — client không cần khái niệm "rừng tổng" (dễ nhầm với diện
    // tích rừng thực). Diện tích ở đây là số pixel × 25 ha ở scale 500 m,
    // KHÔNG phải sinh khối rừng.
    const levelDist = {};
    let maxLevelWithArea = 0;
    let totalWithArea    = 0;
    for (let l = 0; l <= 5; l++) {
        const ha = (hist[String(l)] || 0) * pixelHa;
        levelDist[l] = Math.round(ha * 100) / 100;
        if (l >= 1 && ha > 0) {
            if (l > maxLevelWithArea) maxLevelWithArea = l;
            totalWithArea += ha;
        }
    }

    return {
        // Cấp cảnh báo cao nhất có diện tích > 0 trong toàn tỉnh — để client
        // đọc badge nhanh mà không phải scan lại riskLevelDist.
        maxLevel:         maxLevelWithArea,
        riskLevelDist:    levelDist,
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
        dataSourceHa: {
            noData:         Math.round((dsHist['0'] || 0) * pixelHa * 100) / 100,
            fallbackOnly:   Math.round((dsHist['1'] || 0) * pixelHa * 100) / 100,
            observed45Days: Math.round((dsHist['2'] || 0) * pixelHa * 100) / 100,
        },
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

// ── Province-level vector features ────────────────────────────────────────────

/**
 * Build fire_risk_features rows từ province summary + polygon tỉnh.
 *
 * Bỏ hoàn toàn phân tích theo huyện (RanhGioiHuyen) — cấp cảnh báo giờ tính
 * cho TOÀN TỈNH. Mỗi cấp có diện tích > 0 sẽ tạo 1 feature với chung 1
 * polygon tỉnh (RanhGioiTinh_Polygon.geojson). Client filter theo cấp và vẫn
 * có polygon để render trên bản đồ.
 *
 * @param {string} snapshotId
 * @param {object} provinceSummary  — có riskLevelDist { 0..5 → ha }
 * @param {object} provinceGeometry — GeoJSON Polygon/MultiPolygon EPSG:4326 của tỉnh
 * @param {object} provinceCentroid — { lng, lat } tính từ bbox tỉnh
 * @param {object} pNesterovStats   — có mean (đưa vào từng feature)
 * @param {number} s2CoverageRatio  — 0..1
 */
function buildFeaturesFromProvinceSummary(snapshotId, provinceSummary, provinceGeometry, provinceCentroid, pNesterovStats, s2CoverageRatio) {
    const rows = [];
    // ST_GeomFromGeoJSON chỉ đọc `type` + `coordinates`, không cần strip
    // `_properties` — nhưng để an toàn cho các ORM khác, chỉ stringify 2 field.
    const geoJsonText = provinceGeometry
        ? JSON.stringify({ type: provinceGeometry.type, coordinates: provinceGeometry.coordinates })
        : null;
    const centroid    = provinceCentroid || null;
    const pMean       = Number.isFinite(pNesterovStats?.mean) ? pNesterovStats.mean : null;
    const s2Cov       = Number.isFinite(s2CoverageRatio) ? s2CoverageRatio : null;
    const dist        = provinceSummary?.riskLevelDist || {};
    // Properties gốc file: Ten_tinh, Ma_DVHC, Dien_tich, Dan_so, …
    const provProps   = provinceGeometry?._properties || {};
    // Tên tỉnh ưu tiên từ file (có dấu tiếng Việt), fallback 'Kon Tum'.
    const districtName = provProps.Ten_tinh || 'Kon Tum';
    for (let l = 1; l <= 5; l++) {
        const areaHa = dist[l] || 0;
        if (areaHa <= 0) continue;
        rows.push({
            risk_level:      l,
            district_code:   provProps.Ma_DVHC ? String(provProps.Ma_DVHC) : null,
            district_name:   districtName,
            area_ha:         areaHa,
            p_nesterov_mean: pMean,
            ndvi_mean:       null,
            properties: {
                s2Coverage:  s2Cov,
                centroid,
                scope:       'province',                    // để client phân biệt với record huyện cũ
                provinceAreaHa: provProps.Dien_tich || null, // diện tích thực từ file (nếu có)
                provinceCode:   provProps.Ma_DVHC || null,
                provinceName:   districtName,
            },
            geojson: geoJsonText,
        });
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
        // Region chuẩn cho toàn bộ fire-risk = polygon tỉnh Kon Tum lấy từ
        // file local `server/data/RanhGioiTinh_Polygon.geojson` (CRS: WGS84/
        // CRS84, MultiPolygon 2 mảnh). File này được đọc & strip Z (0) ở
        // `getKonTumBoundaryGeometry()` trong utils/gee-satellite.util.js.
        //
        // Toàn bộ chain fire-risk tính TRÊN CHÍNH polygon này:
        //   - runFireRiskAnalysis(region, ...)      → clip mọi ee.Image
        //   - reduceRegion(geometry: region.geometry(), ...) → stats scope tỉnh
        //   - Feature GeoJSON polygon trả client   → outline trên map
        //   - Centroid từ bbox polygon             → fly-to
        // Không dùng FAO/GAUL, không tính theo huyện.
        // ─────────────────────────────────────────────────────────────────
        const region = await log.run(
            'Load Kon Tum region polygon (RanhGioiTinh_Polygon.geojson, WGS84 MultiPolygon)',
            () => Promise.resolve(getKonTumRegion()),
        );

        const provinceGeoJson = loadLocalProvinceGeoJson();
        const provinceCentroid = computeCentroid(provinceGeoJson);
        log.mark('Province polygon loaded',
            `type=${provinceGeoJson?.type} centroid=(${provinceCentroid?.lng?.toFixed(3)}, ${provinceCentroid?.lat?.toFixed(3)})`);

        // runFireRiskAnalysis đã được instrument sẵn — các sub-stage của
        // pipeline sẽ chèn tiếp vào cùng bộ logger A→Z.
        const analysis = await runFireRiskAnalysis(region, analysisDate, {
            enableRf,
            inputFireAssetId,
            logger: log,
        });

        const {
            currentPredictors,
            riskLevel,
            blendCase,
            modelConfidenceClass,
            dataSourceClass,
        } = analysis;
        const pNesterov    = currentPredictors.select('NesterovP').rename('NesterovP');
        const s2Observed45 = currentPredictors.select('S2_Observed45').rename('S2_Observed45');

        // 2 evaluate() heavy — tách tuần tự thay vì Promise.all. Đã bỏ
        // computeDistrictStats theo yêu cầu: chỉ tính stats trên polygon tỉnh
        // (RanhGioiTinh_Polygon), không phân theo huyện nữa.
        const provinceSummary = await log.run(
            'EVALUATE province summary (reduceRegion freq-histogram × 5 bands)',
            () => computeProvinceSummary(riskLevel, pNesterov, s2Observed45,
                blendCase, modelConfidenceClass, dataSourceClass, region),
            { note: 'scale=500m tileScale=8 maxPixels=1e10' },
        );
        log.mark('Province summary',
            `maxLevel=${provinceSummary.maxLevel} pMean=${provinceSummary.pNesterovProvMean} s2Cov=${provinceSummary.s2CoverageRatio}`);

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
            const mapInfo = await log.run(
                'Register GEE map (riskLevel viz → geeTileUrl)',
                () => getEeMapId(riskLevel, RISK_LEVEL_VIZ),
                { note: 'ee.data.getMapId — tile URL for /latest response' },
            );
            geeMapId   = mapInfo.mapId  || null;
            geeTileUrl = mapInfo.tileUrl || null;
        } catch (err) {
            console.warn(`[FIRE-RISK] getEeMapId failed (non-fatal): ${err.message}`);
        }

        snapshot = await log.run('Update snapshot → status=completed', () =>
            repo.updateStatus(snapshot.id, 'completed', {
                province_summary:  provinceSummary,
                district_stats:    null,   // gỡ theo yêu cầu — không tính theo huyện nữa
                p_nesterov_stats:  pNesterovStats,
                s2_coverage_ratio: provinceSummary.s2CoverageRatio,
                computed_at:       new Date(),
                gee_map_id:        geeMapId,
                gee_tile_url:      geeTileUrl,
                gee_tile_generated_at: geeTileUrl ? new Date() : null,
            }));

        const featureRows = buildFeaturesFromProvinceSummary(
            snapshot.id, provinceSummary, provinceGeoJson, provinceCentroid,
            pNesterovStats, provinceSummary.s2CoverageRatio,
        );
        await log.run(`Persist ${featureRows.length} province-level feature rows`,
            () => repo.replaceFeatures(snapshot.id, featureRows));

        if (submitExport) {
            const taskName = await log.run(
                'Submit GEE raster export task (async → GCS)',
                () => submitGeeExportTask(riskLevel, analysisDate),
            );
            snapshot = await repo.updateStatus(snapshot.id, 'exporting', {
                gee_task_id: taskName,
            });
        }

        log.summary();
        return snapshot;
    } catch (err) {
        log.summary();
        console.error(`[FIRE-RISK] runAnalysis ${analysisDate} failed:`, err.message);
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
    return {
        snapshot,
        features,
        // Client render tile GEE trực tiếp — được publish khi runAnalysis chạy.
        geeTileUrl:   snapshot.gee_tile_url || null,
        geeMapId:     snapshot.gee_map_id || null,
        riskLevelViz: RISK_LEVEL_VIZ,
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
            snapshotDate: null,
            geeTileUrl: null,
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
            pNesterovMean: r.p_nesterov_mean,
            ndviMean:      r.ndvi_mean,
            ...r.properties,
        },
    }));
    return {
        type:           'FeatureCollection',
        features,
        snapshotDate:   snapshot.analysis_date,
        geoserverLayer: snapshot.geoserver_layer || null,
        geeTileUrl:     snapshot.gee_tile_url || null,
        geeMapId:       snapshot.gee_map_id || null,
        riskLevelViz:   RISK_LEVEL_VIZ,
    };
};

/**
 * List completed snapshots (history).
 */
const getHistory = async ({ page = 1, limit = 30 } = {}) =>
    repo.listCompleted({ page, limit });

/**
 * Trigger manual analysis for today (admin only).
 * Accepts optional v8.1 overrides: enableRf, inputFireAssetId.
 */
const refresh = async ({ analysisDate, submitExport, enableRf, inputFireAssetId } = {}) => {
    const date = analysisDate || todayUtc();
    return runAnalysis(date, {
        submitExport,
        ...(enableRf !== undefined         ? { enableRf }         : {}),
        ...(inputFireAssetId !== undefined ? { inputFireAssetId } : {}),
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
