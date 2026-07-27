'use strict';

const db = require('../configs/database');
const cfg = require('../configs/forest-classification');

// Debug — FC_DEBUG=true (hoặc NODE_ENV=development) → in `[FOREST-REPO:DBG] ...`
// cho các query. Info/warn/error luôn ghi bất kể flag.
const DEBUG = process.env.FC_DEBUG === 'true'
    || process.env.NODE_ENV === 'development';
const dbg = (tag, msg) => { if (DEBUG) console.debug(`[FOREST-REPO:DBG:${tag}] ${msg}`); };

// ── Snapshots ─────────────────────────────────────────────────────────────────

/**
 * Tạo snapshot mới cho (year, month) — attempt tự động tăng.
 *
 * Sau migration 040: (year, month, attempt) UNIQUE. Mỗi refresh tạo ra 1 dòng
 * history mới, KHÔNG ghi đè dòng completed cũ. Fix bug "history reload lại bị
 * mất": trước đây UPSERT flip status = 'computing' → listCompleted không thấy
 * dòng đó trong ~5-15 phút cron chạy, hoặc mất vĩnh viễn khi run fail.
 */
const createSnapshot = async ({
    year,
    month,
    status         = 'pending',
    trigger        = 'cron',
    requested_by   = null,
    model_params   = {},
    download_scale_m = null,
}) => {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        const { rows: attemptRows } = await client.query(
            `SELECT COALESCE(MAX(attempt), 0) + 1 AS next_attempt
             FROM forest.forest_snapshots
             WHERE year = $1 AND month = $2`,
            [year, month],
        );
        const attempt = attemptRows[0].next_attempt;

        const { rows } = await client.query(
            `INSERT INTO forest.forest_snapshots
                (year, month, attempt, status, trigger, requested_by,
                 model_params, download_scale_m)
             VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, 100))
             RETURNING *`,
            [
                year, month, attempt, status, trigger, requested_by,
                JSON.stringify(model_params),
                download_scale_m,
            ],
        );
        await client.query('COMMIT');
        return rows[0];
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
};

/**
 * DEPRECATED — backward-compat shim. Chuyển hướng sang `createSnapshot` để
 * mọi UPSERT cũ giờ đây tạo attempt mới thay vì overwrite.
 */
const upsertSnapshot = async (params) => createSnapshot(params);

