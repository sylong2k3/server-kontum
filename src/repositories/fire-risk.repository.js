'use strict';

const db = require('../configs/database');

// ── Snapshots ─────────────────────────────────────────────────────────────────

/**
 * Tạo snapshot mới với trạng thái 'pending'.
 * Nếu đã có snapshot cho analysis_date đó → cập nhật thay vì tạo mới.
 */
const upsertSnapshot = async ({
    analysis_date,
    status = 'pending',
    model_params = {},
    province_summary = null,
    district_stats = null,
    p_nesterov_stats = null,
    s2_coverage_ratio = null,
    gee_task_id = null,
    minio_key = null,
    geoserver_layer = null,
    geoserver_store = null,
    error_message = null,
    computed_at = null,
    published_at = null,
}) => {
    const { rows } = await db.query(
        `INSERT INTO fire.fire_risk_snapshots
            (analysis_date, status, model_params, province_summary, district_stats,
             p_nesterov_stats, s2_coverage_ratio, gee_task_id, minio_key,
             geoserver_layer, geoserver_store, error_message, computed_at, published_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (analysis_date) DO UPDATE SET
            status            = EXCLUDED.status,
            model_params      = EXCLUDED.model_params,
            province_summary  = CASE WHEN EXCLUDED.province_summary  IS NOT NULL THEN EXCLUDED.province_summary  ELSE fire.fire_risk_snapshots.province_summary  END,
            district_stats    = CASE WHEN EXCLUDED.district_stats    IS NOT NULL THEN EXCLUDED.district_stats    ELSE fire.fire_risk_snapshots.district_stats    END,
            p_nesterov_stats  = CASE WHEN EXCLUDED.p_nesterov_stats  IS NOT NULL THEN EXCLUDED.p_nesterov_stats  ELSE fire.fire_risk_snapshots.p_nesterov_stats  END,
            s2_coverage_ratio = COALESCE(EXCLUDED.s2_coverage_ratio, fire.fire_risk_snapshots.s2_coverage_ratio),
            gee_task_id       = COALESCE(EXCLUDED.gee_task_id,       fire.fire_risk_snapshots.gee_task_id),
            minio_key         = COALESCE(EXCLUDED.minio_key,         fire.fire_risk_snapshots.minio_key),
            geoserver_layer   = COALESCE(EXCLUDED.geoserver_layer,   fire.fire_risk_snapshots.geoserver_layer),
            geoserver_store   = COALESCE(EXCLUDED.geoserver_store,   fire.fire_risk_snapshots.geoserver_store),
            error_message     = EXCLUDED.error_message,
            computed_at       = COALESCE(EXCLUDED.computed_at,       fire.fire_risk_snapshots.computed_at),
            published_at      = COALESCE(EXCLUDED.published_at,      fire.fire_risk_snapshots.published_at),
            updated_at        = NOW()
         RETURNING *`,
        [
            analysis_date, status,
            JSON.stringify(model_params),
            province_summary  ? JSON.stringify(province_summary)  : null,
            district_stats    ? JSON.stringify(district_stats)    : null,
            p_nesterov_stats  ? JSON.stringify(p_nesterov_stats)  : null,
            s2_coverage_ratio,
            gee_task_id, minio_key, geoserver_layer, geoserver_store,
            error_message, computed_at, published_at,
        ],
    );
    return rows[0];
};

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

    const { rows } = await db.query(
        `UPDATE fire.fire_risk_snapshots SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
        vals,
    );
    return rows[0] || null;
};

/**
 * Snapshot mới nhất trạng thái 'completed' hoặc 'published'.
 */
const getLatestCompleted = async () => {
    const { rows } = await db.query(
        `SELECT * FROM fire.fire_risk_snapshots
         WHERE status IN ('completed','published')
         ORDER BY analysis_date DESC
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
 */
const listCompleted = async ({ page = 1, limit = 30 } = {}) => {
    const offset = (page - 1) * limit;
    const { rows } = await db.query(
        `SELECT id, analysis_date, status, s2_coverage_ratio,
                province_summary, computed_at, published_at, geoserver_layer,
                COUNT(*) OVER()::int AS total_count
         FROM fire.fire_risk_snapshots
         WHERE status IN ('completed','published')
         ORDER BY analysis_date DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset],
    );

    if (rows.length === 0) {
        let total = 0;
        if (offset > 0) {
            const { rows: cnt } = await db.query(
                `SELECT COUNT(*)::int AS total FROM fire.fire_risk_snapshots
                 WHERE status IN ('completed','published')`,
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
                area_ha, p_nesterov_mean, ndvi_mean, properties,
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

module.exports = {
    upsertSnapshot,
    updateStatus,
    getLatestCompleted,
    getLatest,
    getById,
    listCompleted,
    listExporting,
    deleteOld,
    replaceFeatures,
    getFeatures,
};
