'use strict';

const svc  = require('../services/forest-classification.service');
const cfg  = require('../configs/forest-classification');
const repo = require('../repositories/forest-classification.repository');
const ingestSvc = require('../services/raster-ingest.service');
const minioSvc = require('../services/minio.service');
const { OK, OK_LIST, CREATED } = require('../core/success.response');
const { Api400Error, Api404Error } = require('../core/error.response');
const { hasPermission } = require('../middlewares/auth.middleware');
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

const ACTIVE_INGEST_STATUSES = new Set([
    'pending', 'downloading', 'validating', 'uploading', 'publishing',
]);

const nonEmpty = (value) => String(value || '').trim() || null;
const positiveInteger = (value, fallback, max = Number.MAX_SAFE_INTEGER) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0
        ? Math.min(parsed, max)
        : fallback;
};

const canViewDistrictInternals = (user) => Boolean(
    user && (
        user.role === 'system_admin'
        || hasPermission(user.role_permissions, 'forest_classification', 'manage')
        || hasPermission(user.role_permissions, 'map_layers', 'ingest_raster')
    )
);

const hasMatchingDistrictIngestJob = (row) => {
    const linked = row?.ingest_request_params?.linkedResource;
    return linked?.type === 'forest_district'
        && Number(linked.id) === Number(row?.snapshot_id)
        && String(linked.districtCode || '').trim()
            === String(row?.district_code || '').trim();
};

const districtMinioKey = (row) => {
    const direct = nonEmpty(row?.minio_key);
    if (direct) return direct;
    if (row?.ingest_job_status !== 'completed' || !hasMatchingDistrictIngestJob(row)) {
        return null;
    }
    const key = nonEmpty(row?.ingest_minio_key);
    if (!key) return null;
    const bucket = nonEmpty(row?.ingest_minio_bucket);
    return bucket ? `${bucket}/${key}` : key;
};

const districtMinioLocation = (row) => {
    const direct = nonEmpty(row?.minio_key);
    if (direct) {
        const slash = direct.indexOf('/');
        if (slash > 0 && slash < direct.length - 1) {
            return { bucket: direct.slice(0, slash), objectKey: direct.slice(slash + 1) };
        }
    }
    const objectKey = nonEmpty(row?.ingest_minio_key);
    const bucket = nonEmpty(row?.ingest_minio_bucket);
    return objectKey && bucket ? { bucket, objectKey } : null;
};

const districtGeoserverLayer = (row) => nonEmpty(row?.geoserver_layer)
    || (row?.ingest_job_status === 'completed' && hasMatchingDistrictIngestJob(row)
        ? nonEmpty(row?.ingest_geoserver_layer)
        : null);

const getUsableDistrictSourceUrl = (row) => {
    const value = nonEmpty(row?.gee_download_url);
    if (!value || !/^https?:\/\/\S+$/i.test(value)) return null;
    try {
        const parsed = new URL(value);
        if (!parsed.hostname) return null;
    } catch {
        return null;
    }

    const generatedAt = row?.gee_generated_at
        || row?.completed_at
        || row?.updated_at;
    if (generatedAt) {
        const generatedMs = new Date(generatedAt).getTime();
        if (Number.isFinite(generatedMs)
            && Date.now() - generatedMs >= cfg.GEE_TEMPORARY_URL_MAX_AGE_MS) {
            return null;
        }
    }
    return value;
};

const hasStableDistrictRaster = (row) =>
    Boolean(districtGeoserverLayer(row) && districtMinioKey(row));

const countDistinctDistrictCodes = (rows) => new Set(
    rows
        .map((row) => String(row?.district_code || '').trim())
        .filter(Boolean),
).size;

const hasCompleteStableDistrictSet = (rows, readyCount) =>
    rows.length === cfg.EXPECTED_DISTRICT_COUNT
    && countDistinctDistrictCodes(rows) === cfg.EXPECTED_DISTRICT_COUNT
    && readyCount === cfg.EXPECTED_DISTRICT_COUNT;

