'use strict';

const db = require('../configs/database');

// ── Snapshots ─────────────────────────────────────────────────────────────────

/**
 * Tạo snapshot mới cho analysis_date + attempt tự động tăng.
 *
 * Sau migration 040: (analysis_date, attempt) UNIQUE — mỗi lần chạy refresh
 * tạo ra 1 dòng history mới, KHÔNG ghi đè dòng completed cũ. Attempt được
 * chọn = max(attempt của cùng analysis_date) + 1 (default 1).
 *
 * Fix bug "history bị mất sau khi refresh": trước đây UPSERT flip status =
 * 'computing' + reset province_summary → listCompleted (WHERE status IN
 * ('completed','published')) không thấy dòng đó. Giờ dòng completed cũ vẫn
 * còn, dòng mới đi qua computing → completed riêng biệt.
 */
const createSnapshot = async ({
    analysis_date,
    status = 'pending',
    model_params = {},
    export_scale_m = null,
}) => {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        const { rows: attemptRows } = await client.query(
            `SELECT COALESCE(MAX(attempt), 0) + 1 AS next_attempt
             FROM fire.fire_risk_snapshots
             WHERE analysis_date = $1`,
            [analysis_date],
        );
        const attempt = attemptRows[0].next_attempt;

        const { rows } = await client.query(
            `INSERT INTO fire.fire_risk_snapshots
                (analysis_date, attempt, status, model_params, export_scale_m)
             VALUES ($1, $2, $3, $4, COALESCE($5, 100))
             RETURNING *`,
            [
                analysis_date, attempt, status,
                JSON.stringify(model_params),
                export_scale_m,
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
 * DEPRECATED — giữ để backward-compat cho code cũ có thể còn gọi tới. Trả về
 * `createSnapshot` behavior (tạo dòng mới) thay vì UPSERT như trước. Nên loại
 * dần sau khi mọi caller chuyển sang `createSnapshot`.
 */
const upsertSnapshot = async (params) => createSnapshot(params);

/**
 * Cập nhật status (và error_message) của snapshot theo ID.
 */
const updateStatus = async (id, status, extra = {}) => {
    const sets  = ['status = $2', 'updated_at = NOW()'];
    const vals  = [id, status];
    let   idx   = 3;

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
    addField('s2_coverage_ratio',    extra.s2_coverage_ratio);
    addField('gee_map_id',           extra.gee_map_id);
    addField('gee_tile_url',         extra.gee_tile_url);
    addField('gee_tile_generated_at',extra.gee_tile_generated_at);
    addField('gee_download_url',     extra.gee_download_url);
    addField('gt_zone_count',        extra.gt_zone_count);
    addField('gt_point_count',       extra.gt_point_count);
    addField('gt_window_days',       extra.gt_window_days);
    addField('oob_accuracy',         extra.oob_accuracy);
    addField('next_retry_at',        extra.next_retry_at);
    addField('last_retry_error',     extra.last_retry_error);
    addField('export_scale_m',       extra.export_scale_m);

    if (extra.province_summary !== undefined) {
        sets.push(`province_summary = $${idx++}`);
        vals.push(extra.province_summary ? JSON.stringify(extra.province_summary) : null);
    }
    if (extra.district_stats !== undefined) {
        sets.push(`district_stats = $${idx++}`);
        vals.push(extra.district_stats ? JSON.stringify(extra.district_stats) : null);
    }
    if (extra.p_nesterov_stats !== undefined) {
        sets.push(`p_nesterov_stats = $${idx++}`);
        vals.push(extra.p_nesterov_stats ? JSON.stringify(extra.p_nesterov_stats) : null);
    }
    if (extra.district_export_summary !== undefined) {
        sets.push(`district_export_summary = $${idx++}`);
        vals.push(extra.district_export_summary ? JSON.stringify(extra.district_export_summary) : null);
    }

    const { rows } = await db.query(
        `UPDATE fire.fire_risk_snapshots SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
        vals,
    );
    return rows[0] || null;
};

const scheduleRetry = async (id, delayMs, errorMessage) => {
    const { rows } = await db.query(
        `UPDATE fire.fire_risk_snapshots
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
 * Đếm số attempt failed cho analysis_date (dùng bởi cron retry logic).
 *
 * Sau migration 040 mỗi lần chạy tạo dòng mới (attempt++). retry_count trên
 * từng dòng reset về 0 → không đại diện cho "tổng lần fail hôm nay". Job code
 * dùng COUNT này để giới hạn retry tổng ≤ 3, tránh infinite loop.
 */
const countFailedAttempts = async (analysisDate) => {
    const { rows } = await db.query(
        `SELECT COUNT(*)::int AS n
         FROM fire.fire_risk_snapshots
         WHERE analysis_date = $1 AND status = 'failed'`,
        [analysisDate],
    );
    return rows[0]?.n ?? 0;
};

/**
 * TRUE nếu có ít nhất 1 attempt với status IN ('completed','published','exporting')
 * cho analysis_date đó → dùng bởi watchdog / catch-up để SKIP thay vì trigger
 * run mới. Bao gồm 'exporting' vì stats DB đã hoàn tất, chỉ chờ raster ingest.
 */
const hasCompletedAttempt = async (analysisDate) => {
    const { rows } = await db.query(
        `SELECT 1
         FROM fire.fire_risk_snapshots
         WHERE analysis_date = $1
           AND status IN ('completed','published','exporting')
         LIMIT 1`,
        [analysisDate],
    );
    return rows.length > 0;
};

/**
 * Đếm số attempt completed/published TRƯỚC snapshot này cho cùng analysis_date.
 * Dùng bởi service để dedup notification — chỉ gửi noti lần đầu succeeded/day.
 * Snapshot vừa mới complete tự nó chưa được đếm vì so sánh created_at.
 */
const countPriorCompletedAttempts = async (snapshotId) => {
    const { rows } = await db.query(
        `SELECT COUNT(*)::int AS n
         FROM fire.fire_risk_snapshots s
         JOIN fire.fire_risk_snapshots me ON me.id = $1
         WHERE s.id <> me.id
           AND s.analysis_date = me.analysis_date
           AND s.status IN ('completed','published','exporting')`,
        [snapshotId],
    );
    return rows[0]?.n ?? 0;
};

/**
 * Snapshot mới nhất trạng thái 'completed' hoặc 'published'.
 */
const getLatestCompleted = async () => {
    const { rows } = await db.query(
        `SELECT * FROM fire.fire_risk_snapshots
         WHERE status IN ('completed','published')
         ORDER BY analysis_date DESC, created_at DESC, id DESC
         LIMIT 1`,
    );
    return rows[0] || null;
};

/**
 * Snapshot mới nhất bất kể trạng thái (để hiển thị "đang tính").
 */
const getLatest = async () => {
    const { rows } = await db.query(
        `SELECT * FROM fire.fire_risk_snapshots
         ORDER BY analysis_date DESC, created_at DESC
         LIMIT 1`,
    );
    return rows[0] || null;
};

/**
 * Lấy theo ID.
 */
const getById = async (id) => {
    const { rows } = await db.query(
        'SELECT * FROM fire.fire_risk_snapshots WHERE id = $1',
        [id],
    );
    return rows[0] || null;
};

/**
 * Lấy danh sách snapshots đã hoàn thành (phân trang, mới nhất trước).
 *
 * `hasGeoserverLayer` — filter optional:
 *   true  → chỉ item đã publish GeoServer (geoserver_layer IS NOT NULL)
 *   false → chỉ item chưa publish (geoserver_layer IS NULL)
 *   undefined → tất cả (backward-compat với client cũ)
 * Client browse history to add overlay dùng ?hasGeoserverLayer=true để bỏ item
 * chỉ có GEE URL (TTL 24h) — add rồi vài giờ sau tile 404.
 */
const listCompleted = async ({ page = 1, limit = 30, hasGeoserverLayer } = {}) => {
    const offset = (page - 1) * limit;
    // Build WHERE + params động — pg driver bind theo thứ tự $1, $2, ...
    const whereClauses = [`status IN ('completed','published')`];
    if (hasGeoserverLayer === true)  whereClauses.push('geoserver_layer IS NOT NULL');
    if (hasGeoserverLayer === false) whereClauses.push('geoserver_layer IS NULL');
    const whereSql = whereClauses.join(' AND ');
    const orderSql = 'analysis_date DESC, created_at DESC, id DESC';

    // DISTINCT ON phải chạy trước COUNT/pagination để mỗi ngày chỉ chiếm một
    // item và total phản ánh số ngày, không phải số attempt. WHERE nằm trong
    // subquery để filter GeoServer vẫn chọn attempt mới nhất phù hợp.
    const { rows } = await db.query(
        `SELECT deduped.*,
                COUNT(*) OVER()::int AS total_count
         FROM (
             SELECT DISTINCT ON (analysis_date)
                    id, analysis_date, status, s2_coverage_ratio,
                    province_summary,
                    computed_at, published_at,
                    gee_tile_url, gee_tile_generated_at, gee_download_url,
                    geoserver_layer,
                    error_message
             FROM fire.fire_risk_snapshots
             WHERE ${whereSql}
             ORDER BY ${orderSql}
         ) AS deduped
         ORDER BY analysis_date DESC, id DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset],
    );

    if (rows.length === 0) {
        let total = 0;
        if (offset > 0) {
            const { rows: cnt } = await db.query(
                `SELECT COUNT(DISTINCT analysis_date)::int AS total
                 FROM fire.fire_risk_snapshots
                 WHERE ${whereSql}`,
            );
            total = cnt[0].total;
        }
        return { items: [], total };
    }

    const total = rows[0].total_count;
    const items = rows.map(({ total_count, ...row }) => row);
    return { items, total };
};

/**
 * Snapshot đang ở trạng thái 'exporting' (cần poll GEE task).
 */
const listExporting = async () => {
    const { rows } = await db.query(
        `SELECT * FROM fire.fire_risk_snapshots
         WHERE status = 'exporting' AND gee_task_id IS NOT NULL
         ORDER BY created_at`,
    );
    return rows;
};

/**
 * Xóa snapshots cũ hơn graceDays ngày (không xóa published).
 */
const deleteOld = async (graceDays = 90) => {
    const { rowCount } = await db.query(
        `DELETE FROM fire.fire_risk_snapshots
         WHERE analysis_date < NOW() - ($1 || ' days')::interval
           AND status NOT IN ('published')`,
        [String(graceDays)],
    );
    return rowCount;
};

// ── Features (vector) ─────────────────────────────────────────────────────────

/**
 * Xóa features của snapshot cũ và insert batch mới.
 * features: [{risk_level, district_code, district_name, area_ha,
 *             p_nesterov_mean, ndvi_mean, properties, geojson?}]
 */
const replaceFeatures = async (snapshotId, features) => {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(
            'DELETE FROM fire.fire_risk_features WHERE snapshot_id = $1',
            [snapshotId],
        );

        for (const f of features) {
            await client.query(
                `INSERT INTO fire.fire_risk_features
                    (snapshot_id, risk_level, district_code, district_name,
                     area_ha, p_nesterov_mean, ndvi_mean, properties, geom)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,
                    CASE WHEN $9::text IS NOT NULL
                         THEN ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($9), 4326))
                         ELSE NULL
                    END)`,
                [
                    snapshotId,
                    f.risk_level,
                    f.district_code  || null,
                    f.district_name  || null,
                    f.area_ha        ?? null,
                    f.p_nesterov_mean ?? null,
                    f.ndvi_mean      ?? null,
                    JSON.stringify(f.properties || {}),
                    f.geojson        || null,
                ],
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
 * Lấy features của snapshot (level 4-5 cho map mặc định).
 */
const getFeatures = async (snapshotId, { minLevel = 1 } = {}) => {
    const { rows } = await db.query(
        `SELECT id, risk_level, district_code, district_name,
                area_ha, properties,
                CASE WHEN geom IS NOT NULL
                     THEN ST_AsGeoJSON(geom)::jsonb
                     ELSE NULL
                END AS geometry
         FROM fire.fire_risk_features
         WHERE snapshot_id = $1 AND risk_level >= $2
         ORDER BY risk_level DESC, area_ha DESC`,
        [snapshotId, minLevel],
    );
    return rows;
};

// ── District exports (migration 040) ──────────────────────────────────────────
// Track per-district GEE download URL + area stats. Aggregation lên tỉnh =
// SUM(total_area_ha). Mỗi row có state riêng để không kéo theo snapshot fail
// khi 1 huyện lỗi.

const insertDistrictExports = async (snapshotId, districts, scaleM = 150) => {
    if (!Array.isArray(districts) || districts.length === 0) return [];
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(
            'DELETE FROM fire.fire_risk_district_exports WHERE snapshot_id = $1',
            [snapshotId],
        );
        const inserted = [];
        for (const d of districts) {
            const { rows } = await client.query(
                `INSERT INTO fire.fire_risk_district_exports
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
    add('area_stats',            patch.area_stats, true);
    add('total_area_ha',         patch.total_area_ha);
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
        `UPDATE fire.fire_risk_district_exports SET ${sets.join(', ')}
         WHERE id = $1 RETURNING *`,
        vals,
    );
    return rows[0] || null;
};

const listDistrictExports = async (snapshotId) => {
    const { rows } = await db.query(
        `SELECT * FROM fire.fire_risk_district_exports
         WHERE snapshot_id = $1
         ORDER BY district_name, id`,
        [snapshotId],
    );
    return rows;
};

module.exports = {
    createSnapshot,
    upsertSnapshot,
    updateStatus,
    scheduleRetry,
    countFailedAttempts,
    hasCompletedAttempt,
    countPriorCompletedAttempts,
    getLatestCompleted,
    getLatest,
    getById,
    listCompleted,
    listExporting,
    deleteOld,
    replaceFeatures,
    getFeatures,
    // District exports (migration 040)
    insertDistrictExports,
    updateDistrictExport,
    listDistrictExports,
};
