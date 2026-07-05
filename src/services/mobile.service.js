const db = require('../configs/database');
const layerRepo = require('../repositories/map-layer.repository');
const fieldUpdateRepo = require('../repositories/field-update.repository');
const { hasPermission } = require('../middlewares/auth.middleware');
const { Api400Error, Api403Error, Api404Error } = require('../core/error.response');
const { t } = require('../utils/i18n.util');

const POINT_GEOMETRY_TYPES = new Set(['POINT', 'MULTIPOINT']);
const PG_UNIQUE_VIOLATION = '23505';

const toFieldUpdateItem = (row) => ({
    id: row.id,
    layerId: row.layer_id,
    layerCode: row.layer_code,
    featureId: row.feature_id,
    action: row.action,
    attributes: row.attributes,
    clientUuid: row.client_uuid,
    note: row.note,
    lng: row.lng,
    lat: row.lat,
    createdAt: row.created_at,
});

const requireFeaturePermission = (actor, action, lang) => {
    const permKey = action === 'update' ? 'feature_update' : 'feature_create';
    if (actor.role === 'system_admin') { return; }
    if (!hasPermission(actor.permissions, 'map_layers', permKey)) {
        throw new Api403Error(t('no_permission_resource', lang, { resource: 'map_layers', action: permKey }));
    }
};

const createFieldUpdate = async (actor, payload, lang) => {
    const layer = await layerRepo.findByCode(payload.layerCode);
    if (!layer) { throw new Api404Error(t('map_layer_not_found', lang)); }
    if (!layer.is_editable) { throw new Api400Error(t('map_layer_not_editable', lang)); }
    if (!POINT_GEOMETRY_TYPES.has(layer.geometry_type)) {
        throw new Api400Error(t('mobile_field_update_geometry_unsupported', lang));
    }

    const action = payload.featureId ? 'update' : 'insert';
    requireFeaturePermission(actor, action, lang);

    if (payload.clientUuid) {
        const duplicate = await fieldUpdateRepo.findDuplicateByClientUuid(actor.id, payload.clientUuid);
        if (duplicate) {
            return {
                message: t('mobile_field_update_created_success', lang),
                fieldUpdate: toFieldUpdateItem({ ...duplicate, layer_code: layer.code }),
                duplicated: true,
            };
        }
    }

    const attributes = payload.attributes || {};
    const editableColumns = await layerRepo.getEditableColumns(layer);
    const invalidColumns = Object.keys(attributes).filter((col) => !editableColumns.includes(col));
    if (invalidColumns.length > 0) {
        throw new Api400Error(t('mobile_field_update_invalid_attributes', lang, { columns: editableColumns.join(', ') }));
    }

    const client = await db.pool.connect();
    let fieldUpdate, feature;
    try {
        await client.query('BEGIN');

        let oldData = null;
        if (action === 'update') {
            oldData = await layerRepo.findFeatureById(client, layer, payload.featureId);
            if (!oldData) { throw new Api404Error(t('map_feature_not_found', lang)); }
            feature = await layerRepo.updateFeature(client, layer, payload.featureId, {
                lng: payload.lng, lat: payload.lat, attributes,
            });
            if (!feature) { throw new Api404Error(t('map_feature_not_found', lang)); }
        } else {
            feature = await layerRepo.insertFeature(client, layer, {
                lng: payload.lng, lat: payload.lat, attributes,
            });
        }

        await layerRepo.insertEditHistory(client, {
            layerId: layer.id, action, source: 'api', featureId: feature.id,
            oldData, newData: attributes, geometryChanged: true, changedBy: actor.id,
        });

        fieldUpdate = await fieldUpdateRepo.create(client, {
            userId: actor.id, layerId: layer.id, featureId: feature.id, action,
            attributes, clientUuid: payload.clientUuid, note: payload.note,
            lng: payload.lng, lat: payload.lat,
        });

        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        if (error.code === PG_UNIQUE_VIOLATION && payload.clientUuid) {
            const duplicate = await fieldUpdateRepo.findDuplicateByClientUuid(actor.id, payload.clientUuid);
            if (duplicate) {
                return {
                    message: t('mobile_field_update_created_success', lang),
                    fieldUpdate: toFieldUpdateItem({ ...duplicate, layer_code: layer.code }),
                    duplicated: true,
                };
            }
        }
        throw error;
    } finally {
        client.release();
    }

    // refreshStats chạy ngoài transaction — tránh full-scan kéo dài lock-hold
    layerRepo.refreshStats(null, layer.id).catch(() => {});

    return {
        message: t('mobile_field_update_created_success', lang),
        fieldUpdate: toFieldUpdateItem({ ...fieldUpdate, layer_code: layer.code }),
        feature: { id: feature.id, geometry: feature.geometry },
        duplicated: false,
    };
};

const syncSince = async (actor, since, limit = 500) => {
    const cappedLimit = Math.min(Number(limit) || 500, 1000);
    const rows = await fieldUpdateRepo.findSince(actor.id, since || null, cappedLimit + 1);
    const hasMore = rows.length > cappedLimit;
    return {
        fieldUpdates: (hasMore ? rows.slice(0, cappedLimit) : rows).map(toFieldUpdateItem),
        hasMore,
        serverTime: new Date().toISOString(),
    };
};

module.exports = { createFieldUpdate, syncSince };
