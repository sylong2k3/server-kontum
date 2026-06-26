const db = require('../configs/database');
const { geoserverConfig } = require('../configs/geoserver');
const { Api400Error, Api403Error, Api404Error, Api409Error } = require('../core/error.response');
const geoserver = require('../utils/geoserver.client');
const layerRepo = require('../repositories/map-layer.repository');
const { t } = require('../utils/i18n.util');

const ADMIN_ROLES = new Set(['system_admin', 'so_nnmt']);
const isAdmin = (user) => user && ADMIN_ROLES.has(user.role);
const hasRolePermission = (user, action) => user?.role === 'system_admin' || user?.role_permissions?.map_layers?.[action] === true;

const requireLayer = async (code) => {
    const layer = await layerRepo.findByCode(code);
    if (!layer) { throw new Api404Error(t('map_layer_not_found'), ['LAYER_NOT_FOUND']); }
    return layer;
};

const canReadLayer = (layer, user) => {
    if (!layer) { return false; }
    if (layer.is_public === true && layer.is_active === true) { return true; }
    if (!user) { return false; }
    if (isAdmin(user)) { return true; }
    const rolePermissions = (layer.layer_permissions || {})[user.role] || {};
    return rolePermissions.read === true || hasRolePermission(user, 'read');
};

const requireReadableLayer = async (code, user) => {
    const layer = await requireLayer(code);
    if (!canReadLayer(layer, user)) { throw new Api403Error(t('map_layer_read_forbidden'), ['MAP_LAYER_READ_FORBIDDEN']); }
    return layer;
};

const requireEditableLayer = async (code) => {
    const layer = await requireLayer(code);
    if (layer.is_editable !== true) { throw new Api403Error(t('map_layer_not_editable'), ['LAYER_NOT_EDITABLE']); }
    if (layer.geometry_type === 'RASTER') { throw new Api400Error(t('map_raster_feature_not_supported'), ['RASTER_FEATURE_NOT_SUPPORTED']); }
    return layer;
};

const listLayers = async (user, { page = 1, limit = 100, filter = {} } = {}) => {
    const offset = (page - 1) * limit;
    const [rows, total] = await Promise.all([
        layerRepo.findAll({ isAdmin: isAdmin(user), limit, offset, filter }),
        layerRepo.countAll({ isAdmin: isAdmin(user), filter }),
    ]);
    return { items: rows, pagination: { page, limit, total, total_pages: Math.ceil(total / limit) } };
};

const getLayer = async (code, user) => requireReadableLayer(code, user);

const createLayer = async (payload, user) => {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        const existed = await layerRepo.findByCode(payload.code, client);
        if (existed) { throw new Api409Error(t('map_layer_code_exists'), ['LAYER_CODE_EXISTS']); }
        if (payload.geometry_type !== 'RASTER') {
            const tableExists = await layerRepo.physicalTableExists(payload.schema_name || 'gis', payload.table_name, client);
            if (!tableExists) { throw new Api400Error(t('map_gis_table_not_found'), ['GIS_TABLE_NOT_FOUND']); }
        }
        const layer = await layerRepo.createLayer(client, { ...payload, userId: user?.id || null });
        await layerRepo.insertEditHistory(client, { layerId: layer.id, action: 'create', source: 'api', newData: layer, changedBy: user?.id || null });
        await client.query('COMMIT');
        return layer;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
};

const updateLayer = async (code, payload, user) => {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        const oldLayer = await requireLayer(code);
        if (payload.table_name || payload.schema_name) {
            const schema = payload.schema_name || oldLayer.schema_name;
            const table = payload.table_name || oldLayer.table_name;
            const tableExists = await layerRepo.physicalTableExists(schema, table, client);
            if (!tableExists) { throw new Api400Error(t('map_gis_table_not_found'), ['GIS_TABLE_NOT_FOUND']); }
        }
        const updated = await layerRepo.updateLayer(client, code, { ...payload, userId: user?.id || null });
        if (!updated) { throw new Api404Error(t('map_layer_not_found'), ['LAYER_NOT_FOUND']); }
        await layerRepo.insertEditHistory(client, { layerId: updated.id, action: 'update', source: 'api', oldData: oldLayer, newData: updated, changedBy: user?.id || null });
        await client.query('COMMIT');
        return updated;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
};

const deleteLayer = async (code, user) => {
    const layer = await requireLayer(code);
    if (layer.geoserver_layer) { throw new Api400Error(t('map_layer_still_published'), ['LAYER_STILL_PUBLISHED']); }
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        // History trước delete: sau khi layer bị xóa, FK ON DELETE SET NULL
        // giữ lại record history với layer_id = NULL (migration 013).
        await layerRepo.insertEditHistory(client, { layerId: layer.id, action: 'delete', source: 'api', oldData: layer, changedBy: user?.id || null });
        const deleted = await layerRepo.deleteLayer(client, code);
        await client.query('COMMIT');
        return deleted;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
};

