'use strict';

const svc  = require('../services/fire-risk.service');
const { OK, OK_LIST, CREATED } = require('../core/success.response');
const { t } = require('../utils/i18n.util');

// ── GET /fire-risk/latest ─────────────────────────────────────────────────────
const getLatest = async (req, res) => {
    const minRiskLevel = parseInt(req.query.minRiskLevel, 10) || 1;
    const {
        snapshot, features, stale, computing,
        geeTileUrl, geeMapId, riskLevelViz,
    } = await svc.getLatest({ minRiskLevel });
    OK(res, t('get_detail_success', req.lang), {
        snapshot: {
            id:                  snapshot.id,
            analysisDate:        snapshot.analysis_date,
            status:              snapshot.status,
            provinceSummary:     snapshot.province_summary,
            // districtStats đã gỡ — bây giờ tính cấp cảnh báo trên polygon tỉnh
            // (RanhGioiTinh_Polygon), không phân theo huyện nữa.
            pNesterovStats:      snapshot.p_nesterov_stats,
            s2CoverageRatio:     snapshot.s2_coverage_ratio,
            geoserverLayer:      snapshot.geoserver_layer || null,
            // Tile Earth Engine: client render trực tiếp bằng leaflet L.tileLayer(geeTileUrl).
            geeTileUrl:          snapshot.gee_tile_url || null,
            geeMapId:            snapshot.gee_map_id || null,
            geeTileGeneratedAt:  snapshot.gee_tile_generated_at || null,
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
const getHistory = async (req, res) => {
    const page  = parseInt(req.query.page,  10) || 1;
    const limit = parseInt(req.query.limit, 10) || 30;
    const { items, total } = await svc.getHistory({ page, limit });
    OK_LIST(res, t('get_list_success', req.lang), items, { page, limit, total });
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

module.exports = { getLatest, getMap, getHistory, refresh };
