'use strict';

/**
 * Map Layer Repository
 * Chá»‰ chá»©a SQL, khÃ´ng chá»©a business logic.
 */

const db = require('../configs/database');

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
const getFeatureIdColumn = async (layer, client = null) => {
    const { rows } = await exec(client)(
        `SELECT kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
          AND tc.table_name = kcu.table_name
         WHERE tc.table_schema = $1
           AND tc.table_name = $2
           AND tc.constraint_type = 'PRIMARY KEY'
         ORDER BY kcu.ordinal_position
         LIMIT 1`,
        [layer.schema_name, layer.table_name]
    );
    if (rows[0]?.column_name) { return rows[0].column_name; }

    const idCheck = await exec(client)(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2 AND column_name = 'id'
         LIMIT 1`,
        [layer.schema_name, layer.table_name]
    );
    if (idCheck.rows[0]?.column_name) { return 'id'; }

    throw new Error(`Layer table ${layer.schema_name}.${layer.table_name} does not have a primary key or id column`);
};

const LAYER_COLUMNS = `
    id, code, name_vi, name_en, description_vi, description_en,
    schema_name, table_name, COALESCE(geometry_column, 'geom') AS geometry_column,
    geometry_type, epsg_code, geoserver_layer, geoserver_store, source_url,
    default_style, min_zoom, max_zoom, label_field, category, layer_kind,
    layer_group, data_year, source_dataset, source_layer_name, sort_order,
    is_active, is_public, is_editable, layer_permissions,
    feature_count, last_updated_at, created_at, updated_at,
    CASE WHEN bbox IS NULL THEN NULL ELSE ST_AsGeoJSON(bbox)::json END AS bbox
`;

const buildLayerWhere = ({ isAdmin = false, filter = {} }, params) => {
    const where = ['($1::boolean = true OR (is_active = true AND is_public = true))'];
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
    return where;
};

const findAll = async ({ isAdmin = false, limit = 100, offset = 0, filter = {} } = {}) => {
    const params = [isAdmin];
    const where = buildLayerWhere({ isAdmin, filter }, params);
    params.push(limit, offset);
    const { rows } = await db.query(
        `SELECT ${LAYER_COLUMNS}
         FROM gis.layer_registry
         WHERE ${where.join(' AND ')}
         ORDER BY sort_order ASC, name_vi ASC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
    );
    return rows;
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

const findByCode = async (code, client = null) => {
    const { rows } = await exec(client)(`SELECT ${LAYER_COLUMNS} FROM gis.layer_registry WHERE code = $1`, [code]);
    return rows[0] || null;
};

const findByTableName = async (tableName) => {
    const normalized = tableName.includes(':') ? tableName.split(':').pop() : tableName;
    const { rows } = await db.query(
        `SELECT ${LAYER_COLUMNS} FROM gis.layer_registry WHERE table_name = $1 OR geoserver_layer = $2`,
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
            is_editable, layer_permissions, created_by, updated_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$29)
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
            payload.userId || null]
    );
    return rows[0];
};

const updateLayer = async (client, code, payload) => {
    const allowed = ['name_vi','name_en','description_vi','description_en','schema_name','table_name','geometry_column','geometry_type','epsg_code','geoserver_layer','geoserver_store','source_url','default_style','min_zoom','max_zoom','label_field','category','layer_kind','layer_group','data_year','source_dataset','source_layer_name','sort_order','is_active','is_public','is_editable','layer_permissions'];
    const sets = [];
    const params = [code];
    allowed.forEach((field) => {
        if (Object.prototype.hasOwnProperty.call(payload, field)) {
            params.push(payload[field] === '' ? null : payload[field]);
            sets.push(`${field} = $${params.length}`);
        }
    });
    if (!sets.length) { return findByCode(code, client); }
    params.push(payload.userId || null);
    const { rows } = await exec(client)(
        `UPDATE gis.layer_registry SET ${sets.join(', ')}, updated_by = $${params.length}, updated_at = NOW()
         WHERE code = $1 RETURNING ${LAYER_COLUMNS}`,
        params
    );
    return rows[0] || null;
};