const publishLayer = async (code, user) => {
    const layer = await requireLayer(code);
    if (layer.is_active !== true) { throw new Api400Error(t('map_layer_inactive'), ['LAYER_INACTIVE']); }
    if (layer.geoserver_layer) { throw new Api400Error(t('map_layer_already_published'), ['LAYER_ALREADY_PUBLISHED']); }
    if (layer.geometry_type !== 'RASTER') {
        const exists = await layerRepo.physicalTableExists(layer.schema_name, layer.table_name);
        if (!exists) { throw new Api400Error(t('map_gis_table_not_found'), ['GIS_TABLE_NOT_FOUND']); }
    }
    let geoserverLayerName = null;
    if ((layer.geometry_type || '').toUpperCase() === 'RASTER') { geoserverLayerName = await geoserver.publishRasterLayer(layer); }
    else { geoserverLayerName = await geoserver.publishVectorLayer(layer); }
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        const updated = await layerRepo.markPublished(client, { code, geoserverLayer: geoserverLayerName, geoserverStore: geoserverConfig.datastore, updatedBy: user?.id || null });
        await layerRepo.insertEditHistory(client, { layerId: updated.id, action: 'publish', source: 'api', newData: { geoserver_layer: geoserverLayerName }, changedBy: user?.id || null });
        await client.query('COMMIT');
        return updated;
    } catch (err) {
        await client.query('ROLLBACK');
        if (geoserverLayerName) { await geoserver.unpublishLayer(geoserverLayerName).catch((e) => console.error('[MapService] Rollback GeoServer unpublish lỗi:', e.message)); }
        throw err;
    } finally {
        client.release();
    }
};

const unpublishLayer = async (code, user) => {
    const layer = await requireLayer(code);
    if (layer.geoserver_layer) { await geoserver.unpublishLayer(layer.geoserver_layer); }
    const updated = await layerRepo.markUnpublished({ code, updatedAt: layer.updated_at, updatedBy: user?.id || null });
    if (!updated) { throw new Api409Error(t('map_optimistic_lock_conflict'), ['OPTIMISTIC_LOCK_CONFLICT']); }
    const client = await db.pool.connect();
    try { await layerRepo.insertEditHistory(client, { layerId: layer.id, action: 'unpublish', source: 'api', oldData: { geoserver_layer: layer.geoserver_layer }, changedBy: user?.id || null }); }
    finally { client.release(); }
    return updated;
};

const setLayerActive = async (code, isActive, user) => {
    const layer = await requireLayer(code);
    if (layer.geoserver_layer) { await geoserver.setLayerEnabled(layer.geoserver_layer, isActive); }
    const updated = await layerRepo.setActive({ code, isActive, updatedAt: layer.updated_at, updatedBy: user?.id || null });
    if (!updated) { throw new Api409Error(t('map_optimistic_lock_conflict'), ['OPTIMISTIC_LOCK_CONFLICT']); }
    const client = await db.pool.connect();
    try { await layerRepo.insertEditHistory(client, { layerId: layer.id, action: 'toggle_active', source: 'api', oldData: { is_active: layer.is_active }, newData: { is_active: isActive }, changedBy: user?.id || null }); }
    finally { client.release(); }
    return updated;
};

const listFeatures = async (code, query, user) => layerRepo.listFeatures(await requireReadableLayer(code, user), query);
const getFeature = async (code, featureId, user) => {
    const layer = await requireReadableLayer(code, user);
    const feature = await layerRepo.getFeature(layer, featureId);
    if (!feature) { throw new Api404Error(t('map_feature_not_found'), ['FEATURE_NOT_FOUND']); }
    return feature;
};

const getFeatureInfo = async (code, query, user) => {
    const layer = await requireReadableLayer(code, user);
    const feature = query.id !== undefined
        ? await layerRepo.getFeature(layer, query.id)
        : await layerRepo.findFeatureAtPoint(layer, query);
    if (!feature) { throw new Api404Error(t('map_feature_not_found'), ['FEATURE_NOT_FOUND']); }
    return feature;
};

const createFeature = async (code, payload, user) => {
    const layer = await requireEditableLayer(code);
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        const feature = await layerRepo.insertFeature(client, layer, payload);
        await layerRepo.refreshStats(client, layer.id);
        await layerRepo.insertEditHistory(client, { layerId: layer.id, action: 'create', source: 'api', featureId: feature.id, newData: feature, geometryChanged: true, changedBy: user?.id || null });
        await client.query('COMMIT');
        return feature;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
};

