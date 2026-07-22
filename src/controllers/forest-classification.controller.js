'use strict';

const svc  = require('../services/forest-classification.service');
const repo = require('../repositories/forest-classification.repository');
const ingestSvc = require('../services/raster-ingest.service');
const { OK, OK_LIST, CREATED } = require('../core/success.response');
const { Api400Error, Api404Error } = require('../core/error.response');
const { t } = require('../utils/i18n.util');

// Debug — FC_DEBUG=true (hoặc NODE_ENV=development) → in `[FOREST-CTL:DBG] ...`
// cho các endpoint. Info/warn/error luôn ghi.
const DEBUG = process.env.FC_DEBUG === 'true'
    || process.env.NODE_ENV === 'development';
const dbg = (tag, msg) => { if (DEBUG) console.debug(`[FOREST-CTL:DBG:${tag}] ${msg}`); };

// Derive filename ổn định cho download GeoTIFF forest classification —
// `forest_class_kontum_YYYYMM.tif`. GEE trả TIFF trần (image/tiff), extension
// `.tif` giúp Windows Explorer nhận đúng loại file.
const forestFilename = (year, month) => {
    if (!year || !month) return null;
    const tag = `${year}${String(month).padStart(2, '0')}`;
    return `forest_class_kontum_${tag}.tif`;
};

