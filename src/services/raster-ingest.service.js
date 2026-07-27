'use strict';

/**
 * Orchestrator pipeline: GEE download URL → MinIO (archive) → GEOSERVER_DATA_DIR
 * → GeoServer (FileSystem GeoTIFF CoverageStore).
 *
 * Bước:
 *   1. enqueue      — validate + dedupe + INSERT job pending
 *   2. runJob       — worker gọi khi claim được:
 *        downloading  → stream fetch zip/tiff → /tmp
 *        validating   → detect zip vs tiff → COG (nếu có GDAL) hoặc passthrough
 *        uploading    → put COG/TIFF lên MinIO (streaming, archive)
 *        publishing   → copy /tmp → GEOSERVER_DATA_DIR/gee-rasters/<store>.tif
 *                       → tạo GeoTIFF CoverageStore + upsert layer_registry
 *        completed    → dọn tmp
 *   3. lỗi bất kỳ bước → tăng retry_count, quay về pending nếu chưa vượt max.
 *
 * GHI CHÚ — trước đây flow này dùng `gs-s3-geotiff` community extension để
 * GeoServer đọc thẳng từ MinIO, nhưng GeoServer 3.0.0 chưa port module này.
 * Chuyển sang FileSystem GeoTIFF (yêu cầu GEOSERVER_DATA_DIR set + Node process
 * ghi được vào đó). MinIO vẫn giữ làm archive nguồn.
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const db          = require('../configs/database');
const cfg         = require('../configs/raster-ingest');
const forestCfg   = require('../configs/forest-classification');
const rasterRepo  = require('../repositories/raster-ingest.repository');
const layerRepo   = require('../repositories/map-layer.repository');
const minio       = require('./minio.service');
const geoserver   = require('../utils/geoserver.client');
const { downloadToFile, DownloadError } = require('../utils/http-stream-download.util');
const { processGeeZipToCog, GeoTiffProcessError } = require('../utils/gee-zip-rgb.util');
const { Api400Error, Api404Error, BusinessLogicError } = require('../core/error.response');
const { StatusCodes } = require('../core/http-status-code');
const { t } = require('../utils/i18n.util');

const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ── Logging ──────────────────────────────────────────────────────────────────
// - console.log  : state transitions (enqueue/completed) — luôn log
// - console.warn : retry, cleanup best-effort fail — luôn log
// - console.error: fail terminal — luôn log
// - dbg()        : chi tiết stage timing — chỉ bật khi RASTER_INGEST_DEBUG=true
//                  hoặc NODE_ENV=development (giống pattern satellite.service.js)

const DEBUG = process.env.RASTER_INGEST_DEBUG === 'true'
    || process.env.NODE_ENV === 'development';

function dbg(tag, msg, data) {
    if (!DEBUG) return;
    const ts = new Date().toISOString();
    if (data !== undefined) {
        console.debug(`[RASTER-INGEST:${tag}] ${ts} — ${msg}`,
            typeof data === 'object' ? JSON.stringify(data) : data);
    } else {
        console.debug(`[RASTER-INGEST:${tag}] ${ts} — ${msg}`);
    }
}
function dbgTime(tag, label, startMs) {
    if (!DEBUG) return;
    dbg(tag, `${label} (${Date.now() - startMs}ms)`);
}

// Giấu token/query string khi log URL để không lộ secret ra CloudWatch/log tập trung.
const safeUrl = (url) => {
    if (!url) return '';
    try {
        const u = new URL(url);
        return `${u.protocol}//${u.host}${u.pathname.slice(0, 40)}…`;
    } catch { return url.slice(0, 60) + '…'; }
};
const fmtMB = (bytes) => `${(bytes / 1048576).toFixed(2)}MB`;

// ── ENQUEUE ──────────────────────────────────────────────────────────────────

/**
 * @param {object} args
 * @param {string} args.sourceUrl         — GEE download URL (zip GeoTIFF)
 * @param {string} args.layerCode         — mã layer đích trong gis.layer_registry
 * @param {string} [args.nameVi]
 * @param {string} [args.nameEn]
 * @param {boolean} [args.isPublic]
 * @param {string} [args.category]
 * @param {object} [args.requestParams]   — bbox, epsg_code, scale_m, gee_map_id...
 * @param {object} args.user
 * @param {string} args.lang
 */
