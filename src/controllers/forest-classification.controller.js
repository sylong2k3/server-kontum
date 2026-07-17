'use strict';

const svc  = require('../services/forest-classification.service');
const { OK, OK_LIST, CREATED } = require('../core/success.response');
const { t } = require('../utils/i18n.util');

// ── GET /forest-classification/latest ────────────────────────────────────────
const getLatest = async (req, res) => {
    const { snapshot, districtAreas, stale, computing, geeTileUrl, geeMapId, classifiedViz }
        = await svc.getLatest();
    OK(res, t('get_detail_success', req.lang), {
        snapshot: formatSnapshot(snapshot),
        districtAreas,
        // Tile Earth Engine cho client render trực tiếp raster 11 lớp.
        geeTileUrl,
        geeMapId,
        classifiedViz,
        stale,
        computing,
    });
};

// ── GET /forest-classification/history ───────────────────────────────────────
const getHistory = async (req, res) => {
    const page  = parseInt(req.query.page,  10) || 1;
    const limit = parseInt(req.query.limit, 10) || 24;
    const { items, total } = await svc.getHistory({ page, limit });
    OK_LIST(res, t('get_list_success', req.lang), items, { page, limit, total });
};

// ── POST /forest-classification/refresh ──────────────────────────────────────
const refresh = async (req, res) => {
    const year  = req.body?.year  ? parseInt(req.body.year,  10) : null;
    const month = req.body?.month ? parseInt(req.body.month, 10) : null;
    // Optional v3 ground-truth overrides — fall back to env defaults in svc.refresh.
    const groundTruthAssetId = req.body?.groundTruthAssetId
        ? String(req.body.groundTruthAssetId).trim() : undefined;
    const gtBufferM    = req.body?.gtBufferM    != null ? Number(req.body.gtBufferM)    : undefined;
    const minFieldTest = req.body?.minFieldTest != null ? Number(req.body.minFieldTest) : undefined;

    const snapshot = await svc.refresh({ year, month, groundTruthAssetId, gtBufferM, minFieldTest });
    CREATED(res, 'Đã kích hoạt phân loại lớp phủ rừng.', { snapshot });
};

// ── POST /forest-classification/query ────────────────────────────────────────
// User on-demand: returns cached result immediately or triggers background analysis.
const queryPeriod = async (req, res) => {
    const year  = parseInt(req.body?.year,  10);
    const month = parseInt(req.body?.month, 10);

    if (!year || !month || month < 1 || month > 12) {
        return res.status(400).json({ message: 'year và month là bắt buộc (month: 1-12).' });
    }

    const userId = req.user?.id || null;
    const { snapshot, districtAreas, cached, computing } =
        await svc.queryForPeriod(year, month, userId);

    OK(res,
        cached ? t('get_detail_success', req.lang) : 'Đang xử lý, vui lòng truy vấn lại sau.',
        { snapshot: snapshot ? formatSnapshot(snapshot) : null, districtAreas, cached, computing },
    );
};

// ── GET /forest-classification/logs ──────────────────────────────────────────
// Admin: full audit log of all runs (all statuses, all triggers).
const getLogs = async (req, res) => {
    const page   = parseInt(req.query.page,   10) || 1;
    const limit  = parseInt(req.query.limit,  10) || 24;
    const status = req.query.status || null;
    const { items, total } = await svc.getLogs({ page, limit, status });
    OK_LIST(res, t('get_list_success', req.lang), items.map(formatLogRow), { page, limit, total });
};

// ── GET /forest-classification/snapshot/:id ───────────────────────────────────
// Poll a specific run by ID — used after POST /query returns computing=true.
const getSnapshot = async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id || id <= 0) return res.status(400).json({ message: 'id không hợp lệ.' });

    const result = await svc.getSnapshotById(id);
    if (!result) return res.status(404).json({ message: 'Không tìm thấy snapshot.' });

    OK(res, t('get_detail_success', req.lang), {
        snapshot:      formatSnapshot(result.snapshot),
        districtAreas: result.districtAreas,
        computing:     !['completed', 'published'].includes(result.snapshot.status),
    });
};

// ── Shared formatters ─────────────────────────────────────────────────────────

function formatSnapshot(s) {
    if (!s) return null;
    return {
        id:                 s.id,
        year:               s.year,
        month:              s.month,
        status:             s.status,
        trigger:            s.trigger || 'cron',
        provinceSummary:    s.province_summary,
        oobAccuracy:        s.oob_accuracy,
        testAccuracy:       s.test_accuracy ?? null,
        testKappa:          s.test_kappa ?? null,
        sampleQuotas:       s.sample_quotas ?? null,
        modelParams:        s.model_params ?? null,
        durationMs:         s.duration_ms ?? null,
        geoserverLayer:     s.geoserver_layer || null,
        // Đưa cả 3 field GEE tile vào snapshot để client có sẵn khi chỉ đọc snapshot.
        geeTileUrl:         s.gee_tile_url || null,
        geeMapId:           s.gee_map_id || null,
        geeTileGeneratedAt: s.gee_tile_generated_at || null,
        computedAt:         s.computed_at,
        publishedAt:        s.published_at,
    };
}

function formatLogRow(s) {
    return {
        id:             s.id,
        year:           s.year,
        month:          s.month,
        status:         s.status,
        trigger:        s.trigger || 'cron',
        requestedBy:    s.requested_by ?? null,
        oobAccuracy:    s.oob_accuracy ?? null,
        s2ImageCount:   s.s2_image_count ?? null,
        lsImageCount:   s.ls_image_count ?? null,
        durationMs:     s.duration_ms ?? null,
        geoserverLayer: s.geoserver_layer || null,
        errorMessage:   s.error_message || null,
        computedAt:     s.computed_at,
        publishedAt:    s.published_at,
        createdAt:      s.created_at,
    };
}

module.exports = { getLatest, getHistory, refresh, queryPeriod, getLogs, getSnapshot };
