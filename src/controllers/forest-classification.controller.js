'use strict';

const svc  = require('../services/forest-classification.service');
const cfg  = require('../configs/forest-classification');
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
    const base = (process.env.GEOSERVER_PUBLIC_URL || '')
        .trim().replace(/\/+$/, '');
    if (!base) return null;
    const [ws, name] = String(layerFqn).includes(':')
        ? String(layerFqn).split(':')
        : [process.env.GEOSERVER_WORKSPACE || 'kontum', String(layerFqn)];
    const root = base
        .replace(new RegExp(`/${ws}/(?:wms|wcs)$`, 'i'), '')
        .replace(/\/(?:wms|wcs)$/i, '');
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

// ── GET /forest-classification/latest ────────────────────────────────────────
const getLatest = async (req, res) => {
    dbg('LATEST', `caller user=${req.user?.id || 'anon'} lang=${req.lang}`);
    const { snapshot, districtAreas, comparison, stale, computing }
        = await svc.getLatest();
    OK(res, t('get_detail_success', req.lang), {
        snapshot: formatSnapshot(snapshot),
        districtAreas,
        comparison,
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
        geoserver_layer:       it.geoserver_layer,
        published_at:          it.published_at,
    }));
    OK_LIST(res, t('get_list_success', req.lang), safeItems, { page, limit, total });
};

// ── POST /forest-classification/refresh ──────────────────────────────────────
const refresh = async (req, res) => {
    const year  = req.body?.year  ? parseInt(req.body.year,  10) : null;
    const month = req.body?.month ? parseInt(req.body.month, 10) : null;
    const now = new Date();
    const selectedYear = year || now.getUTCFullYear();
    const selectedMonth = month || (now.getUTCMonth() + 1);
    const isFuture = selectedYear > now.getUTCFullYear()
        || (selectedYear === now.getUTCFullYear() && selectedMonth > now.getUTCMonth() + 1);
    if (!Number.isInteger(selectedYear) || selectedYear < 1984 || selectedYear > now.getUTCFullYear()
        || !Number.isInteger(selectedMonth) || selectedMonth < 1 || selectedMonth > 12 || isFuture) {
        throw new Api400Error(
            'Kỳ phân tích không hợp lệ. Chọn tháng từ 01/1984 đến tháng hiện tại.',
            ['INVALID_ANALYSIS_PERIOD'],
        );
    }
    // Optional v3 ground-truth overrides — fall back to env defaults in svc.refresh.
    const groundTruthAssetId = req.body?.groundTruthAssetId
        ? String(req.body.groundTruthAssetId).trim() : undefined;
    const gtBufferM    = req.body?.gtBufferM    != null ? Number(req.body.gtBufferM)    : undefined;
    const minFieldTest = req.body?.minFieldTest != null ? Number(req.body.minFieldTest) : undefined;

    const snapshot = await svc.refresh({
        year: selectedYear,
        month: selectedMonth,
        groundTruthAssetId,
        gtBufferM,
        minFieldTest,
    });
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
    const { snapshot, districtAreas, comparison, cached, computing } =
        await svc.queryForPeriod(year, month, userId);

    OK(res,
        cached ? t('get_detail_success', req.lang) : 'Đang xử lý, vui lòng truy vấn lại sau.',
        {
            snapshot: snapshot ? formatSnapshot(snapshot) : null,
            districtAreas,
            comparison,
            cached,
            computing,
        },
    );
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
        comparison:    result.comparison,
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
        provinceSummary:    s.province_summary,
        oobAccuracy:        s.oob_accuracy,
        testKappa:          s.test_kappa ?? null,
        geoserverLayer:     s.geoserver_layer || null,
        geeTileUrl:         s.gee_tile_url || null,
        geeTileGeneratedAt: s.gee_tile_generated_at || null,
        geeDownloadUrl:       s.gee_download_url || null,
        geoserverDownloadUrl: buildGeoserverDownloadUrl(s.geoserver_layer),
        downloadFilename:     forestFilename(s.year, s.month),
        computedAt:         s.computed_at,
    };
}

// ── GET /forest-classification/snapshots/:id/districts ──────────────────────
// Trả list per-district GEE download URL + area_by_class cho 1 snapshot.
// Migration 040: pipeline chia download theo huyện thay vì 1 URL toàn tỉnh.
// Aggregate lên tỉnh = SUM area huyện. optionalAuth để dashboard public đọc.
const getDistrictExports = async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
        throw new Api400Error('ID snapshot không hợp lệ.', ['INVALID_ID']);
    }
    const snap = await repo.getById(id);
    if (!snap) throw new Api404Error('Snapshot không tồn tại.', ['SNAPSHOT_NOT_FOUND']);

    const rows = await repo.listDistrictExports(id);

    // Aggregate byClass + totalHa + forestHa (dùng FOREST_CLASS_IDS).
    let completed = 0, failed = 0, skipped = 0, pending = 0;
    let totalHa = 0, forestHa = 0;
    const byClass = {};
    for (const r of rows) {
        if (r.status === 'completed') completed += 1;
        else if (r.status === 'failed')  failed  += 1;
        else if (r.status === 'skipped') skipped += 1;
        else pending += 1;
        totalHa  += Number(r.total_area_ha)  || 0;
        forestHa += Number(r.forest_area_ha) || 0;
        for (const [cid, ha] of Object.entries(r.area_by_class || {})) {
            byClass[cid] = (byClass[cid] || 0) + (Number(ha) || 0);
        }
    }

    const districts = rows.map((r) => ({
        id:                   r.id,
        districtCode:         r.district_code,
        districtName:         r.district_name,
        status:               r.status,
        scaleM:               r.scale_m,
        areaByClass:          r.area_by_class || null,
        totalAreaHa:          r.total_area_ha  != null ? Number(r.total_area_ha)  : null,
        forestAreaHa:         r.forest_area_ha != null ? Number(r.forest_area_ha) : null,
        geeTileUrl:           r.gee_tile_url || null,
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
        snapshotId: id,
        year:       snap.year,
        month:      snap.month,
        attempt:    snap.attempt,
        scaleM:     snap.download_scale_m ?? districts[0]?.scaleM ?? null,
        total:      rows.length,
        completed, failed, skipped, pending,
        aggregate:  {
            totalHa:  Math.round(totalHa  * 100) / 100,
            forestHa: Math.round(forestHa * 100) / 100,
            byClass:  Object.fromEntries(
                Object.entries(byClass).map(([k, v]) => [k, Math.round(v * 100) / 100]),
            ),
        },
        districts,
    });
};

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
            scale_m: cfg.DOWNLOAD_SCALE_M,
        },
        user: req.user || null,
        lang: req.lang,
    });
    console.log(`[FOREST-CTL] publishRaster snapshot=${id} → job=${job.id} status=${job.status} deduplicated=${Boolean(deduplicated)}`);

    return CREATED(res, deduplicated ? 'Job publish đã tồn tại — trả về job cũ.' : 'Đã kích hoạt job publish.', {
        snapshotId: id,
        jobId: job.id,
        status: job.status,
        layerCode,
        deduplicated: Boolean(deduplicated),
    });
};

module.exports = { getLatest, getHistory, getPublishedHistory, refresh, queryPeriod, getSnapshot, publishRaster, getDistrictExports };
