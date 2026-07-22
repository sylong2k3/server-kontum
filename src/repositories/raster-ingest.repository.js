'use strict';

/**
 * Repository cho gis.raster_ingest_jobs.
 * Query pattern bám theo geoImport.worker.claimPendingJobs (FOR UPDATE SKIP LOCKED).
 */

const db = require('../configs/database');

const DEBUG = process.env.RASTER_INGEST_DEBUG === 'true'
    || process.env.NODE_ENV === 'development';
const dbg = (msg) => { if (DEBUG) console.debug(`[RASTER-INGEST-REPO] ${msg}`); };

const COLUMNS = `
    id, layer_id, layer_code, source_kind, source_url, source_hash,
    request_params, status, retry_count, progress, error_log,
    minio_bucket, minio_key, file_size_bytes, file_sha256,
    geoserver_store, geoserver_layer,
    created_by, created_at, started_at, completed_at
`;

// ── Create ───────────────────────────────────────────────────────────────────

async function insertJob(client, {
    layerCode, sourceKind, sourceUrl, sourceHash, requestParams, createdBy,
}) {
    const q = `
        INSERT INTO gis.raster_ingest_jobs
            (layer_code, source_kind, source_url, source_hash, request_params, created_by)
        VALUES ($1, $2, $3, $4, COALESCE($5::jsonb, '{}'::jsonb), $6)
        RETURNING ${COLUMNS}
    `;
    const { rows } = await client.query(q, [
        layerCode, sourceKind, sourceUrl, sourceHash,
        requestParams ? JSON.stringify(requestParams) : null,
        createdBy,
    ]);
    return rows[0];
}

/**
 * Nếu đã có job cùng source_hash CHƯA terminal → trả về job đó (dedupe).
 * Idempotent: caller gọi lại POST cùng URL trong lúc đang chạy → không tạo mới.
 */
async function findActiveBySourceHash(sourceHash) {
    const { rows } = await db.query(
        `SELECT ${COLUMNS}
         FROM gis.raster_ingest_jobs
         WHERE source_hash = $1
           AND status NOT IN ('completed','failed','cancelled')
         LIMIT 1`,
        [sourceHash],
    );
    if (rows[0]) dbg(`findActiveBySourceHash hash=${sourceHash.slice(0, 12)}… → hit job=#${rows[0].id} status=${rows[0].status}`);
    return rows[0] || null;
}

// ── Read ─────────────────────────────────────────────────────────────────────

async function findById(id) {
    const { rows } = await db.query(
        `SELECT ${COLUMNS} FROM gis.raster_ingest_jobs WHERE id = $1`,
        [id],
    );
    return rows[0] || null;
}

async function listByLayerCode(layerCode, { limit = 20, offset = 0 } = {}) {
    const { rows } = await db.query(
        `SELECT ${COLUMNS}
         FROM gis.raster_ingest_jobs
         WHERE layer_code = $1
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [layerCode, limit, offset],
    );
    return rows;
}

// ── Update ───────────────────────────────────────────────────────────────────

/**
 * Cập nhật status + progress. Dùng $2::text[]-style whitelist để không cho phép
 * SQL injection qua status.
 */
async function updateStatus(id, { status, progress, errorLog }) {
    dbg(`updateStatus #${id} → status=${status || '(same)'} progress=${progress ?? '(same)'}${errorLog ? ' err=' + errorLog.slice(0, 80) : ''}`);
    const q = `
        UPDATE gis.raster_ingest_jobs
        SET status    = COALESCE($2, status),
            progress  = COALESCE($3, progress),
            error_log = COALESCE($4, error_log),
            started_at = CASE
                WHEN started_at IS NULL AND $2 IN ('downloading','validating','uploading','publishing')
                THEN NOW() ELSE started_at END
        WHERE id = $1
        RETURNING ${COLUMNS}
    `;
    const { rows } = await db.query(q, [id, status || null, progress ?? null, errorLog || null]);
    return rows[0] || null;
}

/**
 * Increment retry_count + reset về pending. Optional `nextRetryAtMs` = số ms
 * delay tối thiểu trước khi worker được claim lại — dùng cho backoff sau
 * HTTP 429 (GEE rate limit). Null/0 → poll ngay tick sau (behavior cũ).
 */
async function incrementRetry(id, { nextRetryAtMs = null } = {}) {
    if (nextRetryAtMs) {
        dbg(`incrementRetry #${id} → status=pending (reset), next_retry in ${nextRetryAtMs}ms`);
    } else {
        dbg(`incrementRetry #${id} → status=pending (reset)`);
    }
    const { rows } = await db.query(
        `UPDATE gis.raster_ingest_jobs
         SET retry_count   = retry_count + 1,
             status        = 'pending',
             progress      = 0,
             next_retry_at = $2
         WHERE id = $1
         RETURNING ${COLUMNS}`,
        [id, nextRetryAtMs ? new Date(Date.now() + nextRetryAtMs) : null],
    );
    return rows[0] || null;
}

async function saveOutput(id, {
    minioBucket, minioKey, fileSizeBytes, fileSha256,
    geoserverStore, geoserverLayer, layerId,
}) {
    const q = `
        UPDATE gis.raster_ingest_jobs
        SET minio_bucket    = COALESCE($2, minio_bucket),
            minio_key       = COALESCE($3, minio_key),
            file_size_bytes = COALESCE($4, file_size_bytes),
            file_sha256     = COALESCE($5, file_sha256),
            geoserver_store = COALESCE($6, geoserver_store),
            geoserver_layer = COALESCE($7, geoserver_layer),
            layer_id        = COALESCE($8, layer_id)
        WHERE id = $1
        RETURNING ${COLUMNS}
    `;
    const { rows } = await db.query(q, [
        id, minioBucket || null, minioKey || null,
        fileSizeBytes ?? null, fileSha256 || null,
        geoserverStore || null, geoserverLayer || null, layerId ?? null,
    ]);
    return rows[0] || null;
}

// ── Worker queue: claim với FOR UPDATE SKIP LOCKED ───────────────────────────

/**
 * Claim batch job pending, chuyển sang 'downloading' + started_at = NOW().
 * Trả về array với đầy đủ cột cần cho worker.
 *
 * MAX_RETRIES cấm claim job đã retry vượt ngưỡng — worker set 'failed' riêng
 * khi phát hiện, ở đây chỉ tránh loop vô hạn.
 */
async function claimPending({ batchSize, maxRetries }) {
    const { rows } = await db.query(
        `UPDATE gis.raster_ingest_jobs
         SET status = 'downloading', started_at = NOW()
         WHERE id IN (
             SELECT id FROM gis.raster_ingest_jobs
             WHERE status = 'pending'
               AND retry_count <= $2
               AND (next_retry_at IS NULL OR next_retry_at <= NOW())
             ORDER BY created_at ASC
             LIMIT $1
             FOR UPDATE SKIP LOCKED
         )
         RETURNING ${COLUMNS}`,
        [batchSize, maxRetries],
    );
    if (rows.length && DEBUG) {
        dbg(`claimPending → ${rows.length} job(s): ${rows.map((r) => `#${r.id}(retry=${r.retry_count})`).join(', ')}`);
    }
    return rows;
}

module.exports = {
    insertJob,
    findActiveBySourceHash,
    findById,
    listByLayerCode,
    updateStatus,
    incrementRetry,
    saveOutput,
    claimPending,
};
