'use strict';

/**
 * geo-import.service.js
 * Điều phối luồng import file GIS vector (Shapefile, GeoJSON, KML/KMZ, FileGDB):
 *   Upload file → tạo import job → ogr2ogr → upsert layer_registry
 *   → refreshStats → auto-publish GeoServer
 *
 * Raster GeoTIFF không đi qua đây — upload vào kho viễn thám
 * (POST /remote-sensing/images) rồi publish qua /remote-sensing/images/:id/publish.
 *
 * Tách khỏi map.service.js để giữ SRP.
 */

const fs = require('fs');

const db        = require('../configs/database');
const ogr       = require('../utils/ogr.util');
const geoserver = require('../utils/geoserver.client');
const layerRepo = require('../repositories/map-layer.repository');
const { geoserverConfig } = require('../configs/geoserver');
const { t } = require('../utils/i18n.util');

const GEO_IMPORT_SYNC_MAX_BYTES = Number(process.env.GEO_IMPORT_SYNC_MAX_BYTES || 5 * 1024 * 1024); // 5 MB

const safeUnlink = (filePath) => {
    if (!filePath) { return; }
    try { fs.unlinkSync(filePath); } catch { /* đã xóa hoặc không tồn tại */ }
};


const codeToTableName = (code) =>
    code.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^[^a-z_]/, '_$&');

const enqueueImport = async ({ file, payload, user, lang }) => {
    const code      = payload.code;
    const tableName = payload.table_name || codeToTableName(code);
    const userId    = user?.id || null;

    const client = await db.pool.connect();
    let job;
    try {
        await client.query('BEGIN');

        // Upsert layer trước để có layer_id hợp lệ cho FK của import_jobs.
        // geometry_type='GEOMETRY' là placeholder — runImportJob sẽ cập nhật đúng sau ogr2ogr.
        const layerRow = await layerRepo.upsertLayerByCode(client, {
            code,
            name_vi:        payload.name_vi || code,
            name_en:        payload.name_en || null,
            schema_name:    payload.schema_name || 'gis',
            table_name:     tableName,
            geometry_type:  'GEOMETRY',
            epsg_code:      payload.epsg_code || 4326,
            category:       payload.category || null,
            layer_kind:     payload.layer_kind || 'overlay',
            layer_group:    payload.layer_group || null,
            data_year:      payload.data_year || null,
            source_dataset: payload.source_dataset || null,
            is_active:      true,
            is_public:      payload.is_public ?? false,
            is_editable:    true,
            userId,
        });

        job = await layerRepo.createImportJob(client, {
            layerId:      layerRow.id,
            sourceFormat: payload.source_format,
            importMode:   payload.import_mode,
            sridInput:    payload.srid_input,
            encoding:     'UTF-8',
            strategy:     'all_or_nothing',
            status:       'pending',
            progress:     0,
            sourceInfo: {
                original_name:      file.originalname,
                file_size:          file.size,
                file_path:          file.path,
                code,
                table_name:         tableName,
                source_layer_name:  payload.source_layer_name || null,
                auto_publish:       payload.auto_publish,
                layer_payload:      payload,
            },
            createdBy: userId,
        });
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        safeUnlink(file.path);
        throw err;
    } finally {
        client.release();
    }

    const isSmall = file.size <= GEO_IMPORT_SYNC_MAX_BYTES;

    if (isSmall) {
        // Chạy đồng bộ (không await để không block response)
        runImportJob(job.id, lang).catch((err) =>
            console.error(t('geo_import_sync_job_error', lang, { id: job.id }), err.message)
        );
    }

    return {
        job_id:  job.id,
        code,
        status:  isSmall ? 'processing' : 'pending',
        sync:    isSmall,
    };
};

// ── Chạy job ──────────────────────────────────────────────────────────────────

/**
 * Xử lý một import job.
 * Được gọi từ enqueueImport (sync) hoặc worker (async).
 *
 * @param {number} jobId
 */