const resolveDistrictPublishSource = async (row) => {
    const stored = districtMinioLocation(row);
    if (stored) {
        const exists = await minioSvc.objectExists(stored.objectKey, stored.bucket);
        if (exists) {
            const signed = await minioSvc.getPresignedDownloadUrl(
                stored.objectKey,
                stored.bucket,
                6 * 60 * 60,
            );
            return { url: signed.url, kind: 'minio_archive' };
        }
    }

    const geeUrl = getUsableDistrictSourceUrl(row);
    return geeUrl ? { url: geeUrl, kind: 'gee_download_url' } : null;
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
    const page  = positiveInteger(req.query.page, 1);
    const limit = positiveInteger(req.query.limit, 24, 100);
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
    const page  = positiveInteger(req.query.page, 1);
    const limit = positiveInteger(req.query.limit, 24, 100);
    dbg('PUBLISHED_HISTORY', `page=${page} limit=${limit} user=${req.user?.id || 'anon'}`);
    const { items, total } = await svc.getHistory({
        page,
        limit,
        hasGeoserverLayer: true,
        requireCompleteDistrictSet: true,
    });
    const safeItems = items.map((it) => ({
        id:                    it.id,
        year:                  it.year,
        month:                 it.month,
        geoserver_layer:       it.geoserver_layer,
        published_at:          it.published_at,
        district_total:        it.district_total || 0,
        district_code_count:   it.district_code_count || 0,
        district_source_count: it.district_source_count || 0,
        district_geoserver_count: it.district_geoserver_count || 0,
        district_ready_count:  it.district_ready_count || 0,
        geoserver_layers:      it.geoserver_layers || [],
        totalDistricts:        it.district_total || 0,
        districtCodeCount:     it.district_code_count || 0,
        sourceCount:           it.district_source_count || 0,
        districtLayerCount:    it.district_geoserver_count || 0,
        readyCount:            it.district_ready_count || 0,
        geoserverLayers:       it.geoserver_layers || [],
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

    svc.refresh({
        year: selectedYear,
        month: selectedMonth,
        groundTruthAssetId,
        gtBufferM,
        minFieldTest,
    }).catch((error) => {
        console.error(
            `[FOREST-CLS] manual refresh ${selectedYear}/${selectedMonth} failed:`,
            error.message,
        );
    });
    res.status(202).json({
        message: 'Đã tiếp nhận yêu cầu phân loại lớp phủ rừng.',
        status: 202,
        data: {
            run: {
                year: selectedYear,
                month: selectedMonth,
                status: 'queued',
            },
        },
    });
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
    const numericOrNull = (value) => {
        if (value == null || value === '') return null;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    };
    return {
        id:                 s.id,
        year:               s.year,
        month:              s.month,
        status:             s.status,
        provinceSummary:    s.province_summary,
        oobAccuracy:        numericOrNull(s.oob_accuracy),
        testKappa:          numericOrNull(s.test_kappa),
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
    if (!Number.isInteger(id) || id <= 0) {
        throw new Api400Error('ID snapshot không hợp lệ.', ['INVALID_ID']);
    }
    let snap = await repo.getById(id);
    if (!snap) throw new Api404Error('Snapshot không tồn tại.', ['SNAPSHOT_NOT_FOUND']);

    await repo.reconcileDistrictExportArtifacts(id);
    const promoted = await repo.markPublishedIfDistrictsReady(id);
    if (promoted) snap = promoted;
    const rows = await repo.listDistrictExports(id);
    const includeInternals = canViewDistrictInternals(req.user);

    // Aggregate byClass + totalHa + forestHa (dùng FOREST_CLASS_IDS).
    let completed = 0, failed = 0, skipped = 0, pending = 0;
    let sourceCount = 0, publishedCount = 0, readyCount = 0, queuedCount = 0;
    let failedPublishCount = 0;
    let totalHa = 0, forestHa = 0;
    const byClass = {};
    for (const r of rows) {
        if (r.status === 'completed') completed += 1;
        else if (r.status === 'failed')  failed  += 1;
        else if (r.status === 'skipped') skipped += 1;
        else pending += 1;
        const stable = hasStableDistrictRaster(r);
        const active = !stable
            && hasMatchingDistrictIngestJob(r)
            && ACTIVE_INGEST_STATUSES.has(r.ingest_job_status);
        if (districtMinioKey(r) || getUsableDistrictSourceUrl(r)) sourceCount += 1;
        if (districtGeoserverLayer(r)) publishedCount += 1;
        if (stable) readyCount += 1;
        else if (active) queuedCount += 1;
        else if (r.status === 'failed' || r.ingest_job_status === 'failed') {
            failedPublishCount += 1;
        }
        totalHa  += Number(r.total_area_ha)  || 0;
        forestHa += Number(r.forest_area_ha) || 0;
        for (const [cid, ha] of Object.entries(r.area_by_class || {})) {
            byClass[cid] = (byClass[cid] || 0) + (Number(ha) || 0);
        }
    }
    const districtCodeCount = countDistinctDistrictCodes(rows);
    const fullyPublished = hasCompleteStableDistrictSet(rows, readyCount);

    const districts = rows.map((r) => {
        const safe = {
            id:              r.id,
            districtCode:    r.district_code,
            districtName:    r.district_name,
            status:          r.status,
            scaleM:          r.scale_m,
            areaByClass:     r.area_by_class || null,
            totalAreaHa:     r.total_area_ha != null ? Number(r.total_area_ha) : null,
            forestAreaHa:    r.forest_area_ha != null ? Number(r.forest_area_ha) : null,
            geoserverLayer:  districtGeoserverLayer(r),
        };
        if (!includeInternals) return safe;
        return {
            ...safe,
            geeTileUrl:          r.gee_tile_url || null,
            geeDownloadUrl:      getUsableDistrictSourceUrl(r),
            geeDownloadFilename: r.gee_download_filename || null,
            geeGeneratedAt:      r.gee_generated_at,
            minioKey:            districtMinioKey(r),
            geoserverStore:      r.geoserver_store || r.ingest_geoserver_store || null,
            rasterIngestJobId:   r.raster_ingest_job_id || null,
            rasterIngestStatus:  r.ingest_job_status || null,
            errorMessage:        r.error_message || r.ingest_job_error || null,
            durationMs:          r.duration_ms || null,
            startedAt:           r.started_at,
            completedAt:         r.completed_at,
        };
    });

    OK(res, t('get_detail_success', req.lang), {
        snapshotId: id,
        year:       snap.year,
        month:      snap.month,
        attempt:    snap.attempt,
        scaleM:     snap.download_scale_m ?? districts[0]?.scaleM ?? null,
        total:      rows.length,
        discoveredTotal: districtCodeCount,
        expectedTotal: cfg.EXPECTED_DISTRICT_COUNT,
        districtCodeCount,
        coverageScope: 'districtMosaic',
        coverageCount: districtCodeCount,
        fullyPublished,
        completed, failed, skipped, pending,
        sourceCount,
        publishedCount,
        readyCount,
        queuedCount,
        failedPublishCount,
        missingCount: Math.max(
            0,
            cfg.EXPECTED_DISTRICT_COUNT
                - readyCount
                - queuedCount
                - failedPublishCount,
        ),
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
// Publish is a district batch. The province-level GEE URL intentionally stays
// null; each of the nine district exports is independently archived and served.
const publishRaster = async (req, res) => {
    const id = Number(req.params.id);
    const force = req.query.force === '1';
    if (!Number.isInteger(id) || id <= 0) {
        throw new Api400Error('ID snapshot không hợp lệ.', ['INVALID_ID']);
    }

    const snap = await repo.getById(id);
    if (!snap) {
        throw new Api404Error('Snapshot không tồn tại.', ['SNAPSHOT_NOT_FOUND']);
    }
    if (!['completed', 'published'].includes(snap.status)) {
        throw new Api400Error(
            'Snapshot chưa hoàn thành nên chưa thể công bố.',
            ['SNAPSHOT_NOT_COMPLETED'],
        );
    }

    await repo.reconcileDistrictExportArtifacts(id);
    const rows = await repo.listDistrictExports(id);
    const tag = `${snap.year}${String(snap.month).padStart(2, '0')}`;
    const jobs = [];
    const enqueueErrors = new Map();
    const availableSourceIds = new Set();

    for (const row of rows) {
        const stable = hasStableDistrictRaster(row);
        const active = hasMatchingDistrictIngestJob(row)
            && ACTIVE_INGEST_STATUSES.has(row.ingest_job_status);
        const districtCode = String(row.district_code || '').trim();
        const layerCode = `forest_class_${districtCode || 'unknown'}_${tag}_s${snap.id}`;

        if (!districtCode) {
            enqueueErrors.set(row.id, 'Thiếu mã huyện hợp lệ.');
            continue;
        }
        if (stable) availableSourceIds.add(row.id);
        if (!force && stable) continue;
        if (!force && active && row.raster_ingest_job_id) {
            availableSourceIds.add(row.id);
            jobs.push({
                districtCode,
                districtName: row.district_name,
                jobId: row.raster_ingest_job_id,
                status: row.ingest_job_status,
                layerCode,
                deduplicated: true,
                existing: true,
                sourceKind: null,
            });
            continue;
        }

        let source;
        try {
            source = await resolveDistrictPublishSource(row);
        } catch (err) {
            enqueueErrors.set(row.id, err.message);
            continue;
        }
        if (!source) continue;
        availableSourceIds.add(row.id);

        try {
            const { job, deduplicated } = await ingestSvc.enqueue({
                sourceUrl: source.url,
                layerCode,
                nameVi: `Phân loại rừng ${snap.year}-${String(snap.month).padStart(2, '0')} — ${row.district_name || districtCode}`,
                isPublic: true,
                category: 'forest_district',
                requestParams: {
                    linkedResource: {
                        type: 'forest_district',
                        id: snap.id,
                        districtCode,
                    },
                    year: snap.year,
                    month: snap.month,
                    scale_m: row.scale_m || snap.download_scale_m || cfg.DOWNLOAD_SCALE_M,
                    publishRequested: true,
                    sourceKind: source.kind,
                },
                user: req.user || null,
                lang: req.lang,
            });
            if (job.layer_code !== layerCode) {
                throw new Error(
                    `Job #${job.id} thuộc layer ${job.layer_code}, không phải ${layerCode}.`,
                );
            }
            await repo.updateDistrictExport(row.id, {
                raster_ingest_job_id: job.id,
            });
            row.raster_ingest_job_id = job.id;
            row.ingest_job_status = job.status;
            jobs.push({
                districtCode,
                districtName: row.district_name,
                jobId: job.id,
                status: job.status,
                layerCode,
                deduplicated: Boolean(deduplicated),
                existing: Boolean(deduplicated),
                sourceKind: source.kind,
            });
        } catch (err) {
            enqueueErrors.set(row.id, err.message);
            console.error(
                `[FOREST-CTL] publish district snapshot=${id} code=${districtCode} failed: ${err.message}`,
            );
        }
    }

    const publishedSnapshot = await repo.markPublishedIfDistrictsReady(id);
    const readyCount = rows.filter(hasStableDistrictRaster).length;
    const publishedCount = rows.filter((row) => districtGeoserverLayer(row)).length;
    const sourceCount = availableSourceIds.size;
    const queuedDistricts = new Set(
        jobs
            .filter((job) => ACTIVE_INGEST_STATUSES.has(job.status))
            .map((job) => job.districtCode),
    );
    const queuedCount = rows.filter((row) =>
        !hasStableDistrictRaster(row)
        && queuedDistricts.has(String(row.district_code || '').trim())).length;
    const failedCount = rows.filter((row) =>
        !hasStableDistrictRaster(row)
        && !queuedDistricts.has(String(row.district_code || '').trim())
        && (
            row.status === 'failed'
            || row.ingest_job_status === 'failed'
            || enqueueErrors.has(row.id)
        )).length;
    const missingCount = Math.max(
        0,
        cfg.EXPECTED_DISTRICT_COUNT - readyCount - queuedCount - failedCount,
    );
    const enqueuedCount = jobs.filter((job) => !job.deduplicated).length;
    const districtCodeCount = countDistinctDistrictCodes(rows);
    const fullyPublished = hasCompleteStableDistrictSet(rows, readyCount);
    const alreadyPublished = fullyPublished && jobs.length === 0;
    const firstJob = jobs[0] || null;
    const data = {
        snapshotId: id,
        total: cfg.EXPECTED_DISTRICT_COUNT,
        totalDistricts: cfg.EXPECTED_DISTRICT_COUNT,
        discoveredCount: rows.length,
        districtCodeCount,
        fullyPublished,
        sourceCount,
        available: sourceCount,
        publishedCount,
        readyCount,
        published: readyCount,
        queued: queuedCount,
        queuedCount,
        enqueued: enqueuedCount,
        enqueuedCount,
        missing: missingCount,
        missingCount,
        unavailable: missingCount,
        failed: failedCount,
        failedCount,
        alreadyPublished,
        snapshotStatus: publishedSnapshot?.status
            || (fullyPublished ? 'published' : snap.status),
        jobs,
        errors: [...enqueueErrors.entries()].map(([districtExportId, message]) => ({
            districtExportId,
            message,
        })),
        // Backward compatibility for consumers that previously expected one job.
        jobId: firstJob?.jobId || null,
        status: firstJob?.status || (alreadyPublished ? 'published' : 'partial'),
        layerCode: firstJob?.layerCode || null,
        deduplicated: jobs.length > 0 && jobs.every((job) => job.deduplicated),
    };

    if (enqueuedCount > 0) {
        return CREATED(res, `Đã xếp hàng ${enqueuedCount} raster huyện để công bố.`, data);
    }
    return OK(
        res,
        alreadyPublished
            ? `Đủ ${cfg.EXPECTED_DISTRICT_COUNT}/${cfg.EXPECTED_DISTRICT_COUNT} raster huyện đã được lưu trữ và công bố.`
            : 'Đã kiểm tra trạng thái công bố raster theo huyện.',
        data,
    );
};

module.exports = { getLatest, getHistory, getPublishedHistory, refresh, queryPeriod, getSnapshot, publishRaster, getDistrictExports };
