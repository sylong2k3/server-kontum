'use strict';

const svc  = require('../services/fire-risk.service');
const cfg  = require('../configs/fire-risk');
const repo = require('../repositories/fire-risk.repository');
const ingestSvc = require('../services/raster-ingest.service');
const minioSvc = require('../services/minio.service');
const { OK, OK_LIST, CREATED } = require('../core/success.response');
const { Api400Error, Api404Error } = require('../core/error.response');
const { hasPermission } = require('../middlewares/auth.middleware');
const { t } = require('../utils/i18n.util');
const {
    buildGeeProcessingState,
    toPublicProcessingError,
} = require('../utils/gee-processing-state.util');
const geeQueue = require('../queues/gee-task.queue');

// Derive filename ổn định cho download GeoTIFF fire-risk. GEE `getDownloadURL`
// với `filePerBand:false` trên `.visualize()` trả TIFF trần (Content-Type
// image/tiff), KHÔNG phải zip — đặt `.tif` để Windows Explorer nhận đúng loại
// file (nếu đặt `.zip` như trước sẽ prompt "invalid archive" khi user double-click).
const formatFireRiskDate = (analysisDate) => {
    if (!analysisDate) return null;
    if (!(analysisDate instanceof Date)) return String(analysisDate).slice(0, 10);
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: process.env.FIRE_RISK_CRON_TZ || 'Asia/Ho_Chi_Minh',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(analysisDate).reduce((result, part) => {
        if (part.type !== 'literal') result[part.type] = part.value;
        return result;
    }, {});
    return `${parts.year}-${parts.month}-${parts.day}`;
};

