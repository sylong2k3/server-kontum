'use strict';

const svc  = require('../services/fire-risk.service');
const { OK, OK_LIST, CREATED } = require('../core/success.response');
const { t } = require('../utils/i18n.util');

// ── GET /fire-risk/latest ─────────────────────────────────────────────────────
const getLatest = async (req, res) => {
    const minRiskLevel = parseInt(req.query.minRiskLevel, 10) || 1;
    const { snapshot, features, stale, computing } = await svc.getLatest({ minRiskLevel });
    OK(res, t('get_detail_success', req.lang), {
        snapshot: {
            id:               snapshot.id,
            analysisDate:     snapshot.analysis_date,
            status:           snapshot.status,
            provinceSummary:  snapshot.province_summary,
            districtStats:    snapshot.district_stats,
            pNesterovStats:   snapshot.p_nesterov_stats,
            s2CoverageRatio:  snapshot.s2_coverage_ratio,
            geoserverLayer:   snapshot.geoserver_layer || null,
            computedAt:       snapshot.computed_at,
            publishedAt:      snapshot.published_at,
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
const getHistory = async (req, res) => {
    const page  = parseInt(req.query.page,  10) || 1;
    const limit = parseInt(req.query.limit, 10) || 30;
    const { items, total } = await svc.getHistory({ page, limit });
    OK_LIST(res, t('get_list_success', req.lang), items, { page, limit, total });
};

// ── POST /fire-risk/refresh ───────────────────────────────────────────────────
const refresh = async (req, res) => {
    const analysisDate = req.body?.analysisDate || null;
    const submitExport = req.body?.submitExport !== false;  // default true
    const snapshot = await svc.refresh({ analysisDate, submitExport });
    CREATED(res, 'Đã kích hoạt phân tích cháy rừng.', { snapshot });
};

module.exports = { getLatest, getMap, getHistory, refresh };
