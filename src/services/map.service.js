const db = require('../configs/database');
const { geoserverConfig } = require('../configs/geoserver');
const { Api400Error, Api403Error, Api404Error, Api409Error } = require('../core/error.response');
const geoserver = require('../utils/geoserver.client');
const layerRepo = require('../repositories/map-layer.repository');
const { t } = require('../utils/i18n.util');

const ADMIN_ROLES = new Set(['system_admin', 'so_nnmt']);
const isAdmin = (user) => user && ADMIN_ROLES.has(user.role);
const hasRolePermission = (user, action) => user?.role === 'system_admin' || user?.role_permissions?.map_layers?.[action] === true;

const requireLayer = async (code, lang) => {
    const isNumericId = /^\d+$/.test(String(code));
    const layer = isNumericId
        ? (await layerRepo.findById(Number(code)) || await layerRepo.findByCode(code))
        : await layerRepo.findByCode(code);
    if (!layer) { throw new Api404Error(t('map_layer_not_found', lang), ['LAYER_NOT_FOUND']); }
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

const requireReadableLayer = async (code, user, lang) => {
    const layer = await requireLayer(code, lang);
    if (!canReadLayer(layer, user)) { throw new Api403Error(t('map_layer_read_forbidden', lang), ['MAP_LAYER_READ_FORBIDDEN']); }
    return layer;
};

const listLayers = async (user, { page = 1, limit = 100, filter = {} } = {}) => {
    const offset = (page - 1) * limit;
    const { items, total } = await layerRepo.findAll({ isAdmin: isAdmin(user), limit, offset, filter });
    return { items, page, limit, total };
};

const getLayer = async (code, user, lang) => requireReadableLayer(code, user, lang);

const createLayer = async (payload, user, lang) => {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        const existed = await layerRepo.findByCode(payload.code, client);
        if (existed) { throw new Api409Error(t('map_layer_code_exists', lang), ['LAYER_CODE_EXISTS']); }
        if (payload.geometry_type !== 'RASTER') {
            const tableExists = await layerRepo.physicalTableExists(payload.schema_name || 'gis', payload.table_name, client);
            if (!tableExists) { throw new Api400Error(t('map_gis_table_not_found', lang), ['GIS_TABLE_NOT_FOUND']); }
            const tableUsed = await layerRepo.findByTableName(payload.table_name);
            if (tableUsed) { throw new Api409Error(t('map_layer_table_already_used', lang), ['LAYER_TABLE_ALREADY_USED']); }
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

const updateLayer = async (code, payload, user, lang) => {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        const oldLayer = await requireLayer(code, lang);
        if (payload.table_name || payload.schema_name) {
            const schema = payload.schema_name || oldLayer.schema_name;
            const table = payload.table_name || oldLayer.table_name;
            const tableExists = await layerRepo.physicalTableExists(schema, table, client);
            if (!tableExists) { throw new Api400Error(t('map_gis_table_not_found', lang), ['GIS_TABLE_NOT_FOUND']); }
        }
        const updated = await layerRepo.updateLayer(client, code, { ...payload, userId: user?.id || null });
        if (!updated) {
            // oldLayer đã xác nhận tồn tại ở trên → null nghĩa là expectedUpdatedAt lệch (conflict)
            if (payload.expectedUpdatedAt) { throw new Api409Error(t('map_optimistic_lock_conflict', lang), ['OPTIMISTIC_LOCK_CONFLICT']); }
            throw new Api404Error(t('map_layer_not_found', lang), ['LAYER_NOT_FOUND']);
        }
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

const deleteLayer = async (code, user, lang) => {
    const layer = await requireLayer(code, lang);
    if (layer.geoserver_layer) { throw new Api400Error(t('map_layer_still_published', lang), ['LAYER_STILL_PUBLISHED']); }
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

const publishLayer = async (code, user, lang) => {
    const layer = await requireLayer(code, lang);
    if (layer.is_active !== true) { throw new Api400Error(t('map_layer_inactive', lang), ['LAYER_INACTIVE']); }
    if (layer.geoserver_layer) { throw new Api400Error(t('map_layer_already_published', lang), ['LAYER_ALREADY_PUBLISHED']); }
    if (layer.geometry_type !== 'RASTER') {
        const exists = await layerRepo.physicalTableExists(layer.schema_name, layer.table_name);
        if (!exists) { throw new Api400Error(t('map_gis_table_not_found', lang), ['GIS_TABLE_NOT_FOUND']); }
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
        if (geoserverLayerName) { await geoserver.unpublishLayer(geoserverLayerName).catch((e) => console.error(t('map_geoserver_rollback_unpublish_failed', lang), e.message)); }
        throw err;
    } finally {
        client.release();
    }
};

const unpublishLayer = async (code, user, lang) => {
    const layer = await requireLayer(code, lang);
    if (layer.geoserver_layer) {
        await geoserver.unpublishLayer(layer.geoserver_layer).catch((err) => {
            if (err.status !== 404) { throw err; }
            console.warn(t('map_geoserver_layer_missing_mark_unpublish', lang, { layer: layer.geoserver_layer }));
        });
    }
    const updated = await layerRepo.markUnpublished({ code, updatedAt: layer.updated_at, updatedBy: user?.id || null });
    if (!updated) { throw new Api409Error(t('map_optimistic_lock_conflict', lang), ['OPTIMISTIC_LOCK_CONFLICT']); }
    const client = await db.pool.connect();
    try { await layerRepo.insertEditHistory(client, { layerId: layer.id, action: 'unpublish', source: 'api', oldData: { geoserver_layer: layer.geoserver_layer }, changedBy: user?.id || null }); }
    finally { client.release(); }
    return updated;
};

const setLayerActive = async (code, isActive, user, lang) => {
    const layer = await requireLayer(code, lang);
    const updated = await layerRepo.setActive({ code, isActive, updatedAt: layer.updated_at, updatedBy: user?.id || null });
    if (!updated) { throw new Api409Error(t('map_optimistic_lock_conflict', lang), ['OPTIMISTIC_LOCK_CONFLICT']); }

    if (layer.geoserver_layer) {
        await geoserver.setLayerEnabled(layer.geoserver_layer, isActive).catch((err) => {
            console.warn(t('map_geoserver_sync_status_failed', lang, { layer: layer.geoserver_layer }), err.message);
        });
    }

    const client = await db.pool.connect();
    try { await layerRepo.insertEditHistory(client, { layerId: layer.id, action: 'toggle_active', source: 'api', oldData: { is_active: layer.is_active }, newData: { is_active: isActive }, changedBy: user?.id || null }); }
    finally { client.release(); }
    return updated;
};

const listImportJobs = async (code, query, user, lang) => {
    const layer = await requireReadableLayer(code, user, lang);
    return layerRepo.listImportJobs(layer.id, query);
};
const getImportJob = async (id, lang) => {
    const job = await layerRepo.findImportJobById(id);
    if (!job) { throw new Api404Error(t('map_import_job_not_found', lang), ['IMPORT_JOB_NOT_FOUND']); }
    return job;
};

module.exports = {
    createLayer, deleteLayer, getImportJob,
    getLayer, listImportJobs, listLayers, publishLayer, setLayerActive,
    unpublishLayer, updateLayer,
};
