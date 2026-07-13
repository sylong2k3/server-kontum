'use strict';

/**
 * Field Measurement Repository — đo đạc thực địa GPS (docs/modules/17).
 * Chỉ chứa SQL, không chứa business logic (điều kiện chuyển trạng thái,
 * quyền hạn... nằm ở service).
 */

const db = require('../configs/database');

const exec = (client) => (text, params) => client ? client.query(text, params) : db.query(text, params);

const IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const assertIdentifier = (value, label = 'identifier') => {
    if (!IDENTIFIER_RE.test(String(value || ''))) {
        throw new Error(`Invalid ${label}: ${value}`);
    }
    return value;
};
const qid = (value) => '"' + assertIdentifier(value).replace(/"/g, '""') + '"';
const tableRef = (layer) => `${qid(layer.schema_name)}.${qid(layer.table_name)}`;
const geomCol = (layer) => qid(layer.geometry_column || 'geom');

const MEASUREMENT_COLUMNS = `
    id, code, area_id, layer_id, points,
    CASE WHEN geom IS NULL THEN NULL ELSE ST_AsGeoJSON(geom)::json END AS geom,
    area_m2, avg_accuracy_m, commune_code, affected_features,
    old_land_use, new_land_use, note, status, review_note, device_info,
    measured_by, verified_by, started_at, finished_at, submitted_at, verified_at,
    created_at, updated_at
`;

// ── Bước 1: khép polygon từ các điểm GPS + validate hình học ─────────────────
// Trả về polygon lớn nhất sau ST_MakeValid (chống tự cắt khi người đo đi lệch)
// cùng diện tích chuẩn (m²) và độ chính xác trung bình.
const buildValidPolygon = async (points) => {
    const ring = points.map((p) => [p.lng, p.lat]);
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) { ring.push(first); }

    const geojson = { type: 'Polygon', coordinates: [ring] };
    const { rows } = await db.query(
        `WITH raw AS (
            SELECT ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)) AS g
        ), polys AS (
            SELECT (ST_Dump(g)).geom AS g FROM raw
        )
        SELECT ST_AsGeoJSON(g)::json AS geojson,
               ROUND(ST_Area(g::geography)::numeric, 2) AS area_m2
        FROM polys
        ORDER BY ST_Area(g) DESC
        LIMIT 1`,
        [JSON.stringify(geojson)]
    );
    if (!rows[0]) { throw new Error('INVALID_POLYGON'); }

    const accuracies = points.map((p) => Number(p.accuracy_m)).filter((v) => Number.isFinite(v));
    const avgAccuracyM = accuracies.length
        ? Number((accuracies.reduce((a, b) => a + b, 0) / accuracies.length).toFixed(2))
        : null;

    return { geom: rows[0].geojson, areaM2: rows[0].area_m2, avgAccuracyM };
};

// ── Bước 2: giao cắt với lớp thửa nền để auto-fill loại đất hiện trạng ───────
// landUseField: tên cột thuộc tính loại đất trong bảng vật lý của layer (tùy chọn).
// feature_id dùng ctid vì bảng lớp GIS động không có quy ước tên khóa chính cố định.
const intersectWithLayer = async (layer, geomGeoJSON, landUseField = null) => {
    const ref = tableRef(layer);
    const gcol = geomCol(layer);
    const landUseSelect = landUseField ? `t.${qid(landUseField)}::text` : 'NULL';

    const { rows } = await db.query(
        `SELECT t.ctid::text AS feature_id,
                ${landUseSelect} AS land_use,
                ROUND(ST_Area(ST_Intersection(t.${gcol}, ng.g)::geography)::numeric, 2) AS overlap_m2
         FROM ${ref} t,
              (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 4326) AS g) ng
         WHERE ST_Intersects(t.${gcol}, ng.g)
         ORDER BY overlap_m2 DESC
         LIMIT 50`,
        [JSON.stringify(geomGeoJSON)]
    );
    return rows;
};

// ── Bước 3: xã/phường chứa vùng đo ────────────────────────────────────────────
// Lưu ý: gis.administrative_units hiện chỉ có geom cấp huyện và đa số NULL (chờ
// import shapefile ranh giới thực) — trả về null là bình thường cho tới khi có
// dữ liệu ranh giới, cán bộ chọn xã/phường thủ công trong trường hợp đó.
const findCommuneCode = async (geomGeoJSON) => {
    const { rows } = await db.query(
        `SELECT code
         FROM gis.administrative_units
         WHERE geom IS NOT NULL AND ST_Intersects(geom, ST_SetSRID(ST_GeomFromGeoJSON($1), 4326))
         ORDER BY ST_Area(ST_Intersection(geom, ST_SetSRID(ST_GeomFromGeoJSON($1), 4326))) DESC
         LIMIT 1`,
        [JSON.stringify(geomGeoJSON)]
    );
    return rows[0]?.code || null;
};

