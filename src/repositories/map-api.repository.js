'use strict';

/**
 * Map API Repository (US-025).
 * Chỉ chứa SQL cho bảng gis.map_apis.
 */

const db = require('../configs/database');

// Cột công khai — KHÔNG bao giờ trả key_hash ra ngoài.
const PUBLIC_COLUMNS = `
    a.id, a.name, a.layer_id, a.key_prefix, a.key_last4, a.scope,
    a.is_active, a.expires_at, a.last_used_at, a.request_count,
    a.created_by, a.created_at, a.updated_at,
    l.code AS layer_code, l.name_vi AS layer_name_vi
`;

const create = async ({ name, layer_id, key_prefix, key_hash, key_last4, scope, is_active, expires_at, created_by }) => {
    const { rows } = await db.query(
        `INSERT INTO gis.map_apis
            (name, layer_id, key_prefix, key_hash, key_last4, scope, is_active, expires_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id`,
        [name, layer_id, key_prefix, key_hash, key_last4, JSON.stringify(scope), is_active, expires_at, created_by],
    );
    return findById(rows[0].id);
};

const findById = async (id) => {
    const { rows } = await db.query(
        `SELECT ${PUBLIC_COLUMNS}
         FROM gis.map_apis a
         JOIN gis.layer_registry l ON l.id = a.layer_id
         WHERE a.id = $1`,
        [id],
    );
    return rows[0] || null;
};

/** Tìm theo key_prefix — trả kèm key_hash + layer để middleware xác thực. */
const findByPrefixWithSecret = async (keyPrefix) => {
    const { rows } = await db.query(
        `SELECT a.*, l.code AS layer_code, l.schema_name, l.table_name,
                l.geometry_column, l.geometry_type, l.epsg_code,
                l.name_vi AS layer_name_vi, l.is_active AS layer_is_active
         FROM gis.map_apis a
         JOIN gis.layer_registry l ON l.id = a.layer_id
         WHERE a.key_prefix = $1
         LIMIT 1`,
        [keyPrefix],
    );
    return rows[0] || null;
};

const list = async ({ limit = 50, offset = 0, layer_id = null, is_active = null } = {}) => {
    const params = [];
    const where = [];
    if (layer_id) { params.push(layer_id); where.push(`a.layer_id = $${params.length}`); }
    if (typeof is_active === 'boolean') { params.push(is_active); where.push(`a.is_active = $${params.length}`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    params.push(limit, offset);
    const [{ rows }, { rows: cnt }] = await Promise.all([
        db.query(
            `SELECT ${PUBLIC_COLUMNS}
             FROM gis.map_apis a
             JOIN gis.layer_registry l ON l.id = a.layer_id
             ${whereSql}
             ORDER BY a.created_at DESC
             LIMIT $${params.length - 1} OFFSET $${params.length}`,
            params,
        ),
        db.query(`SELECT COUNT(*)::int AS total FROM gis.map_apis a ${whereSql}`, params.slice(0, params.length - 2)),
    ]);
    return { items: rows, total: cnt[0].total };
};

const update = async (id, fields) => {
    const allowed = ['name', 'scope', 'is_active', 'expires_at'];
    const sets = [];
    const params = [id];
    allowed.forEach((f) => {
        if (Object.prototype.hasOwnProperty.call(fields, f)) {
            params.push(f === 'scope' ? JSON.stringify(fields[f]) : fields[f]);
            sets.push(`${f} = $${params.length}`);
        }
    });
    if (!sets.length) { return findById(id); }
    const { rowCount } = await db.query(
        `UPDATE gis.map_apis SET ${sets.join(', ')} WHERE id = $1`,
        params,
    );
    if (!rowCount) { return null; }
    return findById(id);
};

/** Xoay key: cập nhật prefix/hash/last4. */
const rotateKey = async (id, { key_prefix, key_hash, key_last4 }) => {
    const { rowCount } = await db.query(
        `UPDATE gis.map_apis
         SET key_prefix = $2, key_hash = $3, key_last4 = $4
         WHERE id = $1`,
        [id, key_prefix, key_hash, key_last4],
    );
    return rowCount > 0;
};

const remove = async (id) => {
    const { rows } = await db.query(`DELETE FROM gis.map_apis WHERE id = $1 RETURNING id`, [id]);
    return rows[0] || null;
};

/** Ghi nhận sử dụng (best-effort, không chặn response). */
const touchUsage = async (id) => {
    await db.query(
        `UPDATE gis.map_apis SET request_count = request_count + 1, last_used_at = NOW() WHERE id = $1`,
        [id],
    );
};

module.exports = {
    create,
    findById,
    findByPrefixWithSecret,
    list,
    update,
    rotateKey,
    remove,
    touchUsage,
};
