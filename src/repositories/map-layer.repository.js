'use strict';

/**
 * Map Layer Repository
 * Chỉ chứa SQL, không chứa business logic.
 */

const db = require('../configs/database');
const { versionCondition } = require('../utils/optimistic-lock.util');

const IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const exec = (client) => (text, params) => client ? client.query(text, params) : db.query(text, params);
const assertIdentifier = (value, label = 'identifier') => {
    if (!IDENTIFIER_RE.test(String(value || ''))) {
        throw new Error(`Invalid ${label}: ${value}`);
    }
    return value;
};
const qid = (value) => '"' + assertIdentifier(value).replace(/"/g, '""') + '"';
const tableRef = (layer) => `${qid(layer.schema_name)}.${qid(layer.table_name)}`;
const geomCol = (layer) => qid(layer.geometry_column || 'geom');

const LAYER_COLUMNS = `
    id, code, name_vi, name_en, description_vi, description_en,
    schema_name, table_name, COALESCE(geometry_column, 'geom') AS geometry_column,
    geometry_type, epsg_code, geoserver_layer, geoserver_store, source_url,
    default_style, min_zoom, max_zoom, label_field, category, layer_kind,
    layer_group, data_year, source_dataset, source_layer_name, sort_order,
    is_active, is_public, is_editable, layer_permissions, remote_sensing_image_id,
    feature_count, last_updated_at, legend_config, created_at, updated_at,
    CASE WHEN bbox IS NULL THEN NULL ELSE ST_AsGeoJSON(bbox)::json END AS bbox
`;

const ON_DEMAND_CATEGORIES = ['fire_risk_district', 'forest_district'];

const buildLayerWhere = ({ isAdmin = false, filter = {} }, params) => {
    const where = ['($1::boolean = true OR (is_active = true AND is_public = true))', 'deleted_at IS NULL'];
    if (filter.q) {
        params.push(`%${filter.q}%`);
        where.push(`(name_vi ILIKE $${params.length} OR code ILIKE $${params.length})`);
    }
    if (filter.category) {
        params.push(filter.category);
        where.push(`category = $${params.length}`);
    }
    if (filter.layer_kind) {
        params.push(filter.layer_kind);
        where.push(`layer_kind = $${params.length}`);
    }
    if (filter.layer_group) {
        params.push(filter.layer_group);
        where.push(`layer_group = $${params.length}`);
    }
    if (filter.data_year) {
        params.push(filter.data_year);
        where.push(`data_year = $${params.length}`);
    }
    if (typeof filter.is_active === 'boolean') {
        params.push(filter.is_active);
        where.push(`is_active = $${params.length}`);
    }
    if (typeof filter.is_public === 'boolean') {
        params.push(filter.is_public);
        where.push(`is_public = $${params.length}`);
    }
    if (filter.publish_data === true) {
        const placeholders = ON_DEMAND_CATEGORIES.map((cat) => {
            params.push(cat);
            return `$${params.length}`;
        }).join(',');
        where.push(`(category IS NULL OR category NOT IN (${placeholders}))`);
    }
    return where;
};

const findAll = async ({ isAdmin = false, limit = 100, offset = 0, filter = {} } = {}) => {
    const params = [isAdmin];
    const where = buildLayerWhere({ isAdmin, filter }, params);
    params.push(limit, offset);
    const { rows } = await db.query(
        `SELECT ${LAYER_COLUMNS},
            COUNT(*) OVER()::int AS total_count
         FROM gis.layer_registry
         WHERE ${where.join(' AND ')}
         ORDER BY sort_order ASC, name_vi ASC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
    );

    if (rows.length === 0) {
        const total = offset > 0 ? await countAll({ isAdmin, filter }) : 0;
        return { items: [], total };
    }

    const total = rows[0].total_count;
    const items = rows.map(({ total_count, ...row }) => row);
    return { items, total };
};

const countAll = async ({ isAdmin = false, filter = {} } = {}) => {
    const params = [isAdmin];
    const where = buildLayerWhere({ isAdmin, filter }, params);
    const { rows } = await db.query(
        `SELECT COUNT(*)::int AS total FROM gis.layer_registry WHERE ${where.join(' AND ')}`,
        params
    );
    return rows[0].total;
};

const findById = async (id) => {
    const { rows } = await db.query(`SELECT ${LAYER_COLUMNS} FROM gis.layer_registry WHERE id = $1 AND deleted_at IS NULL`, [id]);
    return rows[0] || null;
};

const findByCode = async (code, client = null) => {
    const { rows } = await exec(client)(`SELECT ${LAYER_COLUMNS} FROM gis.layer_registry WHERE code = $1 AND deleted_at IS NULL`, [code]);
    return rows[0] || null;
};

const findByTableName = async (tableName) => {
    const normalized = tableName.includes(':') ? tableName.split(':').pop() : tableName;
    const { rows } = await db.query(
        `SELECT ${LAYER_COLUMNS} FROM gis.layer_registry WHERE (table_name = $1 OR geoserver_layer = $2) AND deleted_at IS NULL`,
        [normalized, tableName]
    );
    return rows[0] || null;
};

const physicalTableExists = async (schemaName, tableName, client = null) => {
    const { rows } = await exec(client)(
        `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2) AS "exists"`,
        [schemaName, tableName]
    );
    return rows[0].exists;
};

const geometryColumnExists = async (layer, client = null) => {
    const { rows } = await exec(client)(
        `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3) AS "exists"`,
        [layer.schema_name, layer.table_name, layer.geometry_column || 'geom']
    );
    return rows[0].exists;
};

const createLayer = async (client, payload) => {
    const { rows } = await exec(client)(
        `INSERT INTO gis.layer_registry (
            code, name_vi, name_en, description_vi, description_en, schema_name, table_name,
            geometry_column, geometry_type, epsg_code, geoserver_layer, geoserver_store, source_url,
            default_style, min_zoom, max_zoom, label_field, category, layer_kind, layer_group,
            data_year, source_dataset, source_layer_name, sort_order, is_active, is_public,
            is_editable, layer_permissions, legend_config, created_by, updated_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$30)
        RETURNING ${LAYER_COLUMNS}`,
        [payload.code, payload.name_vi, payload.name_en || null, payload.description_vi || null,
            payload.description_en || null, payload.schema_name || 'gis', payload.table_name,
            payload.geometry_column || 'geom', payload.geometry_type, payload.epsg_code || 4326,
            payload.geoserver_layer || null, payload.geoserver_store || null, payload.source_url || null,
            payload.default_style || {}, payload.min_zoom ?? 1, payload.max_zoom ?? 22,
            payload.label_field || null, payload.category || null, payload.layer_kind || 'overlay',
            payload.layer_group || null, payload.data_year || null, payload.source_dataset || null,
            payload.source_layer_name || null, payload.sort_order ?? 0, payload.is_active ?? true,
            payload.is_public ?? false, payload.is_editable ?? true, payload.layer_permissions || {},
            payload.legend_config !== undefined ? payload.legend_config : (payload.legendConfig !== undefined ? payload.legendConfig : null),
            payload.userId || null]
    );
    return rows[0];
};

const updateLayer = async (client, code, payload) => {
    const allowed = ['name_vi','name_en','description_vi','description_en','schema_name','table_name','geometry_column','geometry_type','epsg_code','geoserver_layer','geoserver_store','source_url','default_style','min_zoom','max_zoom','label_field','category','layer_kind','layer_group','data_year','source_dataset','source_layer_name','sort_order','is_active','is_public','is_editable','layer_permissions','legend_config'];
    if (payload.legendConfig !== undefined && payload.legend_config === undefined) {
        payload.legend_config = payload.legendConfig;
    }
    const sets = [];
    const params = [code];
    allowed.forEach((field) => {
        if (Object.prototype.hasOwnProperty.call(payload, field)) {
            const value = field === 'default_style' && payload[field] === null ? {} : payload[field];
            params.push(value === '' ? null : value);
            sets.push(`${field} = $${params.length}`);
        }
    });
    if (!sets.length) { return findByCode(code, client); }
    params.push(payload.userId || null);
    const userByIdx = params.length;
    let lockSql = '';
    if (payload.expectedUpdatedAt) {
        params.push(payload.expectedUpdatedAt);
        lockSql = versionCondition(params.length);
    }
    const { rows } = await exec(client)(
        `UPDATE gis.layer_registry SET ${sets.join(', ')}, updated_by = $${userByIdx}, updated_at = NOW()
         WHERE code = $1${lockSql} RETURNING ${LAYER_COLUMNS}`,
        params
    );
    return rows[0] || null;
};

const deleteLayer = async (client, code) => {
    const { rows } = await exec(client)(
        `UPDATE gis.layer_registry SET deleted_at = NOW() WHERE code = $1 AND deleted_at IS NULL RETURNING ${LAYER_COLUMNS}`,
        [code]
    );
    return rows[0] || null;
};

const markPublished = async (client, { code, geoserverLayer, geoserverStore, updatedBy }) => {
    const { rows } = await exec(client)(
        `UPDATE gis.layer_registry
         SET geoserver_layer = $2, geoserver_store = COALESCE(geoserver_store, $3), last_updated_at = NOW(), updated_at = NOW(), updated_by = $4
         WHERE code = $1 RETURNING ${LAYER_COLUMNS}`,
        [code, geoserverLayer, geoserverStore, updatedBy]
    );
    return rows[0] || null;
};

const markUnpublished = async ({ code, updatedAt, updatedBy }) => {
    const { rows } = await db.query(
        `UPDATE gis.layer_registry SET geoserver_layer = NULL, geoserver_store = NULL, last_updated_at = NOW(), updated_at = NOW(), updated_by = $3
         WHERE code = $1${versionCondition(2)} RETURNING ${LAYER_COLUMNS}`,
        [code, updatedAt, updatedBy]
    );
    return rows[0] || null;
};

const setActive = async ({ code, isActive, updatedAt, updatedBy }) => {
    const { rows } = await db.query(
        `UPDATE gis.layer_registry SET is_active = $2, last_updated_at = NOW(), updated_at = NOW(), updated_by = $4
         WHERE code = $1${versionCondition(3)} RETURNING ${LAYER_COLUMNS}`,
        [code, isActive, updatedAt, updatedBy]
    );
    return rows[0] || null;
};

const refreshStats = async (client, layerId) => {
    const { rows: layerRows } = await exec(client)('SELECT * FROM gis.layer_registry WHERE id = $1', [layerId]);
    const layer = layerRows[0];
    if (!layer || layer.geometry_type === 'RASTER') { return layer; }
    const { rows } = await exec(client)(
        `UPDATE gis.layer_registry SET feature_count = stats.cnt, bbox = stats.new_bbox, last_updated_at = NOW(), updated_at = NOW()
         FROM (
             SELECT COUNT(*)::bigint AS cnt,
                    CASE WHEN COUNT(*) = 0 THEN NULL ELSE ST_Envelope(ST_Transform(ST_SetSRID(ST_Extent(${geomCol(layer)})::geometry, ${Number(layer.epsg_code || 4326)}), 4326)) END AS new_bbox
             FROM ${tableRef(layer)}
         ) stats WHERE id = $1 RETURNING ${LAYER_COLUMNS}`,
        [layerId]
    );
    return rows[0] || null;
};

const createImportJob = async (client, payload) => {
    const { rows } = await exec(client)(
        `INSERT INTO gis.layer_import_jobs (layer_id, source_format, source_info, import_mode, srid_input, encoding, strategy, status, progress, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [payload.layerId, payload.sourceFormat, payload.sourceInfo || {}, payload.importMode || 'append', payload.sridInput || 4326, payload.encoding || 'UTF-8', payload.strategy || 'all_or_nothing', payload.status || 'pending', payload.progress || 0, payload.createdBy || null]
    );
    return rows[0];
};