const runImportJob = async (jobId, lang = 'vi') => {
    // Lấy job
    const job = await layerRepo.findImportJobById(jobId);
    if (!job) { throw new Error(t('map_geo_import_job_not_found_with_id', lang, { id: jobId })); }
    if (job.status === 'completed' || job.status === 'cancelled') { return; }

    const info     = job.source_info || {};
    const filePath = info.file_path;
    const payload  = info.layer_payload || {};
    const code     = info.code;
    const tableName = info.table_name;
    const userId   = job.created_by || null;

    const updateProgress = async (progress, status = 'processing') => {
        const client = await db.pool.connect();
        try {
            await layerRepo.updateImportJob(client, jobId, { status, progress });
        } finally { client.release(); }
    };

    try {
        await updateProgress(5, 'processing');

        // 1. Inspect
        await updateProgress(10);
        let inspectResult;
        try {
            inspectResult = await ogr.inspect(filePath, info.source_layer_name || null, lang);
        } catch (err) {
            throw new Error(`${t('map_geo_inspect_failed', lang)}: ${err.message}`);
        }

        const { geometryType, epsgCode, featureCount } = inspectResult;

        // 2. ogr2ogr → PostGIS
        await updateProgress(20);
        try {
            await ogr.loadToPostgis({
                filePath,
                schema:           payload.schema_name || 'gis',
                table:            tableName,
                sridInput:        payload.srid_input || epsgCode || 4326,
                mode:             payload.import_mode || 'overwrite',
                sourceLayerName:  info.source_layer_name || null,
                onProgress: async (pct, msg) => {
                    await updateProgress(20 + Math.round(pct * 0.5));
                },
                lang,
            });
        } catch (err) {
            throw new Error(`${t('map_geo_ogr_failed', lang)}: ${err.message}`);
        }

        await updateProgress(70);

        // 3. Upsert layer_registry + refreshStats
        const layerRow = await _upsertAndRefresh({
            code, tableName, payload,
            geometryType, epsgCode, featureCount,
            sourceUrl: null,
            userId,
        });

        // 4. Cập nhật layer_id trong job
        await _finalizeJob(jobId, layerRow, featureCount, code, payload.auto_publish, lang);

        safeUnlink(filePath);
    } catch (err) {
        safeUnlink(filePath);
        const client = await db.pool.connect();
        try {
            await layerRepo.updateImportJob(client, jobId, {
                status:       'failed',
                progress:     0,
                error_log:    err.message,
                completed_at: new Date(),
            });
        } finally { client.release(); }
        throw err;
    }
};

// ── Helpers nội bộ ────────────────────────────────────────────────────────────

const _upsertAndRefresh = async ({ code, tableName, payload, geometryType, epsgCode, featureCount, sourceUrl, userId }) => {
    const schemaName = payload.schema_name || 'gis';
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        const layerRow = await layerRepo.upsertLayerByCode(client, {
            code,
            name_vi:           payload.name_vi || code,
            name_en:           payload.name_en || null,
            description_vi:    payload.description_vi || null,
            schema_name:       schemaName,
            table_name:        tableName,
            geometry_column:   'geom',
            geometry_type:     geometryType,
            epsg_code:         epsgCode || 4326,
            category:          payload.category || null,
            layer_kind:        payload.layer_kind || 'overlay',
            layer_group:       payload.layer_group || null,
            data_year:         payload.data_year || null,
            source_dataset:    payload.source_dataset || 'postgis',
            source_layer_name: payload.source_layer_name || null,
            is_active:         true,
            is_public:         payload.is_public ?? false,
            is_editable:       geometryType !== 'RASTER',
            source_url:        sourceUrl,
            userId,
        });

        let refreshed = layerRow;
        if (geometryType !== 'RASTER' && featureCount > 0) {
            refreshed = await layerRepo.refreshStats(client, layerRow.id) || layerRow;
        }
        await client.query('COMMIT');
        return refreshed;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
};

const _finalizeJob = async (jobId, layerRow, featureCount, code, autoPublish, lang = 'vi') => {
    const client = await db.pool.connect();
    try {
        await layerRepo.updateImportJob(client, jobId, {
            status:          'completed',
            progress:        100,
            total_features:  featureCount,
            imported_count:  featureCount,
            failed_count:    0,
            result_summary:  { layer_code: code, layer_id: layerRow.id },
            completed_at:    new Date(),
        });
    } finally {
        client.release();
    }

    // Auto-publish
    if (autoPublish && layerRow.is_active) {
        if (!layerRow.geoserver_layer) {
            try {
                const geoserverLayerName = await geoserver.publishVectorLayer(layerRow);
                const pubClient = await db.pool.connect();
                try {
                    await layerRepo.markPublished(pubClient, {
                        code:           layerRow.code,
                        geoserverLayer: geoserverLayerName,
                        geoserverStore: geoserverConfig.datastore,
                        updatedBy:      layerRow.updated_by,
                    });
                } finally { pubClient.release(); }
                console.log(t('geo_import_published', lang, { id: jobId, layer: geoserverLayerName }));
            } catch (pubErr) {
                console.error(t('geo_import_auto_publish_failed', lang, { id: jobId }), pubErr.message);
            }
        } else {
            // Re-import: layer đã publish → chỉ xóa tile cache cũ
            try {
                await geoserver.truncateGwcLayer(layerRow.geoserver_layer);
                console.log(t('geo_import_cache_truncated', lang, { id: jobId, layer: layerRow.geoserver_layer }));
            } catch (cacheErr) {
                console.warn(t('geo_import_truncate_cache_failed', lang, { id: jobId }), cacheErr.message);
            }
        }
    }
};

// ── Public API ────────────────────────────────────────────────────────────────

const getImportJob = (jobId) => layerRepo.findImportJobById(jobId);

module.exports = { enqueueImport, runImportJob, getImportJob };
