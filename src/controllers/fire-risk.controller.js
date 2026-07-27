'use strict';

const svc  = require('../services/fire-risk.service');
const repo = require('../repositories/fire-risk.repository');
const ingestSvc = require('../services/raster-ingest.service');
const { OK, OK_LIST, CREATED } = require('../core/success.response');
const { Api400Error, Api404Error } = require('../core/error.response');
const { t } = require('../utils/i18n.util');

// Derive filename ổn định cho download GeoTIFF fire-risk. GEE `getDownloadURL`
// với `filePerBand:false` trên `.visualize()` trả TIFF trần (Content-Type
// image/tiff), KHÔNG phải zip — đặt `.tif` để Windows Explorer nhận đúng loại
// file (nếu đặt `.zip` như trước sẽ prompt "invalid archive" khi user double-click).
const fireRiskFilename = (analysisDate) => {
    if (!analysisDate) return null;
    const d = analysisDate instanceof Date
        ? analysisDate.toISOString().slice(0, 10)
        : String(analysisDate).slice(0, 10);
    return `fire_risk_kontum_${d.replace(/-/g, '')}.tif`;
};

// Build URL WCS GetCoverage trả GeoTIFF full-resolution từ GeoServer khi layer
// đã publish. Ưu tiên hơn geeDownloadUrl vì:
//   - Persistent (không expire 24h như GEE URL).
//   - Full-resolution (COG nguyên gốc trong data_dir, không bị downsample).
//   - Không phụ thuộc quota GEE khi user tải lại nhiều lần.
// Trả null khi chưa có layer hoặc GEOSERVER_PUBLIC_URL chưa cấu hình.
const buildGeoserverDownloadUrl = (layerFqn) => {
    if (!layerFqn) return null;
    const base = (process.env.GEOSERVER_PUBLIC_URL || '')
        .trim().replace(/\/+$/, '');
    if (!base) return null;
    const [ws, name] = String(layerFqn).includes(':')
        ? String(layerFqn).split(':')
        : [process.env.GEOSERVER_WORKSPACE || 'kontum', String(layerFqn)];
    const root = base
        .replace(new RegExp(`/${ws}/(?:wms|wcs)$`, 'i'), '')
        .replace(/\/(?:wms|wcs)$/i, '');
    // WCS 2.0 coverageId dùng `__` (double underscore) làm workspace separator.
    const coverageId = `${ws}__${name}`;
    const qs = new URLSearchParams({
        service:    'WCS',
        version:    '2.0.1',
        request:    'GetCoverage',
        coverageId,
        format:     'image/tiff',
    });
    return `${root}/${ws}/wcs?${qs.toString()}`;
};

// ── GET /fire-risk/latest ─────────────────────────────────────────────────────
const getLatest = async (req, res) => {
    const minRiskLevel = parseInt(req.query.minRiskLevel, 10) || 1;
    const { snapshot, features, stale, computing } =
        await svc.getLatest({ minRiskLevel });
    // NOTE — strip `geometry` field khỏi districtStats items để response gọn.
    // Polygon huyện đã có ở endpoint `/map` (fire_risk_features.geom), không
    // cần lặp trong `/latest`. Giữ centroid + stats.
    const districtStatsSlim = Array.isArray(snapshot.district_stats)
        ? snapshot.district_stats.map((district) => ({
            unitCode: district.unitCode ?? null,
            name: district.name ?? null,
            centroid: district.centroid ?? null,
            riskLevelDist: district.riskLevelDist || {},
            s2Coverage: district.s2Coverage ?? null,
        }))
        : [];

    OK(res, t('get_detail_success', req.lang), {
        snapshot: {
            id:                  snapshot.id,
            analysisDate:        snapshot.analysis_date,
            status:              snapshot.status,
            provinceSummary:     formatProvinceSummary(snapshot.province_summary),
            // districtStats — thống kê per-huyện (unitCode, name, riskLevelDist,
            // pNesterovMean, s2Coverage, centroid). Đã strip geometry (xem trên).
            districtStats:       districtStatsSlim,
            geoserverLayer:      snapshot.geoserver_layer || null,
            geeTileUrl:          snapshot.gee_tile_url || null,
            geeTileGeneratedAt:  snapshot.gee_tile_generated_at || null,
            geeDownloadUrl:      snapshot.gee_download_url || null,
            geoserverDownloadUrl: buildGeoserverDownloadUrl(snapshot.geoserver_layer),
            downloadFilename:    fireRiskFilename(snapshot.analysis_date),
        },
        features,
        stale,
        computing,
    });
};

// ── GET /fire-risk/map ────────────────────────────────────────────────────────
const getMap = async (req, res) => {
    const minRiskLevel = parseInt(req.query.minRiskLevel, 10) || 4;
    const geojson = await svc.getMap({ minRiskLevel });
    // Return raw GeoJSON (not wrapped) so Leaflet/MapboxGL can consume directly.
    res.json(geojson);
};