const updateFeature = async (code, featureId, payload, user) => {
    const layer = await requireEditableLayer(code);
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        const oldFeature = await layerRepo.getFeature(layer, featureId, client);
        if (!oldFeature) { throw new Api404Error(t('map_feature_not_found'), ['FEATURE_NOT_FOUND']); }
        const feature = await layerRepo.updateFeature(client, layer, featureId, payload);
        await layerRepo.refreshStats(client, layer.id);
        await layerRepo.insertEditHistory(client, { layerId: layer.id, action: 'update', source: 'api', featureId, oldData: oldFeature, newData: feature, geometryChanged: Object.prototype.hasOwnProperty.call(payload, 'geometry'), changedBy: user?.id || null });
        await client.query('COMMIT');
        return feature;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
};

const deleteFeature = async (code, featureId, user) => {
    const layer = await requireEditableLayer(code);
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        const oldFeature = await layerRepo.deleteFeature(client, layer, featureId);
        if (!oldFeature) { throw new Api404Error(t('map_feature_not_found'), ['FEATURE_NOT_FOUND']); }
        await layerRepo.refreshStats(client, layer.id);
        await layerRepo.insertEditHistory(client, { layerId: layer.id, action: 'delete', source: 'api', featureId, oldData: oldFeature, geometryChanged: true, changedBy: user?.id || null });
        await client.query('COMMIT');
        return oldFeature;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
};

const toFeatures = (payload) => {
    if (payload.source_format === 'geojson') {
        const data = payload.geojson;
        if (!data) { throw new Api400Error(t('map_geojson_required'), ['GEOJSON_REQUIRED']); }
        if (data.type === 'FeatureCollection') { return data.features || []; }
        if (data.type === 'Feature') { return [data]; }
        throw new Api400Error(t('map_invalid_geojson'), ['INVALID_GEOJSON']);
    }
    const rows = payload.csv || [];
    return rows.map((row) => ({
        type: 'Feature',
        geometry: row[payload.geometry_field]
            ? (typeof row[payload.geometry_field] === 'string' ? JSON.parse(row[payload.geometry_field]) : row[payload.geometry_field])
            : { type: 'Point', coordinates: [Number(row[payload.lng_field]), Number(row[payload.lat_field])] },
        properties: Object.fromEntries(Object.entries(row).filter(([key]) => ![payload.geometry_field, payload.lng_field, payload.lat_field].includes(key))),
    }));
};

const importFeatures = async (code, payload, user) => {
    const layer = await requireEditableLayer(code);
    const features = toFeatures(payload);
    const client = await db.pool.connect();
    let job;
    try {
        await client.query('BEGIN');
        job = await layerRepo.createImportJob(client, { layerId: layer.id, sourceFormat: payload.source_format, importMode: payload.import_mode, sridInput: payload.srid_input, encoding: payload.encoding, sourceInfo: { count: features.length }, status: 'processing', progress: 5, createdBy: user?.id || null });
        if (payload.import_mode === 'overwrite') { await layerRepo.overwriteFeatures(client, layer); }
        let imported = 0;
        for (const feature of features) {
            await layerRepo.insertFeature(client, layer, { geometry: feature.geometry, properties: feature.properties || {} });
            imported += 1;
        }
        const updatedLayer = await layerRepo.refreshStats(client, layer.id);
        await layerRepo.updateImportJob(client, job.id, { status: 'completed', progress: 100, total_features: features.length, imported_count: imported, failed_count: 0, result_summary: { layer_code: code }, completed_at: new Date() });
        await layerRepo.insertEditHistory(client, { layerId: layer.id, action: 'bulk_import', source: 'import', importJobId: job.id, newData: { imported_count: imported }, geometryChanged: true, changedBy: user?.id || null });
        await client.query('COMMIT');
        if (payload.auto_publish && !updatedLayer.geoserver_layer) { await publishLayer(code, user); }
        return { job_id: job.id, imported_count: imported, layer: updatedLayer };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally { client.release(); }
};

const listImportJobs = async (code, query, user) => {
    const layer = await requireReadableLayer(code, user);
    return layerRepo.listImportJobs(layer.id, query);
};
const getImportJob = (id) => layerRepo.findImportJobById(id);

module.exports = {
    createFeature, createLayer, deleteFeature, deleteLayer, getFeature, getFeatureInfo, getImportJob,
    getLayer, importFeatures, listFeatures, listImportJobs, listLayers, publishLayer, setLayerActive,
    unpublishLayer, updateFeature, updateLayer,
};