const deleteLayer = async (client, code) => {
    const { rows } = await exec(client)(`DELETE FROM gis.layer_registry WHERE code = $1 RETURNING ${LAYER_COLUMNS}`, [code]);
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
         WHERE code = $1 AND updated_at = $2::timestamptz RETURNING ${LAYER_COLUMNS}`,
        [code, updatedAt, updatedBy]
    );
    return rows[0] || null;
};

const setActive = async ({ code, isActive, updatedAt, updatedBy }) => {
    const { rows } = await db.query(
        `UPDATE gis.layer_registry SET is_active = $2, last_updated_at = NOW(), updated_at = NOW(), updated_by = $4
         WHERE code = $1 AND updated_at = $3::timestamptz RETURNING ${LAYER_COLUMNS}`,
        [code, isActive, updatedAt, updatedBy]
    );
    return rows[0] || null;
};

const parseBbox = (bbox) => {
    if (!bbox) { return null; }
    const values = String(bbox).split(',').map(Number);
    if (values.length !== 4 || values.some(Number.isNaN) || values[0] >= values[2] || values[1] >= values[3]) {
        return null;
    }
    return values;
};

const listFeatures = async (layer, { limit = 1000, offset = 0, bbox } = {}) => {
    const idColumn = await getFeatureIdColumn(layer);
    const idCol = qid(idColumn);
    const params = [limit, offset];
    const where = [];
    const parsed = parseBbox(bbox);
    if (parsed) {
        params.push(...parsed);
        where.push(`${geomCol(layer)} && ST_MakeEnvelope($3, $4, $5, $6, 4326)`);
    }
    const { rows } = await db.query(
        `SELECT jsonb_build_object(
            'type', 'FeatureCollection',
            'features', COALESCE(jsonb_agg(jsonb_build_object(
                'type', 'Feature', 'id', t.${idCol},
                'geometry', ST_AsGeoJSON(t.${geomCol(layer)})::jsonb,
                'properties', to_jsonb(t) - '${layer.geometry_column || 'geom'}'
            ) ORDER BY t.${idCol}), '[]'::jsonb)
        ) AS geojson
        FROM (SELECT * FROM ${tableRef(layer)} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${idCol} LIMIT $1 OFFSET $2) t`,
        params
    );
    return rows[0]?.geojson || { type: 'FeatureCollection', features: [] };
};

const getFeature = async (layer, featureId, client = null) => {
    const idColumn = await getFeatureIdColumn(layer, client);
    const idCol = qid(idColumn);
    const { rows } = await exec(client)(
        `SELECT jsonb_build_object('type', 'Feature', 'id', ${idCol}, 'geometry', ST_AsGeoJSON(${geomCol(layer)})::jsonb, 'properties', to_jsonb(t) - '${layer.geometry_column || 'geom'}') AS feature
         FROM ${tableRef(layer)} t WHERE ${idCol} = $1`,
        [featureId]
    );
    return rows[0]?.feature || null;
};

const findFeatureAtPoint = async (layer, { lng, lat, tolerance_meters: toleranceMeters = 10 } = {}) => {
    const idColumn = await getFeatureIdColumn(layer);
    const idCol = qid(idColumn);
    const epsgCode = Number(layer.epsg_code || 4326);
    const pointExpression = `ST_Transform(ST_SetSRID(ST_MakePoint($1, $2), 4326), ${epsgCode})`;
    const tolerance = Number(toleranceMeters || 0);
    const whereClause = tolerance > 0
        ? `ST_DWithin(t.${geomCol(layer)}::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)`
        : `ST_Intersects(t.${geomCol(layer)}, ${pointExpression})`;
    const params = tolerance > 0 ? [lng, lat, tolerance] : [lng, lat];
    const { rows } = await db.query(
        `SELECT jsonb_build_object(
             'type', 'Feature',
             'id', t.${idCol},
             'geometry', ST_AsGeoJSON(t.${geomCol(layer)})::jsonb,
             'properties', to_jsonb(t) - '${layer.geometry_column || 'geom'}'
         ) AS feature
         FROM ${tableRef(layer)} t
         WHERE ${whereClause}
         ORDER BY ST_Distance(t.${geomCol(layer)}, ${pointExpression}) ASC
         LIMIT 1`,
        params
    );
    return rows[0]?.feature || null;
};

const insertFeature = async (client, layer, { geometry, properties = {} }) => {
    const idColumn = await getFeatureIdColumn(layer, client);
    const idCol = qid(idColumn);
    const propKeys = Object.keys(properties).filter((key) => IDENTIFIER_RE.test(key) && key !== idColumn && key !== (layer.geometry_column || 'geom'));
    const columns = [geomCol(layer), ...propKeys.map(qid)];
    const params = [JSON.stringify(geometry || null), ...propKeys.map((key) => properties[key])];
    const values = [`CASE WHEN $1::jsonb IS NULL THEN NULL ELSE ST_SetSRID(ST_GeomFromGeoJSON($1), ${Number(layer.epsg_code || 4326)}) END`];
    propKeys.forEach((_, index) => values.push(`$${index + 2}`));
    const { rows } = await exec(client)(
        `INSERT INTO ${tableRef(layer)} (${columns.join(', ')}) VALUES (${values.join(', ')}) RETURNING ${idCol} AS id`,
        params
    );
    return getFeature(layer, rows[0].id, client);
};

const updateFeature = async (client, layer, featureId, payload) => {
    const idColumn = await getFeatureIdColumn(layer, client);
    const idCol = qid(idColumn);
    const sets = [];
    const params = [];
    if (Object.prototype.hasOwnProperty.call(payload, 'geometry')) {
        params.push(JSON.stringify(payload.geometry || null));
        sets.push(`${geomCol(layer)} = CASE WHEN $${params.length}::jsonb IS NULL THEN NULL ELSE ST_SetSRID(ST_GeomFromGeoJSON($${params.length}), ${Number(layer.epsg_code || 4326)}) END`);
    }
    Object.keys(payload.properties || {}).forEach((key) => {
        if (IDENTIFIER_RE.test(key) && key !== idColumn && key !== (layer.geometry_column || 'geom')) {
            params.push(payload.properties[key]);
            sets.push(`${qid(key)} = $${params.length}`);
        }
    });
    if (!sets.length) { return getFeature(layer, featureId, client); }
    params.push(featureId);
    const { rowCount } = await exec(client)(`UPDATE ${tableRef(layer)} SET ${sets.join(', ')} WHERE ${idCol} = $${params.length}`, params);
    return rowCount ? getFeature(layer, featureId, client) : null;
};

const deleteFeature = async (client, layer, featureId) => {
    const idColumn = await getFeatureIdColumn(layer, client);
    const idCol = qid(idColumn);
    const oldFeature = await getFeature(layer, featureId, client);
    if (!oldFeature) { return null; }
    await exec(client)(`DELETE FROM ${tableRef(layer)} WHERE ${idCol} = $1`, [featureId]);
    return oldFeature;
};

const overwriteFeatures = async (client, layer) => exec(client)(`TRUNCATE TABLE ${tableRef(layer)} RESTART IDENTITY`);

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
    const { rows } = await db.query('SELECT * FROM gis.layer_import_jobs WHERE layer_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3', [layerId, limit, offset]);
    return rows;
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
            source_url, created_by, updated_by
        ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
            $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
            $21,$22,$23,$24,$25,$26,$27,$27
        )
        ON CONFLICT (code) DO UPDATE SET
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
            payload.userId || null,
        ]
    );
    return rows[0];
};

module.exports = {
    countAll, createImportJob, createLayer, deleteFeature, deleteLayer, findAll, findByCode,
    findByTableName, findFeatureAtPoint, findImportJobById, geometryColumnExists, getFeature,
    insertEditHistory, insertFeature, listFeatures, listImportJobs, markPublished, markUnpublished,
    overwriteFeatures, physicalTableExists, refreshStats, setActive, updateFeature, updateImportJob,
    updateLayer, upsertLayerByCode,
};

