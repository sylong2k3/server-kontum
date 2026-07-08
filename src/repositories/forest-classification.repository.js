'use strict';

const db = require('../configs/database');

// ── Snapshots ─────────────────────────────────────────────────────────────────

const upsertSnapshot = async ({
    year,
    month,
    status         = 'pending',
    trigger        = 'cron',
    requested_by   = null,
    model_params   = {},
    province_summary = null,
    oob_accuracy   = null,
    s2_image_count = null,
    ls_image_count = null,
    gee_task_id    = null,
    minio_key      = null,
    geoserver_layer = null,
    geoserver_store = null,
    error_message  = null,
    computed_at    = null,
    published_at   = null,
}) => {
    const { rows } = await db.query(
        `INSERT INTO forest.forest_snapshots
            (year, month, status, trigger, requested_by, model_params,
             province_summary, oob_accuracy, s2_image_count, ls_image_count,
             gee_task_id, minio_key, geoserver_layer, geoserver_store,
             error_message, computed_at, published_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         ON CONFLICT (year, month) DO UPDATE SET
            status           = EXCLUDED.status,
            trigger          = EXCLUDED.trigger,
            requested_by     = COALESCE(EXCLUDED.requested_by, forest.forest_snapshots.requested_by),
            model_params     = EXCLUDED.model_params,
            province_summary = CASE WHEN EXCLUDED.province_summary IS NOT NULL
                               THEN EXCLUDED.province_summary
                               ELSE forest.forest_snapshots.province_summary END,
            oob_accuracy     = COALESCE(EXCLUDED.oob_accuracy,     forest.forest_snapshots.oob_accuracy),
            s2_image_count   = COALESCE(EXCLUDED.s2_image_count,   forest.forest_snapshots.s2_image_count),
            ls_image_count   = COALESCE(EXCLUDED.ls_image_count,   forest.forest_snapshots.ls_image_count),
            gee_task_id      = COALESCE(EXCLUDED.gee_task_id,      forest.forest_snapshots.gee_task_id),
            minio_key        = COALESCE(EXCLUDED.minio_key,        forest.forest_snapshots.minio_key),
            geoserver_layer  = COALESCE(EXCLUDED.geoserver_layer,  forest.forest_snapshots.geoserver_layer),
            geoserver_store  = COALESCE(EXCLUDED.geoserver_store,  forest.forest_snapshots.geoserver_store),
            error_message    = EXCLUDED.error_message,
            computed_at      = COALESCE(EXCLUDED.computed_at,      forest.forest_snapshots.computed_at),
            published_at     = COALESCE(EXCLUDED.published_at,     forest.forest_snapshots.published_at),
            updated_at       = NOW()
         RETURNING *`,
        [
            year, month, status, trigger, requested_by,
            JSON.stringify(model_params),
            province_summary ? JSON.stringify(province_summary) : null,
            oob_accuracy, s2_image_count, ls_image_count,
            gee_task_id, minio_key, geoserver_layer, geoserver_store,
            error_message, computed_at, published_at,
        ],
    );
    return rows[0];
};

const updateStatus = async (id, status, extra = {}) => {
    const sets = ['status = $2', 'updated_at = NOW()'];
    const vals = [id, status];
    let   idx  = 3;

    const addField = (col, val) => {
        if (val !== undefined) {
            sets.push(`${col} = $${idx++}`);
            vals.push(val ?? null);
        }
    };

    addField('error_message',   extra.error_message);
    addField('computed_at',     extra.computed_at);
    addField('published_at',    extra.published_at);
    addField('gee_task_id',     extra.gee_task_id);
    addField('minio_key',       extra.minio_key);
    addField('geoserver_layer', extra.geoserver_layer);
    addField('geoserver_store', extra.geoserver_store);
    addField('oob_accuracy',    extra.oob_accuracy);
    addField('s2_image_count',  extra.s2_image_count);
    addField('ls_image_count',  extra.ls_image_count);
    addField('duration_ms',     extra.duration_ms);

    if (extra.province_summary !== undefined) {
        sets.push(`province_summary = $${idx++}`);
        vals.push(extra.province_summary ? JSON.stringify(extra.province_summary) : null);
    }

    const { rows } = await db.query(
        `UPDATE forest.forest_snapshots SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
        vals,
    );
    return rows[0] || null;
};

const getById = async (id) => {
    const { rows } = await db.query(
        'SELECT * FROM forest.forest_snapshots WHERE id = $1',
        [id],
    );
    return rows[0] || null;
};

const getLatestCompleted = async () => {
    const { rows } = await db.query(
        `SELECT * FROM forest.forest_snapshots
         WHERE status IN ('completed','published')
         ORDER BY year DESC, month DESC
         LIMIT 1`,
    );
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

const listCompleted = async ({ page = 1, limit = 24 } = {}) => {
    const offset = (page - 1) * limit;
    const { rows } = await db.query(
        `SELECT id, year, month, status, trigger, oob_accuracy, s2_image_count,
                ls_image_count, duration_ms, province_summary, computed_at, published_at,
                geoserver_layer
         FROM forest.forest_snapshots
         WHERE status IN ('completed','published')
         ORDER BY year DESC, month DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset],
    );
    const { rows: cnt } = await db.query(
        `SELECT COUNT(*) AS total FROM forest.forest_snapshots
         WHERE status IN ('completed','published')`,
    );
    return { items: rows, total: parseInt(cnt[0].total, 10) };
};

/**
 * Admin: list ALL runs (all statuses), with optional status filter.
 * Returns timing, trigger, requester, errors — full audit view.
 */
const listAll = async ({ page = 1, limit = 24, status = null } = {}) => {
    const offset = (page - 1) * limit;
    const params = [limit, offset];
    let where = '';
    if (status) { where = 'WHERE status = $3'; params.push(status); }

    const { rows } = await db.query(
        `SELECT id, year, month, status, trigger, requested_by,
                oob_accuracy, s2_image_count, ls_image_count, duration_ms,
                province_summary, geoserver_layer,
                error_message, computed_at, published_at,
                created_at, updated_at
         FROM forest.forest_snapshots
         ${where}
         ORDER BY year DESC, month DESC, created_at DESC
         LIMIT $1 OFFSET $2`,
        params,
    );

    const cntParams = status ? [status] : [];
    const cntWhere  = status ? 'WHERE status = $1' : '';
    const { rows: cnt } = await db.query(
        `SELECT COUNT(*) AS total FROM forest.forest_snapshots ${cntWhere}`,
        cntParams,
    );

    return { items: rows, total: parseInt(cnt[0].total, 10) };
};

const listExporting = async () => {
    const { rows } = await db.query(
        `SELECT * FROM forest.forest_snapshots
         WHERE status = 'exporting' AND gee_task_id IS NOT NULL
         ORDER BY created_at`,
    );
    return rows;
};

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

module.exports = {
    upsertSnapshot,
    updateStatus,
    getById,
    getLatestCompleted,
    getLatest,
    getByYearMonth,
    listCompleted,
    listAll,
    listExporting,
    replaceDistrictAreas,
    getDistrictAreas,
    getPreviousCompleted,
};