async function enqueue({
    sourceUrl, layerCode, nameVi, nameEn, isPublic, category,
    requestParams = {}, user, lang = 'vi',
}) {
    if (!cfg.ENABLED) {
        throw new BusinessLogicError(
            t('raster_ingest_disabled', lang),
            ['RASTER_INGEST_DISABLED'], StatusCodes.SERVICE_UNAVAILABLE,
        );
    }
    if (!cfg.isS3Configured()) {
        throw new BusinessLogicError(
            t('raster_ingest_s3_not_configured', lang),
            ['RASTER_INGEST_S3_NOT_CONFIGURED'], StatusCodes.SERVICE_UNAVAILABLE,
        );
    }
    if (!sourceUrl || !/^https?:\/\//i.test(sourceUrl)) {
        throw new Api400Error(t('raster_ingest_invalid_url', lang), ['INVALID_SOURCE_URL']);
    }
    if (!/^[a-z][a-z0-9_-]{1,58}$/i.test(layerCode)) {
        throw new Api400Error(t('raster_ingest_invalid_layer_code', lang), ['INVALID_LAYER_CODE']);
    }

    const sourceHash = sha256Hex(sourceUrl);
    dbg('ENQUEUE', `layer=${layerCode} hash=${sourceHash.slice(0, 12)}… url=${safeUrl(sourceUrl)} user=${user?.id || 'anon'}`);

    // Dedupe — nếu đã có job cùng URL còn active thì trả job đó.
    const existing = await rasterRepo.findActiveBySourceHash(sourceHash);
    if (existing) {
        console.log(`[RASTER-INGEST] DEDUPE hit → job=${existing.id} status=${existing.status} layer=${layerCode}`);
        return { job: existing, deduplicated: true };
    }

    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        // URL GEE là tạm thời nên hai analysis cùng kỳ có thể sinh URL khác
        // nhau cho cùng layer. Advisory lock làm check + insert atomic giữa
        // nhiều request/process, rồi dedupe theo layer đích.
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [layerCode]);
        const activeLayerJob = await rasterRepo.findActiveByLayerCode(layerCode, client);
        if (activeLayerJob) {
            await client.query('COMMIT');
            console.log(`[RASTER-INGEST] DEDUPE layer → job=${activeLayerJob.id} status=${activeLayerJob.status} layer=${layerCode}`);
            return { job: activeLayerJob, deduplicated: true };
        }

        const job = await rasterRepo.insertJob(client, {
            layerCode,
            sourceKind:    'gee_download_url',
            sourceUrl,
            sourceHash,
            requestParams: {
                ...requestParams,
                nameVi:   nameVi || null,
                nameEn:   nameEn || null,
                isPublic: isPublic ?? false,
                category: category || 'remote_sensing',
            },
            createdBy: user?.id || null,
        });

        await client.query('COMMIT');
        console.log(`[RASTER-INGEST] ENQUEUED job=${job.id} layer=${layerCode} url=${safeUrl(sourceUrl)}`);
        return { job, deduplicated: false };
    } catch (err) {
        await client.query('ROLLBACK');
        // Vi phạm partial UNIQUE khi race → tra lại 1 lần.
        if (err.code === '23505') {
            const raced = await rasterRepo.findActiveBySourceHash(sourceHash);
            if (raced) {
                console.log(`[RASTER-INGEST] DEDUPE race → job=${raced.id} layer=${layerCode}`);
                return { job: raced, deduplicated: true };
            }
        }
        console.error(`[RASTER-INGEST] ENQUEUE FAILED layer=${layerCode} error=${err.code || err.name}: ${err.message}`);
        throw err;
    } finally {
        client.release();
    }
}

// ── RUN JOB ──────────────────────────────────────────────────────────────────

async function _cleanup(files) {
    for (const p of files) {
        if (!p) continue;
        await fs.promises.unlink(p).catch(() => {});
    }
}