const updateStatus = async (id, status, extra = {}) => {
    // Debug — chỉ log key/value flag để tránh spam JSON dài. Đủ để trace việc
    // set geoserver_layer (back-link) hoặc chuyển state (computing→completed).
    if (DEBUG) {
        const keys = Object.keys(extra).filter((k) => extra[k] !== undefined);
        dbg('updateStatus', `id=${id} status=${status} fields=[${keys.join(',')}] ` +
            (extra.geoserver_layer ? `layer=${extra.geoserver_layer} ` : '') +
            (extra.error_message ? `err="${String(extra.error_message).slice(0, 80)}"` : ''));
    }
    const sets = ['status = $2', 'updated_at = NOW()'];
    const vals = [id, status];
    let   idx  = 3;

    const addField = (col, val) => {
        if (val !== undefined) {
            sets.push(`${col} = $${idx++}`);
            vals.push(val ?? null);
        }
    };

    addField('error_message',        extra.error_message);
    addField('computed_at',          extra.computed_at);
    addField('published_at',         extra.published_at);
    addField('gee_task_id',          extra.gee_task_id);
    addField('minio_key',            extra.minio_key);
    addField('geoserver_layer',      extra.geoserver_layer);
    addField('geoserver_store',      extra.geoserver_store);
    addField('oob_accuracy',         extra.oob_accuracy);
    addField('test_accuracy',        extra.test_accuracy);
    addField('test_kappa',           extra.test_kappa);
    addField('s2_image_count',       extra.s2_image_count);
    addField('ls_image_count',       extra.ls_image_count);
    addField('duration_ms',          extra.duration_ms);
    addField('gee_map_id',           extra.gee_map_id);
    addField('gee_tile_url',         extra.gee_tile_url);
    addField('gee_tile_generated_at',extra.gee_tile_generated_at);
    addField('gee_download_url',     extra.gee_download_url);
    addField('gt_zone_count',        extra.gt_zone_count);
    addField('gt_point_count',       extra.gt_point_count);
    addField('gt_window_days',       extra.gt_window_days);
    addField('next_retry_at',        extra.next_retry_at);
    addField('last_retry_error',     extra.last_retry_error);
    addField('download_scale_m',     extra.download_scale_m);

    if (extra.province_summary !== undefined) {
        sets.push(`province_summary = $${idx++}`);
        vals.push(extra.province_summary ? JSON.stringify(extra.province_summary) : null);
    }

    if (extra.sample_quotas !== undefined) {
        sets.push(`sample_quotas = $${idx++}`);
        vals.push(extra.sample_quotas ? JSON.stringify(extra.sample_quotas) : null);
    }

    if (extra.district_export_summary !== undefined) {
        sets.push(`district_export_summary = $${idx++}`);
        vals.push(extra.district_export_summary ? JSON.stringify(extra.district_export_summary) : null);
    }

    const { rows } = await db.query(
        `UPDATE forest.forest_snapshots SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
        vals,
    );
    return rows[0] || null;
};

const scheduleRetry = async (id, delayMs, errorMessage) => {
    const { rows } = await db.query(
        `UPDATE forest.forest_snapshots
         SET retry_count = retry_count + 1,
             next_retry_at = NOW() + ($2 * INTERVAL '1 millisecond'),
             last_retry_error = $3,
             updated_at = NOW()
         WHERE id = $1 AND retry_count < 3
         RETURNING *`,
        [id, delayMs, String(errorMessage || '').slice(0, 4000)],
    );
    return rows[0] || null;
};

/**
 * Đếm số attempt failed cho (year, month) — dùng bởi cron retry logic sau
 * migration 040. Mỗi attempt là dòng riêng nên retry_count trên 1 dòng không
 * còn đại diện cho tổng lần fail của kỳ đó.
 */
const countFailedAttempts = async (year, month) => {
    const { rows } = await db.query(
        `SELECT COUNT(*)::int AS n
         FROM forest.forest_snapshots
         WHERE year = $1 AND month = $2 AND status = 'failed'`,
        [year, month],
    );
    return rows[0]?.n ?? 0;
};

/**
 * TRUE nếu (year, month) đã có attempt thành công (completed/published/exporting).
 * Dùng để watchdog SKIP thay vì trigger run mới.
 */
const hasCompletedAttempt = async (year, month) => {
    const { rows } = await db.query(
        `SELECT 1
         FROM forest.forest_snapshots
         WHERE year = $1 AND month = $2
           AND status IN ('completed','published','exporting')
         LIMIT 1`,
        [year, month],
    );
    return rows.length > 0;
};

/**
 * Đếm số attempt completed trước snapshot này cho cùng (year, month). Dùng
 * dedup notification — chỉ gửi noti lần đầu succeeded/kỳ.
 */
const countPriorCompletedAttempts = async (snapshotId) => {
    const { rows } = await db.query(
        `SELECT COUNT(*)::int AS n
         FROM forest.forest_snapshots s
         JOIN forest.forest_snapshots me ON me.id = $1
         WHERE s.id <> me.id
           AND s.year = me.year AND s.month = me.month
           AND s.status IN ('completed','published','exporting')`,
        [snapshotId],
    );
    return rows[0]?.n ?? 0;
};

const getById = async (id) => {
    const { rows } = await db.query(
        'SELECT * FROM forest.forest_snapshots WHERE id = $1',
        [id],
    );
    return rows[0] || null;
};

const getLatestCompleted = async () => {
    const t0 = Date.now();
    const { rows } = await db.query(
        `SELECT * FROM forest.forest_snapshots
         WHERE status IN ('completed','published')
         ORDER BY year DESC, month DESC, created_at DESC, id DESC
         LIMIT 1`,
    );
    if (DEBUG) {
        const r = rows[0];
        console.debug(
            `[FOREST-REPO:DBG:getLatestCompleted] (${Date.now() - t0}ms) → ` +
            (r ? `id=${r.id} y/m=${r.year}/${r.month} status=${r.status} ` +
                 `hasLayer=${Boolean(r.geoserver_layer)} hasDlUrl=${Boolean(r.gee_download_url)}` : 'null'),
        );
    }
    return rows[0] || null;
};

const getLatest = async () => {
    const { rows } = await db.query(
        `SELECT * FROM forest.forest_snapshots
         ORDER BY year DESC, month DESC, created_at DESC
         LIMIT 1`,
    );
    return rows[0] || null;
};

const getByYearMonth = async (year, month) => {
    const { rows } = await db.query(
        'SELECT * FROM forest.forest_snapshots WHERE year = $1 AND month = $2',
        [year, month],
    );
    return rows[0] || null;
};

/**
 * List snapshots đã completed. Mirror fire-risk repo:
 *   hasGeoserverLayer=true  → chỉ item đã publish GeoServer (client browse
 *                              để add overlay WMS so sánh liên tháng).
 *   hasGeoserverLayer=false → chỉ item chưa publish (admin xem để trigger).
 *   undefined → tất cả (backward-compat).
 */
const listCompleted = async ({
    page = 1,
    limit = 24,
    hasGeoserverLayer,
    requireCompleteDistrictSet = false,
} = {}) => {
    const t0 = Date.now();
    const offset = (page - 1) * limit;
    const whereClauses = [`s.status IN ('completed','published')`];
    const completeDistrictSetSql = `(
        COALESCE(dp.district_total, 0) = ${cfg.EXPECTED_DISTRICT_COUNT}
        AND COALESCE(dp.district_code_count, 0) = ${cfg.EXPECTED_DISTRICT_COUNT}
        AND COALESCE(dp.district_ready_count, 0) = ${cfg.EXPECTED_DISTRICT_COUNT}
    )`;
    const stableRasterSql = `(
        s.geoserver_layer IS NOT NULL
        OR ${completeDistrictSetSql}
    )`;
    if (requireCompleteDistrictSet) {
        whereClauses.push(completeDistrictSetSql);
    } else if (hasGeoserverLayer === true) {
        whereClauses.push(stableRasterSql);
    }
    if (hasGeoserverLayer === false) whereClauses.push(`NOT ${stableRasterSql}`);
    const whereSql = whereClauses.join(' AND ');
    const orderSql = 's.year DESC, s.month DESC, s.created_at DESC, s.id DESC';
    dbg('listCompleted', `page=${page} limit=${limit} filter=${hasGeoserverLayer ?? 'all'} WHERE=${whereSql}`);

    const districtPublishJoin = `
        LEFT JOIN LATERAL (
            SELECT
                COUNT(*)::int AS district_total,
                COUNT(DISTINCT NULLIF(BTRIM(d.district_code), ''))::int
                    AS district_code_count,
                (COUNT(*) FILTER (
                    WHERE NULLIF(BTRIM(d.minio_key), '') IS NOT NULL
                       OR (
                           d.gee_download_url ~* '^https?://[^[:space:]]+$'
                           AND COALESCE(d.gee_generated_at, d.completed_at, d.updated_at)
                               >= NOW() - (
                                   ${cfg.GEE_TEMPORARY_URL_MAX_AGE_MS}
                                   * INTERVAL '1 millisecond'
                               )
                       )
                ))::int AS district_source_count,
                (COUNT(*) FILTER (
                    WHERE NULLIF(BTRIM(d.geoserver_layer), '') IS NOT NULL
                ))::int AS district_geoserver_count,
                (COUNT(*) FILTER (
                    WHERE NULLIF(BTRIM(d.geoserver_layer), '') IS NOT NULL
                      AND NULLIF(BTRIM(d.minio_key), '') IS NOT NULL
                ))::int AS district_ready_count,
                COALESCE(
                    ARRAY_AGG(d.geoserver_layer ORDER BY d.district_name, d.id)
                        FILTER (WHERE NULLIF(BTRIM(d.geoserver_layer), '') IS NOT NULL),
                    ARRAY[]::text[]
                ) AS geoserver_layers
            FROM forest.forest_district_exports d
            WHERE d.snapshot_id = s.id
        ) dp ON TRUE`;

    // Khử trùng attempt theo kỳ trước khi COUNT/pagination. DISTINCT ON chọn
    // attempt completed/published mới nhất của từng (year, month).
    const { rows } = await db.query(
        `SELECT deduped.*,
                COUNT(*) OVER()::int AS total_count
         FROM (
             SELECT DISTINCT ON (s.year, s.month)
                    s.id, s.year, s.month, s.status, s.oob_accuracy,
                    s.duration_ms, s.province_summary, s.computed_at, s.published_at,
                    s.gee_tile_url, s.gee_tile_generated_at, s.gee_download_url,
                    s.geoserver_layer, s.error_message,
                    COALESCE(dp.district_total, 0) AS district_total,
                    COALESCE(dp.district_code_count, 0) AS district_code_count,
                    COALESCE(dp.district_source_count, 0) AS district_source_count,
                    COALESCE(dp.district_geoserver_count, 0) AS district_geoserver_count,
                    COALESCE(dp.district_ready_count, 0) AS district_ready_count,
                    COALESCE(dp.geoserver_layers, ARRAY[]::text[]) AS geoserver_layers
             FROM forest.forest_snapshots s
             ${districtPublishJoin}
             WHERE ${whereSql}
             ORDER BY ${orderSql}
         ) AS deduped
         ORDER BY year DESC, month DESC, id DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset],
    );

    if (rows.length === 0) {
        let total = 0;
        if (offset > 0) {
            const { rows: cnt } = await db.query(
                `SELECT COUNT(*)::int AS total
                 FROM (
                     SELECT DISTINCT ON (s.year, s.month) s.id
                     FROM forest.forest_snapshots s
                     ${districtPublishJoin}
                     WHERE ${whereSql}
                     ORDER BY ${orderSql}
                 ) counted`,
            );
            total = cnt[0].total;
        }
        dbg('listCompleted', `EMPTY result (${Date.now() - t0}ms) total=${total}`);
        return { items: [], total };
    }

    const total = rows[0].total_count;
    const items = rows.map(({ total_count, ...row }) => row);
    const withLayer = items.filter((r) => r.geoserver_layer).length;
    dbg('listCompleted', `(${Date.now() - t0}ms) items=${items.length} total=${total} withGeoLayer=${withLayer}`);
    return { items, total };
};