// Build URL WCS GetCoverage trả GeoTIFF full-resolution từ GeoServer. Cùng
// helper với fire-risk — ưu tiên hơn geeDownloadUrl (persistent, không expire,
// không giảm resolution như GEE getDownloadURL).
const buildGeoserverDownloadUrl = (layerFqn) => {
    if (!layerFqn) return null;
    const base = (process.env.GEOSERVER_PUBLIC_URL || process.env.GEOSERVER_URL || '')
        .trim().replace(/\/+$/, '');
    if (!base) return null;
    const [ws, name] = String(layerFqn).includes(':')
        ? String(layerFqn).split(':')
        : [process.env.GEOSERVER_WORKSPACE || 'kontum', String(layerFqn)];
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

// ── GET /forest-classification/map ───────────────────────────────────────────
// Trả GeoJSON FeatureCollection ranh giới huyện + area stats từ snapshot mới
// nhất. Mirror pattern fire-risk /map — client render trực tiếp bằng
// Leaflet/MapLibre, không cần wrap OK() (raw JSON theo GeoJSON spec).
const getMap = async (req, res) => {
    dbg('MAP', `caller user=${req.user?.id || 'anon'} lang=${req.lang}`);
    const geojson = await svc.getMap();
    res.json(geojson);
};

// ── GET /forest-classification/latest ────────────────────────────────────────
const getLatest = async (req, res) => {
    dbg('LATEST', `caller user=${req.user?.id || 'anon'} lang=${req.lang}`);
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
// Filter options (mirror fire-risk):
//   ?hasGeoserverLayer=true  → chỉ snapshot đã publish GeoServer
//   ?hasGeoserverLayer=false → chỉ snapshot chưa publish
//   không truyền           → tất cả (backward-compat).
const getHistory = async (req, res) => {
    const page  = parseInt(req.query.page,  10) || 1;
    const limit = parseInt(req.query.limit, 10) || 24;
    let hasGeoserverLayer;
    if (req.query.hasGeoserverLayer === 'true')  hasGeoserverLayer = true;
    if (req.query.hasGeoserverLayer === 'false') hasGeoserverLayer = false;
    dbg('HISTORY', `page=${page} limit=${limit} hasGeoserverLayer=${hasGeoserverLayer ?? 'all'} user=${req.user?.id || 'anon'}`);
    const { items, total } = await svc.getHistory({ page, limit, hasGeoserverLayer });
    OK_LIST(res, t('get_list_success', req.lang), items, {
        page, limit, total,
        ...(hasGeoserverLayer !== undefined ? { hasGeoserverLayer } : {}),
    });
};

// ── GET /forest-classification/published-history ─────────────────────────────
// Public sub-endpoint (optionalAuth) — mirror pattern fire-risk. Force filter
// hasGeoserverLayer=true, trả subset field an toàn. Dùng cho client browse để
// add WMS overlay các tháng cũ vào bản đồ. Khác `/history`: `/history` admin-
// only, trả full field + tất cả trạng thái.
const getPublishedHistory = async (req, res) => {
    const page  = parseInt(req.query.page,  10) || 1;
    const limit = parseInt(req.query.limit, 10) || 24;
    dbg('PUBLISHED_HISTORY', `page=${page} limit=${limit} user=${req.user?.id || 'anon'}`);
    const { items, total } = await svc.getHistory({
        page, limit, hasGeoserverLayer: true,
    });
    const safeItems = items.map((it) => ({
        id:                    it.id,
        year:                  it.year,
        month:                 it.month,
        status:                it.status,
        geoserver_layer:       it.geoserver_layer,
        gee_tile_url:          it.gee_tile_url,
        gee_tile_generated_at: it.gee_tile_generated_at,
        computed_at:           it.computed_at,
        published_at:          it.published_at,
    }));
    OK_LIST(res, t('get_list_success', req.lang), safeItems, { page, limit, total });
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

    // BUG-FIX (2026-07-19): trước đây `!['completed','published'].includes(status)`
    // trả TRUE cho cả `failed` → UI hiện "Đang phân tích..." mãi cho snapshot đã
    // lỗi. Whitelist các state thực sự đang xử lý → snapshot `failed` giờ trả
    // computing=false, UI dừng poll và hiển thị lỗi rõ ràng.
    const activeStates = ['computing', 'exporting', 'pending'];
    OK(res, t('get_detail_success', req.lang), {
        snapshot:      formatSnapshot(result.snapshot),
        districtAreas: result.districtAreas,
        computing:     activeStates.includes(result.snapshot.status),
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
        // Download URLs — client/admin ưu tiên `geoserverDownloadUrl` (WCS
        // persistent, full-res) → fallback `geeDownloadUrl` (GEE trần, TTL 24h).
        geeDownloadUrl:       s.gee_download_url || null,
        geoserverDownloadUrl: buildGeoserverDownloadUrl(s.geoserver_layer),
        downloadFilename:     forestFilename(s.year, s.month),
        computedAt:         s.computed_at,
        publishedAt:        s.published_at,
    };
}

// ── POST /forest-classification/snapshots/:id/publish-raster ────────────────
// Enqueue raster-ingest job (GEE download URL → MinIO → GeoServer). Snapshot
// được back-link `geoserver_layer` khi job xong (linkedResource type='forest'
// đã handle sẵn trong raster-ingest.service._backLinkResource). Idempotent:
// snapshot đã publish sẽ trả `alreadyPublished: true` trừ khi `?force=1`.
const publishRaster = async (req, res) => {
    const id = Number(req.params.id);
    const force = req.query.force === '1';
    console.log(`[FOREST-CTL] publishRaster REQUEST snapshotId=${id} force=${force} user=${req.user?.id || 'anon'}`);

    if (!Number.isFinite(id)) throw new Api400Error('ID snapshot không hợp lệ.', ['INVALID_ID']);

    const snap = await repo.getById(id);
    if (!snap) {
        dbg('PUBLISH', `snapshot ${id} not found → 404`);
        throw new Api404Error('Snapshot không tồn tại.', ['SNAPSHOT_NOT_FOUND']);
    }
    dbg('PUBLISH',
        `snapshot loaded id=${id} y/m=${snap.year}/${snap.month} status=${snap.status} ` +
        `hasLayer=${Boolean(snap.geoserver_layer)} hasDlUrl=${Boolean(snap.gee_download_url)}`);

    if (!snap.gee_download_url) {
        console.warn(`[FOREST-CTL] publishRaster snapshot=${id} REJECTED — no gee_download_url. Client cần trigger refresh trước.`);
        throw new Api400Error(
            'Snapshot chưa có geeDownloadUrl (chạy lại để tạo).',
            ['NO_DOWNLOAD_URL'],
        );
    }
    if (snap.geoserver_layer && !force) {
        console.log(`[FOREST-CTL] publishRaster snapshot=${id} ALREADY_PUBLISHED layer=${snap.geoserver_layer} (use ?force=1 để re-publish)`);
        return OK(res, 'Snapshot đã publish rồi.', {
            snapshotId: id, geoserverLayer: snap.geoserver_layer, alreadyPublished: true,
        });
    }

    const tag = `${snap.year}${String(snap.month).padStart(2, '0')}`;
    // Layer code chuẩn: forest_class_YYYYMM (đúng regex `[a-z][a-z0-9_-]{1,58}`).
    const layerCode = `forest_class_${tag}`;

    const { job, deduplicated } = await ingestSvc.enqueue({
        sourceUrl: snap.gee_download_url,
        layerCode,
        nameVi:    `Phân loại rừng ${snap.year}-${String(snap.month).padStart(2, '0')}`,
        isPublic:  true,
        category:  'forest',
        requestParams: {
            linkedResource: { type: 'forest', id: snap.id },
            year:  snap.year,
            month: snap.month,
        },
        user: req.user || null,
        lang: req.lang,
    });
    console.log(`[FOREST-CTL] publishRaster snapshot=${id} → job=${job.id} status=${job.status} deduplicated=${Boolean(deduplicated)}`);

    CREATED(res, deduplicated ? 'Job publish đã tồn tại — trả về job cũ.' : 'Đã kích hoạt job publish.', {
        jobId: job.id, status: job.status, deduplicated: Boolean(deduplicated),
    });
};

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

module.exports = { getLatest, getMap, getHistory, getPublishedHistory, refresh, queryPeriod, getLogs, getSnapshot, publishRaster };