// ── GET /fire-risk/history ────────────────────────────────────────────────────
// Filter options:
//   ?hasGeoserverLayer=true  → chỉ snapshot đã publish GeoServer (client browse
//                              để add overlay so sánh; GEE-only URL expire 24h
//                              nên không muốn add).
//   ?hasGeoserverLayer=false → chỉ snapshot chưa publish (admin xem để chọn
//                              trigger publish thủ công).
//   không truyền           → trả tất cả (backward-compat).
const getHistory = async (req, res) => {
    const page  = parseInt(req.query.page,  10) || 1;
    const limit = parseInt(req.query.limit, 10) || 30;
    // Chuẩn hoá `hasGeoserverLayer` — chỉ nhận literal string 'true'/'false',
    // các giá trị khác treat as undefined (không filter).
    let hasGeoserverLayer;
    if (req.query.hasGeoserverLayer === 'true')  hasGeoserverLayer = true;
    if (req.query.hasGeoserverLayer === 'false') hasGeoserverLayer = false;
    const { items, total } = await svc.getHistory({ page, limit, hasGeoserverLayer });
    const responseItems = items.map((item) => ({
        ...item,
        province_summary: formatProvinceSummary(item.province_summary),
    }));
    OK_LIST(res, t('get_list_success', req.lang), responseItems, {
        page, limit, total,
        ...(hasGeoserverLayer !== undefined ? { hasGeoserverLayer } : {}),
    });
};

// Snapshot đang `computing` chưa có province_summary → NULL trong DB → phá vỡ
// default param `= {}`. Bảo vệ tường minh bằng `?? {}`.
const formatProvinceSummary = (summary) => {
    const s = summary || {};
    return {
        maxLevel:        s.maxLevel ?? null,
        avgRiskLevel:    s.avgRiskLevel ?? null,
        riskLevelDist:   s.riskLevelDist || {},
        s2CoverageRatio: s.s2CoverageRatio ?? null,
    };
};

// ── GET /fire-risk/published-history ─────────────────────────────────────────
// Public sub-endpoint (optionalAuth) — chỉ trả snapshot ĐÃ publish GeoServer,
// dùng cho client browse để add WMS overlay lên bản đồ. Force filter
// hasGeoserverLayer=true bất kể query param. Trả subset field an toàn cho
// public (bỏ error_message, minio_key, gee_download_url, model_params,
// gee_task_id...) — layer name đã public qua WMS URL nên OK.
const getPublishedHistory = async (req, res) => {
    const page  = parseInt(req.query.page,  10) || 1;
    const limit = parseInt(req.query.limit, 10) || 30;
    const { items, total } = await svc.getHistory({
        page, limit, hasGeoserverLayer: true,
    });
    // Whitelist field an toàn cho public — chỉ đủ để client render WMS + hiển
    // thị metadata cơ bản trong list.
    const safeItems = items.map((it) => ({
        id:                     it.id,
        analysis_date:          it.analysis_date,
        geoserver_layer:        it.geoserver_layer,
        published_at:           it.published_at,
    }));
    OK_LIST(res, t('get_list_success', req.lang), safeItems, { page, limit, total });
};

// ── POST /fire-risk/refresh ───────────────────────────────────────────────────
const refresh = async (req, res) => {
    const analysisDate = req.body?.analysisDate || null;
    // Chỉ set khi client explicit gửi — nếu undefined, để service dùng default
    // `cfg.isGcsConfigured()` (không bật export raster khi thiếu GCS bucket).
    const submitExport = req.body?.submitExport !== undefined
        ? Boolean(req.body.submitExport) : undefined;
    // Optional v8.1 overrides — omit to fall back on env / cfg defaults.
    const enableRf         = req.body?.enableRf !== undefined
        ? Boolean(req.body.enableRf) : undefined;
    const inputFireAssetId = req.body?.inputFireAssetId
        ? String(req.body.inputFireAssetId).trim() : undefined;
    // Cho phép admin bật OOB per-request (đè env). Cost ~30-90s → không nên
    // default on để tránh làm chậm cron. Bỏ qua khi enableRf=false (pipeline
    // sẽ tự no-op).
    const computeOob       = req.body?.computeOob !== undefined
        ? Boolean(req.body.computeOob) : undefined;

    const snapshot = await svc.refresh({
        analysisDate, submitExport, enableRf, inputFireAssetId, computeOob,
    });
    CREATED(res, 'Đã kích hoạt phân tích cháy rừng.', { snapshot });
};