/**
 * Admin: list ALL runs (all statuses), with optional status filter.
 * Returns timing, trigger, requester, errors — full audit view.
 */
// listExporting() đã BỎ — GCS batch export path không còn dùng (thay bằng
// auto-ingest queue). Nếu về sau cần đọc snapshot status='exporting', dùng
// `getById` hoặc query trực tiếp trong migration.

// ── District area stats ───────────────────────────────────────────────────────

/**
 * Replace all district area rows for a snapshot (transactional).
 * areas: [{ district_code, district_name, class_id, class_name, area_ha }]
 */
const replaceDistrictAreas = async (snapshotId, areas) => {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(
            'DELETE FROM forest.forest_district_areas WHERE snapshot_id = $1',
            [snapshotId],
        );
        for (const a of areas) {
            await client.query(
                `INSERT INTO forest.forest_district_areas
                    (snapshot_id, district_code, district_name, class_id, class_name, area_ha)
                 VALUES ($1,$2,$3,$4,$5,$6)`,
                [snapshotId, a.district_code || null, a.district_name || null,
                 a.class_id, a.class_name, a.area_ha],
            );
        }
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
};

/**
 * District areas for a snapshot, grouped by district.
 * Returns [{ districtCode, districtName, classes: [{ classId, className, areaHa }] }]
 */