async function _fail(job, err) {
    const errMsg = `${err.code || err.name || 'ERROR'}: ${err.message}`;
    const is429 = /HTTP 429|UPSTREAM_4XX.*429|rate.?limit/i.test(errMsg);
    const isNonRetryable4xx = err.code === 'UPSTREAM_4XX' && !is429;
    const canRetry =
        job.retry_count < cfg.MAX_RETRIES
        && !(err instanceof Api400Error)
        && err.code !== 'FILE_TOO_LARGE'
        && err.code !== 'NO_TIF_IN_ZIP'
        && !isNonRetryable4xx;

    if (canRetry) {
        // Detect HTTP 429 (rate limit) từ error message hoặc code. GEE
        // thumbnails endpoint có window 60-300s; nếu retry ngay 15s sau sẽ
        // trigger 429 tiếp tục, cuối cùng GEE hard-reject bằng 400 và
        // invalidate URL. Cần exponential backoff cho case này.
        //
        // Backoff formula (jittered):
        //   retry 1 → 60s + jitter (0-15s)
        //   retry 2 → 180s + jitter (0-30s)
        //   retry 3 → 600s (10min) + jitter (0-60s)
        //
        // Non-429 error (network fail, timeout, MinIO down, ...) → không
        // delay, poll ngay tick sau (behavior cũ giữ nguyên).
        let nextRetryAtMs = null;
        if (is429) {
            const base = [60_000, 180_000, 600_000][job.retry_count] || 600_000;
            const jitter = Math.floor(Math.random() * base * 0.25);
            nextRetryAtMs = base + jitter;
        }
        await rasterRepo.incrementRetry(job.id, { nextRetryAtMs });
        const delayNote = nextRetryAtMs
            ? ` (backoff ${Math.round(nextRetryAtMs / 1000)}s — 429 detected)`
            : '';
        console.warn(`[RASTER-INGEST] job=${job.id} RETRY ${job.retry_count + 1}/${cfg.MAX_RETRIES} layer=${job.layer_code} — ${errMsg}${delayNote}`);
    } else {
        await rasterRepo.updateStatus(job.id, {
            status:   'failed',
            errorLog: errMsg,
        });
        const reason = job.retry_count >= cfg.MAX_RETRIES ? 'MAX_RETRIES_EXCEEDED' : 'NON_RETRYABLE';
        console.error(`[RASTER-INGEST] job=${job.id} FAILED (${reason}) layer=${job.layer_code} — ${errMsg}`);
        if (DEBUG && err.stack) console.debug(err.stack);
    }
}

/**
 * Chạy 1 job đã được worker claim (status = 'downloading').
 * Ném lại lỗi ở lớp ngoài để worker log; state chuyển qua updateStatus.
 */