const fireRiskFilename = (analysisDate) => {
    const d = formatFireRiskDate(analysisDate);
    if (!d) return null;
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

const ACTIVE_INGEST_STATUSES = new Set([
    'pending', 'downloading', 'validating', 'uploading', 'publishing',
]);

const nonEmpty = (value) => String(value || '').trim() || null;

const canViewDistrictInternals = (user) => Boolean(
    user && (
        user.role === 'system_admin'
        || hasPermission(user.role_permissions, 'fire_risk', 'manage')
        || hasPermission(user.role_permissions, 'map_layers', 'ingest_raster')
    )
);

const hasMatchingDistrictIngestJob = (row) => {
    const linked = row?.ingest_request_params?.linkedResource;
    return linked?.type === 'fire_risk_district'
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
            return {
                bucket: direct.slice(0, slash),
                objectKey: direct.slice(slash + 1),
            };
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
        if (!new URL(value).hostname) return null;
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

const slimAreaStats = (stats) => {
    if (!stats || typeof stats !== 'object' || Array.isArray(stats)) return stats || null;
    const safe = { ...stats };
    delete safe.geometry;
    return safe;
};

// ── GET /fire-risk/latest ─────────────────────────────────────────────────────
const getLatest = async (req, res) => {
    const minRiskLevel = parseInt(req.query.minRiskLevel, 10) || 1;
    const { snapshot, processingSnapshot, features, stale, computing } =
        await svc.getLatest({ minRiskLevel });
    OK(res, t('get_detail_success', req.lang), {
        snapshot: formatSnapshot(snapshot),
        features,
        stale,
        computing,
        processing: buildGeeProcessingState({
            pipeline: 'fire-risk',
            snapshot: processingSnapshot || snapshot,
        }),
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
        error_message: toPublicProcessingError(item.error_message),
        last_retry_error: toPublicProcessingError(item.last_retry_error),
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
    const meta = s._modelMeta || null;
    return {
        maxLevel:        s.maxLevel ?? null,
        avgRiskLevel:    s.avgRiskLevel ?? null,
        riskLevelDist:   s.riskLevelDist || {},
        s2CoverageRatio: s.s2CoverageRatio ?? null,
        modelMeta: meta ? {
            pipelineVersion: meta.pipelineVersion || null,
            rfRequested:     Boolean(meta.rfRequested),
            rfEffective:     Boolean(meta.rfEffective),
            degradedMode:    Boolean(meta.degradedMode || meta.rfSkipReason),
            rfSkipReason:    meta.rfSkipReason || null,
            trainingCounts:  meta.trainingCounts || null,
        } : null,
    };
};

const numberOrNull = (value) => {
    if (value == null || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
};

const formatSnapshot = (snapshot) => {
    if (!snapshot) return null;
    const districtStats = Array.isArray(snapshot.district_stats)
        ? snapshot.district_stats.map((district) => ({
            unitCode: district.unitCode ?? null,
            name: district.name ?? null,
            centroid: district.centroid ?? null,
            riskLevelDist: district.riskLevelDist || {},
            pNesterovMean: numberOrNull(district.pNesterovMean),
            s2Coverage: numberOrNull(district.s2Coverage),
        }))
        : [];
    return {
        id: snapshot.id,
        analysisDate: snapshot.analysis_date,
        status: snapshot.status,
        provinceSummary: formatProvinceSummary(snapshot.province_summary),
        districtStats,
        districtExportSummary: snapshot.district_export_summary || null,
        geoserverLayer: snapshot.geoserver_layer || null,
        geeTileUrl: snapshot.gee_tile_url || null,
        geeTileGeneratedAt: snapshot.gee_tile_generated_at || null,
        geeDownloadUrl: snapshot.gee_download_url || null,
        geoserverDownloadUrl: buildGeoserverDownloadUrl(snapshot.geoserver_layer),
        downloadFilename: fireRiskFilename(snapshot.analysis_date),
        computedAt: snapshot.computed_at || null,
        publishedAt: snapshot.published_at || null,
        errorMessage: toPublicProcessingError(snapshot.error_message),
        retryCount: Number(snapshot.retry_count) || 0,
        nextRetryAt: snapshot.next_retry_at || null,
        lastRetryError: toPublicProcessingError(snapshot.last_retry_error),
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
        page,
        limit,
        hasGeoserverLayer: true,
        requireCompleteDistrictSet: true,
    });
    // Whitelist field an toàn cho public — chỉ đủ để client render WMS + hiển
    // thị metadata cơ bản trong list.
    const safeItems = items.map((it) => ({
        id:                     it.id,
        analysis_date:          it.analysis_date,
        geoserver_layer:        it.geoserver_layer,
        geoserver_layers:       it.geoserver_layers || [],
        district_layer_count:   it.district_ready_count || 0,
        district_code_count:    it.district_code_count || 0,
        total_districts:        it.district_total || 0,
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

    const requestedDate = analysisDate || new Date().toISOString().slice(0, 10);
    const taskKey = `analysis:fire-risk:${requestedDate}`;
    const admission = geeQueue.preflight({
        key: taskKey,
        cooldownMs: geeQueue.MANUAL_TASK_COOLDOWN_MS,
    });
    svc.refresh({
        analysisDate, submitExport, enableRf, inputFireAssetId, computeOob,
    }).catch((error) => {
        console.error(
            `[FIRE-RISK] manual refresh ${requestedDate} failed:`,
            error.message,
        );
    });
    const processing = buildGeeProcessingState({
        pipeline: 'fire-risk',
        taskKey,
    });
    res.status(202).json({
        message: admission.deduplicated
            ? 'Yêu cầu phân tích cháy rừng đã có trong hàng chờ xử lý.'
            : 'Đã tiếp nhận yêu cầu phân tích cháy rừng.',
        status: 202,
        data: {
            run: {
                analysisDate: requestedDate,
                status: processing.state,
                deduplicated: admission.deduplicated,
                processing,
            },
        },
    });
};

// ── GET /fire-risk/snapshots/:id/districts ───────────────────────────────────
// Trả về danh sách per-district download URL + area stats cho 1 snapshot.
// Migration 040: pipeline chia GEE download URL theo huyện (10 URL/tỉnh), lưu
// vào fire.fire_risk_district_exports. Public chỉ nhận metadata + GeoServer
// layer; URL GEE, MinIO key, job/error nội bộ chỉ trả cho admin có quyền.
const getDistrictExports = async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
        throw new Api400Error('Mã kết quả không hợp lệ.', ['INVALID_ID']);
    }
    let snap = await repo.getById(id);
    if (!snap) throw new Api404Error('Không tìm thấy kết quả.', ['RESULT_NOT_FOUND']);

    await repo.reconcileDistrictExportArtifacts(id);
    const promoted = await repo.markPublishedIfDistrictsReady(id);
    if (promoted) snap = promoted;
    const rows = await repo.listDistrictExports(id);
    const includeInternals = canViewDistrictInternals(req.user);

    let completed = 0, failed = 0, skipped = 0, pending = 0;
    let sourceCount = 0, publishedCount = 0, readyCount = 0, queuedCount = 0;
    let failedPublishCount = 0;
    let totalHa   = 0;
    const byLevel = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
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

        totalHa += Number(r.total_area_ha) || 0;
        const dist = r.area_stats?.riskLevelDist || {};
        for (let lv = 1; lv <= 5; lv++) byLevel[lv] += Number(dist[lv]) || 0;
    }
    const districtCodeCount = countDistinctDistrictCodes(rows);
    const fullyPublished = hasCompleteStableDistrictSet(rows, readyCount);

    const districts = rows.map((r) => {
        // Per-district tile URL từ pipeline (mỗi huyện 1 URL, đã clip theo
        // geometry huyện) — public field vì FE cần render overlay cho anon user.
        // Chỉ trả URL còn hạn dùng (helper getTemporaryRasterUrlStatus phía FE
        // đã có logic hết hạn); server không lọc theo TTL để tránh state race.
        const tileUrl = r.gee_tile_url || null;
        const safe = {
            id:              r.id,
            districtCode:    r.district_code,
            districtName:    r.district_name,
            status:          r.status,
            scaleM:          r.scale_m,
            areaStats:       slimAreaStats(r.area_stats),
            totalAreaHa:     r.total_area_ha != null ? Number(r.total_area_ha) : null,
            geoserverLayer:  districtGeoserverLayer(r),
            tileUrl,
            tileGeneratedAt: r.gee_generated_at,
        };
        if (!includeInternals) return safe;
        return {
            ...safe,
            geeTileUrl:          tileUrl,
            geeMapId:            r.gee_map_id || null,
            geeDownloadUrl:      getUsableDistrictSourceUrl(r),
            geeDownloadFilename: r.gee_download_filename || null,
            geeGeneratedAt:      r.gee_generated_at,
            minioKey:            districtMinioKey(r),
            geoserverStore:      r.geoserver_store || r.ingest_geoserver_store || null,
            rasterIngestJobId:   r.raster_ingest_job_id || null,
            rasterIngestStatus:  r.ingest_job_status || null,
            errorMessage:        toPublicProcessingError(
                r.error_message || r.ingest_job_error,
            ),
            durationMs:          r.duration_ms || null,
            startedAt:           r.started_at,
            completedAt:         r.completed_at,
        };
    });

    OK(res, t('get_detail_success', req.lang), {
        snapshotId:    id,
        analysisDate:  snap.analysis_date,
        attempt:       snap.attempt,
        snapshotStatus: snap.status,
        scaleM:        snap.export_scale_m ?? districts[0]?.scaleM ?? null,
        total:         rows.length,
        discoveredTotal: districtCodeCount,
        expectedTotal: cfg.EXPECTED_DISTRICT_COUNT,
        districtCodeCount,
        coverageScope: 'districtMosaic',
        coverageCount: districtCodeCount,
        fullyPublished,
        completed,
        failed,
        skipped,
        pending,
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
    const force = req.query.force === '1';
    if (!Number.isInteger(id) || id <= 0) {
        throw new Api400Error('Mã kết quả không hợp lệ.', ['INVALID_ID']);
    }

    const snap = await repo.getById(id);
    if (!snap) throw new Api404Error('Không tìm thấy kết quả.', ['RESULT_NOT_FOUND']);
    if (!['completed', 'published'].includes(snap.status)) {
        throw new Api400Error(
            'Kết quả chưa hoàn tất nên chưa thể công bố.',
            ['RESULT_NOT_READY'],
        );
    }

    await repo.reconcileDistrictExportArtifacts(id);
    const rows = await repo.listDistrictExports(id);
    const analysisDate = formatFireRiskDate(snap.analysis_date);
    const dateTag = analysisDate.replace(/-/g, '');
    const jobs = [];
    const enqueueErrors = new Map();
    const availableSourceIds = new Set();

    for (const row of rows) {
        const stable = hasStableDistrictRaster(row);
        const active = hasMatchingDistrictIngestJob(row)
            && ACTIVE_INGEST_STATUSES.has(row.ingest_job_status);
        const districtCode = String(row.district_code || '').trim();
        const layerCode = `fire_risk_${districtCode || 'unknown'}_${dateTag}_s${snap.id}`;

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
                nameVi: `Cảnh báo cháy rừng ${analysisDate} — ${row.district_name || districtCode}`,
                isPublic: true,
                category: 'fire_risk_district',
                requestParams: {
                    linkedResource: {
                        type: 'fire_risk_district',
                        id: snap.id,
                        districtCode,
                    },
                    analysis_date: analysisDate,
                    scale_m: row.scale_m || snap.export_scale_m || cfg.EXPORT_SCALE_M,
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
                `[FIRE-RISK-CTL] publish district snapshot=${id} code=${districtCode} failed: ${err.message}`,
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
            message: toPublicProcessingError(message),
        })),
        jobId: firstJob?.jobId || null,
        status: firstJob?.status || (alreadyPublished ? 'published' : 'partial'),
        layerCode: firstJob?.layerCode || null,
        deduplicated: jobs.length > 0 && jobs.every((job) => job.deduplicated),
    };

    if (enqueuedCount > 0) {
        return CREATED(
            res,
            `Đã đưa dữ liệu của ${enqueuedCount} huyện vào hàng chờ cập nhật bản đồ.`,
            data,
        );
    }
    return OK(
        res,
        alreadyPublished
            ? `Dữ liệu bản đồ của ${cfg.EXPECTED_DISTRICT_COUNT}/${cfg.EXPECTED_DISTRICT_COUNT} huyện đã được lưu và công bố.`
            : 'Đã kiểm tra trạng thái cập nhật bản đồ theo huyện.',
        data,
    );
};

module.exports = { getLatest, getMap, getHistory, getPublishedHistory, refresh, publishRaster, getDistrictExports };
