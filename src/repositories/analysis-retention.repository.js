'use strict';

const db = require('../configs/database');

const TERMINAL_STATUSES_SQL = "'completed','published','failed','cancelled'";

const listFireCandidates = async ({ retentionDays, limit }) => {
    const { rows } = await db.query(
        `SELECT id, analysis_date::text AS period
         FROM fire.fire_risk_snapshots
         WHERE analysis_date < CURRENT_DATE - $1::integer
           AND status IN (${TERMINAL_STATUSES_SQL})
           AND id <> COALESCE((
               SELECT id
               FROM fire.fire_risk_snapshots
               WHERE status IN ('completed','published')
               ORDER BY analysis_date DESC, attempt DESC, id DESC
               LIMIT 1
           ), -1)
         ORDER BY analysis_date ASC, attempt ASC, id ASC
         LIMIT $2`,
        [retentionDays, limit],
    );
    return rows;
};

const listForestCandidates = async ({ retentionMonths, limit }) => {
    const { rows } = await db.query(
        `SELECT id, CONCAT(year, '-', LPAD(month::text, 2, '0')) AS period
         FROM forest.forest_snapshots
         WHERE make_date(year, month, 1)
                   < date_trunc('month', CURRENT_DATE) - ($1::text || ' months')::interval
           AND status IN (${TERMINAL_STATUSES_SQL})
           AND id <> COALESCE((
               SELECT id
               FROM forest.forest_snapshots
               WHERE status IN ('completed','published')
               ORDER BY year DESC, month DESC, attempt DESC, id DESC
               LIMIT 1
           ), -1)
         ORDER BY year ASC, month ASC, attempt ASC, id ASC
         LIMIT $2`,
        [retentionMonths, limit],
    );
    return rows;
};

const listArtifacts = async (kind, snapshotId) => {
    const isFire = kind === 'fire-risk';
    const snapshotTable = isFire
        ? 'fire.fire_risk_snapshots'
        : 'forest.forest_snapshots';
    const districtTable = isFire
        ? 'fire.fire_risk_district_exports'
        : 'forest.forest_district_exports';
    const linkedTypes = isFire
        ? ['fire_risk', 'fire_risk_district']
        : ['forest', 'forest_classification', 'forest_district'];

    const { rows } = await db.query(
        `WITH linked_jobs AS (
             SELECT DISTINCT j.id
             FROM gis.raster_ingest_jobs j
             LEFT JOIN ${districtTable} d
                    ON d.snapshot_id = $1
                   AND d.raster_ingest_job_id = j.id
             WHERE d.id IS NOT NULL
                OR (
                    j.request_params #>> '{linkedResource,id}' = $1::text
                    AND j.request_params #>> '{linkedResource,type}' = ANY($2::text[])
                )
         )
         SELECT j.id AS job_id,
                j.layer_id,
                j.status AS job_status,
                j.minio_bucket,
                j.minio_key,
                j.geoserver_store,
                j.geoserver_layer
         FROM gis.raster_ingest_jobs j
         JOIN linked_jobs x ON x.id = j.id
         UNION ALL
         SELECT NULL::bigint AS job_id,
                NULL::integer AS layer_id,
                NULL::varchar AS job_status,
                NULL::varchar AS minio_bucket,
                s.minio_key,
                s.geoserver_store,
                s.geoserver_layer
         FROM ${snapshotTable} s
         WHERE s.id = $1
           AND (
               s.minio_key IS NOT NULL
               OR s.geoserver_store IS NOT NULL
               OR s.geoserver_layer IS NOT NULL
           )`,
        [snapshotId, linkedTypes],
    );
    return rows;
};

const deleteSnapshot = async ({ kind, snapshotId, jobIds, layerIds }) => {
    const snapshotTable = kind === 'fire-risk'
        ? 'fire.fire_risk_snapshots'
        : 'forest.forest_snapshots';
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        const locked = await client.query(
            `SELECT status FROM ${snapshotTable} WHERE id = $1 FOR UPDATE`,
            [snapshotId],
        );
        if (!locked.rows[0]) {
            await client.query('ROLLBACK');
            return false;
        }
        if (!['completed', 'published', 'failed', 'cancelled'].includes(locked.rows[0].status)) {
            throw new Error(`Snapshot #${snapshotId} is active (${locked.rows[0].status}).`);
        }

        if (layerIds.length > 0) {
            await client.query(
                `UPDATE gis.layer_registry
                 SET is_active = false,
                     is_public = false,
                     geoserver_layer = NULL,
                     geoserver_store = NULL,
                     raster_ingest_job_id = NULL,
                     deleted_at = COALESCE(deleted_at, NOW()),
                     updated_at = NOW()
                 WHERE id = ANY($1::integer[])`,
                [layerIds],
            );
        }

        if (jobIds.length > 0) {
            const activeJobs = await client.query(
                `SELECT id, status
                 FROM gis.raster_ingest_jobs
                 WHERE id = ANY($1::bigint[])
                   AND status NOT IN ('completed','failed','cancelled')
                 FOR UPDATE`,
                [jobIds],
            );
            if (activeJobs.rows.length > 0) {
                throw new Error(
                    `Snapshot #${snapshotId} still has active raster jobs: ` +
                    activeJobs.rows.map((row) => `#${row.id}:${row.status}`).join(', '),
                );
            }
        }

        await client.query(`DELETE FROM ${snapshotTable} WHERE id = $1`, [snapshotId]);

        if (jobIds.length > 0) {
            await client.query(
                'DELETE FROM gis.raster_ingest_jobs WHERE id = ANY($1::bigint[])',
                [jobIds],
            );
        }
        await client.query('COMMIT');
        return true;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
};

module.exports = {
    listFireCandidates,
    listForestCandidates,
    listArtifacts,
    deleteSnapshot,
};