async function runJob(job) {
    const jobStart = Date.now();
    await fs.promises.mkdir(cfg.TMP_DIR, { recursive: true });

    const tag     = `job_${job.id}`;
    const zipPath = path.join(cfg.TMP_DIR, `${tag}.zip`);
    const cogPath = path.join(cfg.TMP_DIR, `${tag}.tif`);

    console.log(`[RASTER-INGEST] job=${job.id} START layer=${job.layer_code} retry=${job.retry_count}/${cfg.MAX_RETRIES}`);
    dbg('RUN', `tmp zip=${zipPath} cog=${cogPath} url=${safeUrl(job.source_url)}`);

    try {
        // ── 1. Download ────────────────────────────────────────────────
        const t1 = Date.now();
        dbg('DOWNLOAD', `start — timeout=${cfg.FETCH_TIMEOUT_MS}ms maxBytes=${fmtMB(cfg.MAX_BYTES)}`);
        const dlInfo = await downloadToFile(job.source_url, zipPath, {
            timeoutMs: cfg.FETCH_TIMEOUT_MS,
            maxBytes:  cfg.MAX_BYTES,
        });
        dbgTime('DOWNLOAD', `done bytes=${fmtMB(dlInfo.bytes)} contentType=${dlInfo.contentType}`, t1);
        await rasterRepo.updateStatus(job.id, { status: 'validating', progress: 30 });

        // ── 2. Extract + convert to RGB COG ────────────────────────────
        const t2 = Date.now();
        dbg('VALIDATE', `unzip + GDAL COG — gdalCache=${cfg.GDAL_CACHEMAX_MB}MB`);
        const cog = await processGeeZipToCog(zipPath, cogPath, {
            gdalCacheMB: cfg.GDAL_CACHEMAX_MB,
        });
        dbgTime('VALIDATE', `done mode=${cog.mode} size=${fmtMB(cog.size)}`, t2);
        await rasterRepo.updateStatus(job.id, { status: 'uploading', progress: 55 });

        // ── 3. Compute sha256 + upload to MinIO (streaming) ────────────
        const t3 = Date.now();
        const sha = await _sha256File(cogPath);
        const objectKey = _buildObjectKey(job, tag);
        dbg('UPLOAD', `bucket=${cfg.MINIO_BUCKET} key=${objectKey} sha256=${sha.slice(0, 12)}…`);

        await minio.uploadStream({
            stream:   fs.createReadStream(cogPath),
            objectKey,
            mimeType: 'image/tiff',
            fileSize: cog.size,
            bucket:   cfg.MINIO_BUCKET,
        });
        dbgTime('UPLOAD', `done`, t3);

        await rasterRepo.updateStatus(job.id, { status: 'publishing', progress: 80 });

        // ── 4. GeoServer FileSystem GeoTIFF CoverageStore ──────────────
        // GeoServer 3.0.0 chưa có community extension `gs-s3-geotiff`, nên
        // chuyển sang publish qua path filesystem: copy COG từ /tmp sang
        // GEOSERVER_DATA_DIR/gee-rasters/<store>.tif rồi tạo GeoTIFF store.
        // MinIO vẫn giữ file làm archive/back-link để re-publish sau này.
        const t4 = Date.now();
        const storeName    = job.layer_code;
        const params       = job.request_params || {};
        const gsDataDir    = process.env.GEOSERVER_DATA_DIR;
        if (!gsDataDir) {
            throw new Error('GEOSERVER_DATA_DIR chưa cấu hình — cần thiết cho publish GeoTIFF filesystem');
        }
        const publishDir   = path.join(gsDataDir, 'gee-rasters');
        const publishPath  = path.join(publishDir, `${storeName}.tif`);
        await fs.promises.mkdir(publishDir, { recursive: true });
        await fs.promises.copyFile(cogPath, publishPath);
        dbg('PUBLISH', `copied cog → ${publishPath}`);

        // Nhận biết re-ingest: cùng layer_code đã có geoserver_layer trong
        // layer_registry → cache GWC cần truncate sau khi PUT URL mới.
        const existingLayer = await layerRepo.findByCode(storeName);
        const isReingest    = Boolean(existingLayer?.geoserver_layer);
        dbg('PUBLISH', `store=${storeName} isReingest=${isReingest} file=${publishPath}`);

        const geoserverLayer = await geoserver.publishFsGeoTiffLayer({
            storeName,
            filePath: publishPath,
            title:    params.nameVi || storeName,
            enabled:  true,
        });

        if (isReingest) {
            await geoserver.truncateGwcLayer(geoserverLayer).catch((err) => {
                // Best-effort: cache stale không nghẽn được ingest.
                console.warn(`[RASTER-INGEST] job=${job.id} GWC truncate FAILED layer=${geoserverLayer} — ${err.message}`);
            });
            dbg('PUBLISH', `re-ingest: GWC truncated for ${geoserverLayer}`);
        }
        dbgTime('PUBLISH', `done → ${geoserverLayer}`, t4);

        // ── 5. Upsert layer_registry ──────────────────────────────────
        const t5 = Date.now();
        const layerRow = await _upsertRasterLayer({
            job, params, storeName, geoserverLayer, objectKey, sha,
        });
        dbgTime('REGISTRY', `layer_id=${layerRow.id}`, t5);

        await rasterRepo.saveOutput(job.id, {
            minioBucket:    cfg.MINIO_BUCKET,
            minioKey:       objectKey,
            fileSizeBytes:  cog.size,
            fileSha256:     sha,
            geoserverStore: storeName,
            geoserverLayer,
            layerId:        layerRow.id,
        });
        await rasterRepo.updateStatus(job.id, { status: 'completed', progress: 100 });

        // ── 6. Back-link linked resource (fire_risk snapshot, forest, ...) ──
        // Nếu enqueue có `params.linkedResource = { type, id }` → cập nhật
        // bảng nguồn để user thấy `geoserver_layer` gán vào lịch sử snapshot.
        try {
            await _backLinkResource(params.linkedResource, {
                geoserverLayer, geoserverStore: storeName,
                minioBucket: cfg.MINIO_BUCKET, minioKey: objectKey,
                rasterIngestJobId: job.id,
            });
        } catch (err) {
            console.warn(`[RASTER-INGEST] backlink FAILED job=${job.id}: ${err.message}`);
        }

        console.log(`[RASTER-INGEST] job=${job.id} COMPLETED layer=${geoserverLayer} size=${fmtMB(cog.size)} dl=${fmtMB(dlInfo.bytes)} mode=${cog.mode} reingest=${isReingest} total=${Date.now() - jobStart}ms`);
    } catch (err) {
        await _fail(job, err);
        throw err;
    } finally {
        await _cleanup([zipPath, cogPath]);
        dbg('CLEANUP', `removed tmp files for job=${job.id}`);
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _buildObjectKey(job, tag) {
    const now = new Date();
    const yyyy = now.getUTCFullYear();
    const mm   = String(now.getUTCMonth() + 1).padStart(2, '0');
    const safe = job.layer_code.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
    return `gee/${yyyy}/${mm}/${safe}/${tag}.tif`;
}

function _sha256File(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('error', reject);
        stream.on('data',  (c) => hash.update(c));
        stream.on('end',   () => resolve(hash.digest('hex')));
    });
}