const getDistrictAreas = async (snapshotId) => {
    const { rows } = await db.query(
        `SELECT district_code, district_name, class_id, class_name,
                ROUND(area_ha::numeric, 2) AS area_ha
         FROM forest.forest_district_areas
         WHERE snapshot_id = $1
         ORDER BY district_name, class_id`,
        [snapshotId],
    );

    const map = new Map();
    for (const r of rows) {
        const key = r.district_code || r.district_name;
        if (!map.has(key)) {
            map.set(key, { districtCode: r.district_code, districtName: r.district_name, classes: [] });
        }
        map.get(key).classes.push({
            classId:   r.class_id,
            className: r.class_name,
            areaHa:    parseFloat(r.area_ha),
        });
    }
    return [...map.values()];
};

/**
 * Danh sách năm có ít nhất 1 snapshot completed. Dùng cho dropdown năm ở
 * trang /statistics (thay thế landcover_statistics.getAvailableYears sau
 * migration 041).
 */
const getSnapshotYears = async () => {
    const { rows } = await db.query(
        `SELECT DISTINCT year
         FROM forest.forest_snapshots
         WHERE status IN ('completed','published','exporting')
         ORDER BY year DESC`,
    );
    return rows.map((r) => r.year);
};

/**
 * Snapshot completed mới nhất trong 1 năm (tháng lớn nhất có completed).
 * Dùng để lấy "hiện trạng cuối năm" cho endpoint /statistics/landcover.
 */