const create = async (client, payload) => {
    const { rows } = await exec(client)(
        `INSERT INTO gis.field_measurements (
            area_id, layer_id, points, geom, area_m2, avg_accuracy_m, commune_code,
            affected_features, old_land_use, new_land_use, note, device_info,
            measured_by, started_at, finished_at
        ) VALUES (
            $1, $2, $3, ST_SetSRID(ST_GeomFromGeoJSON($4), 4326), $5, $6, $7,
            $8, $9, $10, $11, $12,
            $13, $14, $15
        ) RETURNING ${MEASUREMENT_COLUMNS}`,
        [
            payload.areaId || null,
            payload.layerId || null,
            JSON.stringify(payload.points),
            JSON.stringify(payload.geom),
            payload.areaM2,
            payload.avgAccuracyM,
            payload.communeCode || null,
            JSON.stringify(payload.affectedFeatures || []),
            payload.oldLandUse || null,
            payload.newLandUse || null,
            payload.note || null,
            payload.deviceInfo || {},
            payload.measuredBy || null,
            payload.startedAt || null,
            payload.finishedAt || null,
        ]
    );
    return rows[0];
};

const assignCode = async (client, id) => {
    const year = new Date().getFullYear();
    const code = `DD-${year}-${String(id).padStart(5, '0')}`;
    const { rows } = await exec(client)(
        `UPDATE gis.field_measurements SET code = $2 WHERE id = $1 RETURNING ${MEASUREMENT_COLUMNS}`,
        [id, code]
    );
    return rows[0];
};

const findById = async (id) => {
    const { rows } = await db.query(`SELECT ${MEASUREMENT_COLUMNS} FROM gis.field_measurements WHERE id = $1`, [id]);
    return rows[0] || null;
};

const findAll = async ({ status, communeCode, areaId, measuredBy, from, to, limit = 20, offset = 0 } = {}) => {
    const where = [];
    const params = [];
    if (status) { params.push(status); where.push(`status = $${params.length}`); }
    if (communeCode) { params.push(communeCode); where.push(`commune_code = $${params.length}`); }
    if (areaId) { params.push(areaId); where.push(`area_id = $${params.length}`); }
    if (measuredBy) { params.push(measuredBy); where.push(`measured_by = $${params.length}`); }
    if (from) { params.push(from); where.push(`created_at >= $${params.length}`); }
    if (to) { params.push(to); where.push(`created_at <= $${params.length}`); }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    params.push(limit, offset);
    const { rows } = await db.query(
        `SELECT ${MEASUREMENT_COLUMNS}, COUNT(*) OVER()::int AS total_count
         FROM gis.field_measurements ${whereSql}
         ORDER BY created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
    );
    if (rows.length === 0) { return { items: [], total: 0 }; }
    const total = rows[0].total_count;
    const items = rows.map(({ total_count, ...row }) => row);
    return { items, total };
};

const ALLOWED_UPDATE_FIELDS = ['area_id', 'old_land_use', 'new_land_use', 'note'];
const updateEditable = async (id, payload) => {
    const sets = [];
    const params = [id];
    ALLOWED_UPDATE_FIELDS.forEach((field) => {
        if (Object.prototype.hasOwnProperty.call(payload, field)) {
            params.push(payload[field]);
            sets.push(`${field} = $${params.length}`);
        }
    });
    if (!sets.length) { return findById(id); }
    const { rows } = await db.query(
        `UPDATE gis.field_measurements SET ${sets.join(', ')}, updated_at = NOW()
         WHERE id = $1 AND status IN ('draft','rejected')
         RETURNING ${MEASUREMENT_COLUMNS}`,
        params
    );
    return rows[0] || null;
};

const remove = async (id) => {
    const { rows } = await db.query(
        `DELETE FROM gis.field_measurements WHERE id = $1 AND status = 'draft' RETURNING id`,
        [id]
    );
    return rows[0] || null;
};

const submit = async (id) => {
    const { rows } = await db.query(
        `UPDATE gis.field_measurements SET status = 'submitted', submitted_at = NOW()
         WHERE id = $1 AND status IN ('draft','rejected')
         RETURNING ${MEASUREMENT_COLUMNS}`,
        [id]
    );
    return rows[0] || null;
};

const verify = async (id, verifiedBy) => {
    const { rows } = await db.query(
        `UPDATE gis.field_measurements
         SET status = 'verified', verified_by = $2, verified_at = NOW()
         WHERE id = $1 AND status = 'submitted'
         RETURNING ${MEASUREMENT_COLUMNS}`,
        [id, verifiedBy]
    );
    return rows[0] || null;
};

const reject = async (id, verifiedBy, reviewNote) => {
    const { rows } = await db.query(
        `UPDATE gis.field_measurements
         SET status = 'rejected', verified_by = $2, review_note = $3, verified_at = NOW()
         WHERE id = $1 AND status = 'submitted'
         RETURNING ${MEASUREMENT_COLUMNS}`,
        [id, verifiedBy, reviewNote]
    );
    return rows[0] || null;
};

const addPhoto = async (measurementId, { minioKey, originalName, mimeType, sizeBytes, takenAt, uploadedBy }) => {
    const { rows } = await db.query(
        `INSERT INTO gis.field_measurement_photos
            (measurement_id, minio_key, original_name, mime_type, size_bytes, taken_at, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [measurementId, minioKey, originalName || null, mimeType || null, sizeBytes || null, takenAt || null, uploadedBy || null]
    );
    return rows[0];
};

const listPhotos = async (measurementId) => {
    const { rows } = await db.query(
        `SELECT * FROM gis.field_measurement_photos WHERE measurement_id = $1 ORDER BY created_at ASC`,
        [measurementId]
    );
    return rows;
};

module.exports = {
    buildValidPolygon,
    intersectWithLayer,
    findCommuneCode,
    create,
    assignCode,
    findById,
    findAll,
    updateEditable,
    remove,
    submit,
    verify,
    reject,
    addPhoto,
    listPhotos,
};