// Back-link: cập nhật `geoserver_layer` + `minio_key` cho snapshot của module
// gốc (fire_risk / forest / satellite). Support qua allow-list để tránh SQL
// injection và giới hạn scope.
async function _backLinkResource(
    linked,
    { geoserverLayer, geoserverStore, minioBucket, minioKey, rasterIngestJobId },
) {
    if (!linked?.type || !linked?.id) return;
    const idNum = Number(linked.id);
    if (!Number.isFinite(idNum)) return;

    const targets = {
        fire_risk: {
            table:  'fire.fire_risk_snapshots',
            cols:   ['geoserver_layer', 'geoserver_store', 'minio_key', 'published_at'],
            values: [geoserverLayer, geoserverStore, `${minioBucket}/${minioKey}`, new Date()],
        },
        forest: {
            table:  'forest.forest_snapshots',
            cols:   ['geoserver_layer', 'geoserver_store', 'minio_key', 'published_at'],
            values: [geoserverLayer, geoserverStore, `${minioBucket}/${minioKey}`, new Date()],
        },
        satellite: {
            table:  'satellite.image_results',
            cols:   ['geoserver_layer', 'geoserver_store', 'minio_key', 'status'],
            values: [geoserverLayer, geoserverStore, `${minioBucket}/${minioKey}`, 'published'],
        },
        // Migration 040: per-district export tables. `id` trong linkedResource
        // là ID của row district_exports (không phải snapshot). FE dựa vào
        // geoserver_layer/minio_key ở dòng này để hiển thị nút "Đã có bản đồ"
        // cho từng huyện.
        fire_risk_district: {
            table:  'fire.fire_risk_district_exports',
            cols:   ['geoserver_layer', 'geoserver_store', 'minio_key', 'raster_ingest_job_id'],
            values: [
                geoserverLayer, geoserverStore,
                `${minioBucket}/${minioKey}`, rasterIngestJobId,
            ],
        },
        forest_district: {
            table:  'forest.forest_district_exports',
            cols:   ['geoserver_layer', 'geoserver_store', 'minio_key', 'raster_ingest_job_id'],
            values: [
                geoserverLayer, geoserverStore,
                `${minioBucket}/${minioKey}`, rasterIngestJobId,
            ],
        },
    };
    const target = targets[linked.type];
    if (!target) {
        console.warn(`[RASTER-INGEST] unknown linkedResource.type=${linked.type} — skip back-link`);
        return;
    }
    // District exports linkedResource dùng {type,id:snapshot_id,districtCode}.
    // Query row theo (snapshot_id, district_code) thay vì id — vì id trong
    // linkedResource của service pipeline là snapshot_id.
    let sql, bindValues;
    if (linked.type === 'fire_risk_district' || linked.type === 'forest_district') {
        const dcode = String(linked.districtCode || '');
        const setClauses = target.cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
        sql = `UPDATE ${target.table} SET ${setClauses}
               WHERE snapshot_id = $${target.cols.length + 1}
                 AND district_code = $${target.cols.length + 2}`;
        bindValues = [...target.values, idNum, dcode];
    } else {
        const setClauses = target.cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
        sql = `UPDATE ${target.table} SET ${setClauses}
               WHERE id = $${target.cols.length + 1}`;
        bindValues = [...target.values, idNum];
    }
    const result = await db.query(sql, bindValues);
    if (result.rowCount > 0 && linked.type === 'forest_district') {
        const { rows } = await db.query(
            `UPDATE forest.forest_snapshots s
             SET status = 'published',
                 published_at = COALESCE(s.published_at, NOW()),
                 updated_at = NOW()
             WHERE s.id = $1
               AND s.status = 'completed'
               AND (
                   SELECT COUNT(*)::int
                   FROM forest.forest_district_exports d
                   WHERE d.snapshot_id = s.id
               ) = $2
               AND (
                   SELECT COUNT(DISTINCT NULLIF(BTRIM(d.district_code), ''))::int
                   FROM forest.forest_district_exports d
                   WHERE d.snapshot_id = s.id
               ) = $2
               AND NOT EXISTS (
                   SELECT 1
                   FROM forest.forest_district_exports d
                   WHERE d.snapshot_id = s.id
                     AND (
                         NULLIF(BTRIM(d.geoserver_layer), '') IS NULL
                         OR NULLIF(BTRIM(d.minio_key), '') IS NULL
                     )
               )
             RETURNING s.id`,
            [idNum, forestCfg.EXPECTED_DISTRICT_COUNT],
        );
        if (rows[0]) {
            console.log(
                `[RASTER-INGEST] forest snapshot#${idNum} PUBLISHED ` +
                `after ${forestCfg.EXPECTED_DISTRICT_COUNT}/` +
                `${forestCfg.EXPECTED_DISTRICT_COUNT} district layers became stable`,
            );
        }
    }
    if (result.rowCount === 0) {
        console.warn(`[RASTER-INGEST] backlink ${linked.type}#${idNum}${linked.districtCode ? '/' + linked.districtCode : ''} → 0 rows updated`);
    } else {
        console.log(`[RASTER-INGEST] backlink ok ${linked.type}#${idNum}${linked.districtCode ? '/' + linked.districtCode : ''} → ${geoserverLayer}`);
    }
}