const getLatestCompletedByYear = async (year) => {
    const { rows } = await db.query(
        `SELECT * FROM forest.forest_snapshots
         WHERE year = $1
           AND status IN ('completed','published','exporting')
         ORDER BY month DESC, created_at DESC
         LIMIT 1`,
        [year],
    );
    return rows[0] || null;
};

/**
 * Previous completed snapshot before year/month, for area-change detection.
 */
const getPreviousCompleted = async (year, month) => {
    const { rows } = await db.query(
        `SELECT * FROM forest.forest_snapshots
         WHERE status IN ('completed','published')
           AND (year < $1 OR (year = $1 AND month < $2))
         ORDER BY year DESC, month DESC
         LIMIT 1`,
        [year, month],
    );
    return rows[0] || null;
};

// ── District exports (migration 040) ──────────────────────────────────────────
// Track per-district GEE download + area stats. Snapshot completed = SUM area
// từ tất cả district_export rows completed. Nếu 1 huyện fail, snapshot vẫn
// completed (partial coverage) — không kéo theo toàn bộ.

const insertDistrictExports = async (snapshotId, districts, scaleM = 150) => {
    if (!Array.isArray(districts) || districts.length === 0) return [];
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(
            'DELETE FROM forest.forest_district_exports WHERE snapshot_id = $1',
            [snapshotId],
        );
        const inserted = [];
        for (const d of districts) {
            const { rows } = await client.query(
                `INSERT INTO forest.forest_district_exports
                    (snapshot_id, district_code, district_name, scale_m, status)
                 VALUES ($1, $2, $3, $4, 'pending')
                 RETURNING *`,
                [snapshotId, d.district_code || null, d.district_name || null, scaleM],
            );
            inserted.push(rows[0]);
        }
        await client.query('COMMIT');
        return inserted;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
};

const updateDistrictExport = async (id, patch) => {
    const sets = ['updated_at = NOW()'];
    const vals = [id];
    let   idx  = 2;
    const add = (col, val, isJson = false) => {
        if (val === undefined) return;
        sets.push(`${col} = $${idx++}`);
        vals.push(isJson && val !== null ? JSON.stringify(val) : (val ?? null));
    };
    add('status',                patch.status);
    add('area_by_class',         patch.area_by_class, true);
    add('total_area_ha',         patch.total_area_ha);
    add('forest_area_ha',        patch.forest_area_ha);
    add('gee_map_id',            patch.gee_map_id);
    add('gee_tile_url',          patch.gee_tile_url);
    add('gee_download_url',      patch.gee_download_url);
    add('gee_download_filename', patch.gee_download_filename);
    add('gee_generated_at',      patch.gee_generated_at);
    add('minio_key',             patch.minio_key);
    add('geoserver_layer',       patch.geoserver_layer);
    add('geoserver_store',       patch.geoserver_store);
    add('raster_ingest_job_id',  patch.raster_ingest_job_id);
    add('error_message',         patch.error_message);
    add('duration_ms',           patch.duration_ms);
    add('started_at',            patch.started_at);
    add('completed_at',          patch.completed_at);

    const { rows } = await db.query(
        `UPDATE forest.forest_district_exports SET ${sets.join(', ')}
         WHERE id = $1 RETURNING *`,
        vals,
    );
    return rows[0] || null;
};