// ── GET /fire-risk/snapshots/:id/districts ───────────────────────────────────
// Trả về danh sách per-district download URL + area stats cho 1 snapshot.
// Migration 040: pipeline chia GEE download URL theo huyện (10 URL/tỉnh), lưu
// vào fire.fire_risk_district_exports. Endpoint này expose ra FE để render
// list "Tải theo huyện" thay cho single download URL cũ. optionalAuth để dashboard
// public đọc được.
const getDistrictExports = async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
        throw new Api400Error('ID snapshot không hợp lệ.', ['INVALID_ID']);
    }
    const snap = await repo.getById(id);
    if (!snap) throw new Api404Error('Snapshot không tồn tại.', ['SNAPSHOT_NOT_FOUND']);

    const rows = await repo.listDistrictExports(id);

    // Aggregate cho FE: tổng huyện completed/failed/skipped + tổng ha, byLevel.
    let completed = 0, failed = 0, skipped = 0, pending = 0;
    let totalHa   = 0;
    const byLevel = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const r of rows) {
        if (r.status === 'completed') completed += 1;
        else if (r.status === 'failed')  failed  += 1;
        else if (r.status === 'skipped') skipped += 1;
        else pending += 1;
        totalHa += Number(r.total_area_ha) || 0;
        const dist = r.area_stats?.riskLevelDist || {};
        for (let lv = 1; lv <= 5; lv++) byLevel[lv] += Number(dist[lv]) || 0;
    }

    // Response gọn cho FE — không expose raw column names DB.
    const districts = rows.map((r) => ({
        id:                   r.id,
        districtCode:         r.district_code,
        districtName:         r.district_name,
        status:               r.status,
        scaleM:               r.scale_m,
        areaStats:            r.area_stats || null,
        totalAreaHa:          r.total_area_ha != null ? Number(r.total_area_ha) : null,
        geeTileUrl:           r.gee_tile_url  || null,
        geeDownloadUrl:       r.gee_download_url || null,
        geeDownloadFilename:  r.gee_download_filename || null,
        geeGeneratedAt:       r.gee_generated_at,
        minioKey:             r.minio_key || null,
        geoserverLayer:       r.geoserver_layer || null,
        geoserverStore:       r.geoserver_store || null,
        rasterIngestJobId:    r.raster_ingest_job_id || null,
        errorMessage:         r.error_message || null,
        durationMs:           r.duration_ms || null,
        startedAt:            r.started_at,
        completedAt:          r.completed_at,
    }));

    OK(res, t('get_detail_success', req.lang), {
        snapshotId:    id,
        analysisDate:  snap.analysis_date,
        attempt:       snap.attempt,
        scaleM:        snap.export_scale_m ?? districts[0]?.scaleM ?? null,
        total:         rows.length,
        completed,
        failed,
        skipped,
        pending,
        aggregate:     {
            totalHa: Math.round(totalHa * 100) / 100,
            byLevel: Object.fromEntries(
                Object.entries(byLevel).map(([k, v]) => [k, Math.round(v * 100) / 100]),
            ),
        },
        districts,
    });
};

// ── POST /fire-risk/snapshots/:id/publish-raster ─────────────────────────────
// Enqueue raster-ingest job (GEE download URL → MinIO → GeoServer) và gán ngược
// `geoserver_layer` vào snapshot khi job xong (qua linkedResource trong service).
const publishRaster = async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) throw new Api400Error('ID snapshot không hợp lệ.', ['INVALID_ID']);

    const snap = await repo.getById(id);
    if (!snap) throw new Api404Error('Snapshot không tồn tại.', ['SNAPSHOT_NOT_FOUND']);
    if (!snap.gee_download_url) {
        throw new Api400Error('Snapshot chưa có geeDownloadUrl (chạy lại để tạo).', ['NO_DOWNLOAD_URL']);
    }
    if (snap.geoserver_layer) {
        // Idempotent info — cho phép re-publish (mở khoá) qua ?force=1.
        if (req.query.force !== '1') {
            return OK(res, 'Snapshot đã publish rồi.', {
                snapshotId: id, geoserverLayer: snap.geoserver_layer, alreadyPublished: true,
            });
        }
    }

    const dateTag = (snap.analysis_date instanceof Date
        ? snap.analysis_date.toISOString().slice(0, 10)
        : String(snap.analysis_date).slice(0, 10)
    ).replace(/-/g, '');
    // Layer code chuẩn: fire_risk_YYYYMMDD (đúng regex `[a-z][a-z0-9_-]{1,58}`).
    const layerCode = `fire_risk_${dateTag}`;

    const { job, deduplicated } = await ingestSvc.enqueue({
        sourceUrl: snap.gee_download_url,
        layerCode,
        nameVi:    `Cảnh báo cháy rừng ${dateTag.slice(0, 4)}-${dateTag.slice(4, 6)}-${dateTag.slice(6, 8)}`,
        isPublic:  true,
        category:  'fire_risk',
        requestParams: {
            // Back-link để service cập nhật snapshot khi job xong.
            linkedResource: { type: 'fire_risk', id },
            analysis_date:  snap.analysis_date,
            scale_m:        500,
        },
        user: req.user,
        lang: req.lang,
    });

    return CREATED(res, 'Đã tiếp nhận yêu cầu publish raster.', {
        snapshotId:   id,
        jobId:        job.id,
        status:       job.status,
        layerCode,
        deduplicated: deduplicated || false,
    });
};

module.exports = { getLatest, getMap, getHistory, getPublishedHistory, refresh, publishRaster, getDistrictExports };