const updateImportJob = async (client, id, payload) => {
    const fields = ['status','progress','total_features','imported_count','failed_count','error_log','result_summary','started_at','completed_at'];
    const sets = [];
    const params = [id];
    fields.forEach((field) => {
        if (Object.prototype.hasOwnProperty.call(payload, field)) {
            params.push(payload[field]);
            sets.push(`${field} = $${params.length}`);
        }
    });
    if (!sets.length) { return null; }
    const { rows } = await exec(client)(`UPDATE gis.layer_import_jobs SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
    return rows[0] || null;
};

const findImportJobById = async (id) => {
    const { rows } = await db.query('SELECT * FROM gis.layer_import_jobs WHERE id = $1', [id]);
    return rows[0] || null;
};

const listImportJobs = async (layerId, { limit = 50, offset = 0 } = {}) => {
    const { rows } = await db.query(
        `SELECT *, COUNT(*) OVER()::int AS total_count
         FROM gis.layer_import_jobs
         WHERE layer_id = $1
         ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [layerId, limit, offset]
    );

    if (rows.length === 0) {
        let total = 0;
        if (offset > 0) {
            const { rows: cnt } = await db.query('SELECT COUNT(*)::int AS total FROM gis.layer_import_jobs WHERE layer_id = $1', [layerId]);
            total = cnt[0].total;
        }
        return { items: [], pagination: { limit, offset, total } };
    }

    const total = rows[0].total_count;
    const items = rows.map(({ total_count, ...row }) => row);
    return { items, pagination: { limit, offset, total } };
};

