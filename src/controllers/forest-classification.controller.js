'use strict';

const svc  = require('../services/forest-classification.service');
const { OK, OK_LIST, CREATED } = require('../core/success.response');
const { t } = require('../utils/i18n.util');

// ── GET /forest-classification/latest ────────────────────────────────────────
const getLatest = async (req, res) => {
    const { snapshot, districtAreas, stale, computing } = await svc.getLatest();
    OK(res, t('get_detail_success', req.lang), {
        snapshot: formatSnapshot(snapshot),
        districtAreas,
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
    const snapshot = await svc.refresh({ year, month });
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
        id:              s.id,
        year:            s.year,
        month:           s.month,
        status:          s.status,
        trigger:         s.trigger || 'cron',
        provinceSummary: s.province_summary,
        oobAccuracy:     s.oob_accuracy,
        durationMs:      s.duration_ms ?? null,
        geoserverLayer:  s.geoserver_layer || null,
        computedAt:      s.computed_at,
        publishedAt:     s.published_at,
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