async function _upsertRasterLayer({ job, params, storeName, geoserverLayer, objectKey, sha }) {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        const layer = await layerRepo.upsertLayerByCode(client, {
            code:            job.layer_code,
            name_vi:         params.nameVi || job.layer_code,
            name_en:         params.nameEn || null,
            schema_name:     'gis',
            table_name:      storeName,             // NOT NULL — dùng lại storeName
            // geometry_column NOT NULL + CHECK regex trong migration 010; raster
            // không dùng nhưng vẫn phải hợp lệ → 'geom' placeholder.
            geometry_column: 'geom',
            geometry_type:   'RASTER',
            epsg_code:       params.epsg_code || 4326,
            category:        params.category || 'remote_sensing',
            layer_kind:      'overlay',
            layer_group:     params.layer_group || null,
            data_year:       params.data_year || new Date().getUTCFullYear(),
            source_dataset:  'gee',
            is_active:       true,
            is_public:       params.isPublic ?? false,
            is_editable:     false,
            source_url:      `s3://${cfg.MINIO_BUCKET}/${objectKey}`,
            userId:          job.created_by,
        });

        // Đánh dấu published + link ngược raster_ingest_job_id + metadata GEE.
        await client.query(
            `UPDATE gis.layer_registry
             SET geoserver_layer      = $2,
                 geoserver_store      = $3,
                 raster_ingest_job_id = $4,
                 raster_source_url    = $5,
                 raster_gee_metadata  = COALESCE($6::jsonb, raster_gee_metadata),
                 last_updated_at      = NOW(),
                 updated_at           = NOW()
             WHERE id = $1`,
            [
                layer.id, geoserverLayer, storeName, job.id,
                job.source_url,
                JSON.stringify({
                    gee_map_id: params.gee_map_id || null,
                    gee_task_id: params.gee_task_id || null,
                    scale_m: params.scale_m || cfg.DEFAULT_SCALE_M,
                    bbox: params.bbox || cfg.KONTUM_BBOX,
                    file_sha256: sha,
                    ingested_at: new Date().toISOString(),
                }),
            ],
        );

        await client.query('COMMIT');
        return layer;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

// ── Read APIs ────────────────────────────────────────────────────────────────

async function getJobById(id, lang = 'vi') {
    const job = await rasterRepo.findById(id);
    if (!job) throw new Api404Error(t('raster_ingest_job_not_found', lang), ['JOB_NOT_FOUND']);
    return job;
}

async function listJobsByLayer(layerCode, query = {}) {
    const limit  = Math.min(Number(query.limit) || 20, 100);
    const offset = ((Number(query.page) || 1) - 1) * limit;
    return rasterRepo.listByLayerCode(layerCode, { limit, offset });
}

module.exports = { enqueue, runJob, getJobById, listJobsByLayer };