const insertEditHistory = async (client, { layerId, action, source = 'api', importJobId, featureId, oldData, newData, geometryChanged, changedBy }) => {
    await exec(client)(
        `INSERT INTO gis.layer_edit_history (layer_id, action, source, import_job_id, feature_id, old_data, new_data, geometry_changed, changed_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [layerId, action, source, importJobId || null, featureId || null, oldData || null, newData || null, geometryChanged || false, changedBy || null]
    );
};

/**
 * Đăng ký layer vào registry nếu chưa có; cập nhật các trường metadata nếu đã có.
 * Dùng sau khi ogr2ogr tạo bảng vật lý thành công.
 *
 * @param {object} client  - pg client (trong transaction)
 * @param {object} payload - Các trường layer (code bắt buộc)
 * @returns {Promise<object>} row layer_registry
 */
const upsertLayerByCode = async (client, payload) => {
    const { rows } = await exec(client)(
        `INSERT INTO gis.layer_registry (
            code, name_vi, name_en, description_vi, description_en,
            schema_name, table_name, geometry_column, geometry_type, epsg_code,
            default_style, min_zoom, max_zoom, label_field, category,
            layer_kind, layer_group, data_year, source_dataset, source_layer_name,
            sort_order, is_active, is_public, is_editable, layer_permissions,
            source_url, remote_sensing_image_id, created_by, updated_by
        ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
            $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
            $21,$22,$23,$24,$25,$26,$27,$28,$28
        )
        ON CONFLICT (code) DO UPDATE SET
            deleted_at        = NULL,
            name_vi           = COALESCE(EXCLUDED.name_vi, gis.layer_registry.name_vi),
            name_en           = COALESCE(EXCLUDED.name_en, gis.layer_registry.name_en),
            schema_name       = EXCLUDED.schema_name,
            table_name        = EXCLUDED.table_name,
            geometry_column   = EXCLUDED.geometry_column,
            geometry_type     = EXCLUDED.geometry_type,
            epsg_code         = EXCLUDED.epsg_code,
            category          = COALESCE(EXCLUDED.category, gis.layer_registry.category),
            layer_kind        = COALESCE(EXCLUDED.layer_kind, gis.layer_registry.layer_kind),
            layer_group       = COALESCE(EXCLUDED.layer_group, gis.layer_registry.layer_group),
            data_year         = COALESCE(EXCLUDED.data_year, gis.layer_registry.data_year),
            source_dataset    = COALESCE(EXCLUDED.source_dataset, gis.layer_registry.source_dataset),
            source_layer_name = COALESCE(EXCLUDED.source_layer_name, gis.layer_registry.source_layer_name),
            source_url        = COALESCE(EXCLUDED.source_url, gis.layer_registry.source_url),
            remote_sensing_image_id = COALESCE(EXCLUDED.remote_sensing_image_id, gis.layer_registry.remote_sensing_image_id),
            is_active         = EXCLUDED.is_active,
            is_public         = EXCLUDED.is_public,
            is_editable       = EXCLUDED.is_editable,
            updated_by        = EXCLUDED.updated_by,
            updated_at        = NOW()
        RETURNING ${LAYER_COLUMNS}`,
        [
            payload.code,
            payload.name_vi || payload.code,
            payload.name_en || null,
            payload.description_vi || null,
            payload.description_en || null,
            payload.schema_name || 'gis',
            payload.table_name,
            payload.geometry_column || 'geom',
            payload.geometry_type || 'GEOMETRY',
            payload.epsg_code || 4326,
            payload.default_style || {},
            payload.min_zoom ?? 1,
            payload.max_zoom ?? 22,
            payload.label_field || null,
            payload.category || null,
            payload.layer_kind || 'overlay',
            payload.layer_group || null,
            payload.data_year || null,
            payload.source_dataset || 'postgis',
            payload.source_layer_name || null,
            payload.sort_order ?? 0,
            payload.is_active ?? true,
            payload.is_public ?? false,
            payload.is_editable ?? true,
            payload.layer_permissions || {},
            payload.source_url || null,
            payload.remote_sensing_image_id || null,
            payload.userId || null,
        ]
    );
    return rows[0];
};

/**
 * Đọc dữ liệu của một lớp từ bảng vật lý dưới dạng GeoJSON Feature[].
 * Geometry được transform về EPSG:4326. Dùng cho API chia sẻ (US-025).
 *
 * @param {object} layer  - row layer_registry (schema_name, table_name, geometry_column, epsg_code)
 * @param {object} opts   - { bbox: [minLng,minLat,maxLng,maxLat], limit, offset }
 * @returns {Promise<object[]>} mảng GeoJSON Feature
 */
const findFeaturesAsGeoJSON = async (layer, { bbox = null, limit = 500, offset = 0 } = {}) => {
    const ref      = tableRef(layer);
    const gcol     = geomCol(layer);
    const rawGeom  = assertIdentifier(layer.geometry_column || 'geom', 'geometry_column');
    const epsg     = Number(layer.epsg_code || 4326);
    const geom4326 = `ST_Transform(ST_SetSRID(${gcol}, ${epsg}), 4326)`;

    const params = [];
    const where  = [`${gcol} IS NOT NULL`];

    if (bbox) {
        const [minLng, minLat, maxLng, maxLat] = bbox;
        params.push(minLng, minLat, maxLng, maxLat);
        where.push(
            `${geom4326} && ST_MakeEnvelope($${params.length - 3},$${params.length - 2},$${params.length - 1},$${params.length},4326)`
        );
    }

    params.push(limit, offset);
    const sql = `
        SELECT jsonb_build_object(
            'type', 'Feature',
            'geometry', ST_AsGeoJSON(${geom4326}, 6)::jsonb,
            'properties', to_jsonb(t.*) - '${rawGeom.toLowerCase()}'
        ) AS feature
        FROM ${ref} t
        WHERE ${where.join(' AND ')}
        LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const { rows } = await db.query(sql, params);
    return rows.map((r) => r.feature);
};

module.exports = {
    countAll, createImportJob, createLayer, deleteLayer, findAll, findById, findByCode,
    findByTableName, findFeaturesAsGeoJSON, findImportJobById,
    geometryColumnExists, insertEditHistory,
    listImportJobs, markPublished, markUnpublished, physicalTableExists,
    refreshStats, setActive, updateImportJob,
    updateLayer, upsertLayerByCode,
};

