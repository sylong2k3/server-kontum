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
// Trả null khi chưa có layer hoặc GEOSERVER_URL chưa cấu hình.
const buildGeoserverDownloadUrl = (layerFqn) => {
    if (!layerFqn) return null;
    const base = (process.env.GEOSERVER_PUBLIC_URL || process.env.GEOSERVER_URL || '')
        .trim().replace(/\/+$/, '');
    if (!base) return null;
    const [ws, name] = String(layerFqn).includes(':')
        ? String(layerFqn).split(':')
        : [process.env.GEOSERVER_WORKSPACE || 'kontum', String(layerFqn)];
    // WCS 2.0 coverageId dùng `__` (double underscore) làm workspace separator.
    const coverageId = `${ws}__${name}`;
    const qs = new URLSearchParams({
        service:    'WCS',
        version:    '2.0.1',
        request:    'GetCoverage',
        coverageId,
        format:     'image/tiff',
    });
    return `${base}/${ws}/wcs?${qs.toString()}`;
};

// ── GET /fire-risk/latest ─────────────────────────────────────────────────────
const getLatest = async (req, res) => {
    const minRiskLevel = parseInt(req.query.minRiskLevel, 10) || 1;
    const {
        snapshot, features, stale, computing,
        geeTileUrl, geeMapId, riskLevelViz,
    } = await svc.getLatest({ minRiskLevel });
    // NOTE — strip `geometry` field khỏi districtStats items để response gọn.
    // Polygon huyện đã có ở endpoint `/map` (fire_risk_features.geom), không
    // cần lặp trong `/latest`. Giữ centroid + stats.
    const districtStatsSlim = Array.isArray(snapshot.district_stats)
        ? snapshot.district_stats.map(({ geometry, ...rest }) => rest)
        : snapshot.district_stats;

    OK(res, t('get_detail_success', req.lang), {
        snapshot: {
            id:                  snapshot.id,
            analysisDate:        snapshot.analysis_date,
            status:              snapshot.status,
            provinceSummary:     snapshot.province_summary,
            // districtStats — thống kê per-huyện (unitCode, name, riskLevelDist,
            // pNesterovMean, s2Coverage, centroid). Đã strip geometry (xem trên).
            districtStats:       districtStatsSlim,
            pNesterovStats:      snapshot.p_nesterov_stats,
            s2CoverageRatio:     snapshot.s2_coverage_ratio,
            geoserverLayer:      snapshot.geoserver_layer || null,
            // Tile Earth Engine: client render trực tiếp bằng leaflet L.tileLayer(geeTileUrl).
            geeTileUrl:          snapshot.gee_tile_url || null,
            geeMapId:            snapshot.gee_map_id || null,
            geeTileGeneratedAt:  snapshot.gee_tile_generated_at || null,
            // GEE getDownloadURL clip theo RanhGioiTinh_Polygon — trả GeoTIFF
            // trần (image/tiff) valid ~24h. Client dùng để tải raster đầy đủ
            // về máy. downloadFilename: gợi ý tên file cho `<a download>` (GEE
            // default trả `<hash>:getPixels.tiff` không đọc được).
            geeDownloadUrl:      snapshot.gee_download_url || null,
            // WCS GetCoverage — persistent, full-resolution, không expire.
            // Client/admin nên ƯU TIÊN URL này khi có; fallback geeDownloadUrl.
            geoserverDownloadUrl: buildGeoserverDownloadUrl(snapshot.geoserver_layer),
            downloadFilename:    fireRiskFilename(snapshot.analysis_date),
            // Giữ alias cũ `geeDownloadFilename` để không vỡ FE cũ.
            geeDownloadFilename: fireRiskFilename(snapshot.analysis_date),
            computedAt:          snapshot.computed_at,
            publishedAt:         snapshot.published_at,
        },
        features,
        // Trùng field ở tầng ngoài để client tiện lấy khi chỉ cần tile URL.
        geeTileUrl,
        geeMapId,
        riskLevelViz,
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
    OK_LIST(res, t('get_list_success', req.lang), items, {
        page, limit, total,
        ...(hasGeoserverLayer !== undefined ? { hasGeoserverLayer } : {}),
    });
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

    const snapshot = await svc.refresh({
        analysisDate, submitExport, enableRf, inputFireAssetId,
    });
    CREATED(res, 'Đã kích hoạt phân tích cháy rừng.', { snapshot });
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

module.exports = { getLatest, getMap, getHistory, refresh, publishRaster };