const listDistrictExports = async (snapshotId) => {
    const { rows } = await db.query(
        `SELECT d.*,
                j.status          AS ingest_job_status,
                j.error_log       AS ingest_job_error,
                j.request_params  AS ingest_request_params,
                j.geoserver_layer AS ingest_geoserver_layer,
                j.geoserver_store AS ingest_geoserver_store,
                j.minio_bucket    AS ingest_minio_bucket,
                j.minio_key       AS ingest_minio_key
         FROM forest.forest_district_exports d
         LEFT JOIN gis.raster_ingest_jobs j ON j.id = d.raster_ingest_job_id
         WHERE d.snapshot_id = $1
         ORDER BY d.district_name, d.id`,
        [snapshotId],
    );
    return rows;
};

const reconcileDistrictExportArtifacts = async (snapshotId) => {
    const { rows } = await db.query(
        `UPDATE forest.forest_district_exports d
         SET geoserver_layer = COALESCE(
                 NULLIF(BTRIM(d.geoserver_layer), ''),
                 NULLIF(BTRIM(j.geoserver_layer), '')
             ),
             geoserver_store = COALESCE(
                 NULLIF(BTRIM(d.geoserver_store), ''),
                 NULLIF(BTRIM(j.geoserver_store), '')
             ),
             minio_key = COALESCE(
                 NULLIF(BTRIM(d.minio_key), ''),
                 CASE
                     WHEN NULLIF(BTRIM(j.minio_bucket), '') IS NOT NULL
                      AND NULLIF(BTRIM(j.minio_key), '') IS NOT NULL
                     THEN BTRIM(j.minio_bucket) || '/' || BTRIM(j.minio_key)
                     ELSE NULL
                 END
             ),
             updated_at = NOW()
         FROM gis.raster_ingest_jobs j
         WHERE d.snapshot_id = $1
           AND j.id = d.raster_ingest_job_id
           AND j.status = 'completed'
           AND j.request_params #>> '{linkedResource,type}' = 'forest_district'
           AND j.request_params #>> '{linkedResource,id}' = d.snapshot_id::text
           AND j.request_params #>> '{linkedResource,districtCode}' = d.district_code
           AND (
               NULLIF(BTRIM(d.geoserver_layer), '') IS NULL
               OR NULLIF(BTRIM(d.minio_key), '') IS NULL
           )
         RETURNING d.id`,
        [snapshotId],
    );
    return rows.length;
};

const markPublishedIfDistrictsReady = async (
    snapshotId,
    expectedCount = cfg.EXPECTED_DISTRICT_COUNT,
) => {
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
         RETURNING s.*`,
        [snapshotId, expectedCount],
    );
    return rows[0] || null;
};

module.exports = {
    createSnapshot,
    upsertSnapshot,
    updateStatus,
    scheduleRetry,
    countFailedAttempts,
    hasCompletedAttempt,
    countPriorCompletedAttempts,
    getById,
    getLatestCompleted,
    getLatest,
    getByYearMonth,
    listCompleted,
    replaceDistrictAreas,
    getDistrictAreas,
    getPreviousCompleted,
    getSnapshotYears,
    getLatestCompletedByYear,
    // District exports (migration 040)
    insertDistrictExports,
    updateDistrictExport,
    listDistrictExports,
    reconcileDistrictExportArtifacts,
    markPublishedIfDistrictsReady,
};
