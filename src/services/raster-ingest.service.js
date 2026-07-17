'use strict';

/**
 * Orchestrator pipeline: GEE download URL → MinIO → GeoServer (S3GeoTiff).
 *
 * Bước:
 *   1. enqueue      — validate + dedupe + INSERT job pending
 *   2. runJob       — worker gọi khi claim được:
 *        downloading  → stream fetch zip → /tmp
 *        validating   → gdal unzip + build RGB COG
 *        uploading    → put COG lên MinIO (streaming)
 *        publishing   → GeoServer S3GeoTiff CoverageStore + upsert layer_registry
 *        completed    → dọn tmp
 *   3. lỗi bất kỳ bước → tăng retry_count, quay về pending nếu chưa vượt max.
 *
 * Không dùng shared filesystem — GeoServer đọc thẳng object từ MinIO qua
 * `gs-s3-geotiff` extension.
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const db          = require('../configs/database');
const cfg         = require('../configs/raster-ingest');
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
    const canRetry =
        job.retry_count < cfg.MAX_RETRIES
        && !(err instanceof Api400Error)
        && err.code !== 'FILE_TOO_LARGE'
        && err.code !== 'NO_TIF_IN_ZIP';

    if (canRetry) {
        await rasterRepo.incrementRetry(job.id);
        console.warn(`[RASTER-INGEST] job=${job.id} RETRY ${job.retry_count + 1}/${cfg.MAX_RETRIES} layer=${job.layer_code} — ${errMsg}`);
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

        // ── 4. GeoServer S3GeoTiff CoverageStore ───────────────────────
        const t4 = Date.now();
        const storeName    = job.layer_code;
        const params       = job.request_params || {};

        // Nhận biết re-ingest: cùng layer_code đã có geoserver_layer trong
        // layer_registry → cache GWC cần truncate sau khi PUT URL mới.
        const existingLayer = await layerRepo.findByCode(storeName);
        const isReingest    = Boolean(existingLayer?.geoserver_layer);
        dbg('PUBLISH', `store=${storeName} isReingest=${isReingest} s3=s3://${cfg.MINIO_BUCKET}/${objectKey}`);

        const geoserverLayer = await geoserver.publishS3GeoTiffLayer({
            storeName,
            s3Bucket: cfg.MINIO_BUCKET,
            s3Key:    objectKey,
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
