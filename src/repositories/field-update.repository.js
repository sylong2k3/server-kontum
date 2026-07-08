'use strict';

/**
 * Field Update Repository — bookkeeping cho field.field_updates (mobile field-updates).
 * Chỉ chứa SQL, không chứa business logic.
 */

const db = require('../configs/database');

const exec = (client) => (text, params) => (client ? client.query(text, params) : db.query(text, params));

const findDuplicateByClientUuid = async (userId, clientUuid, client = null) => {
    if (!clientUuid) return null;
    const { rows } = await exec(client)(
        `SELECT * FROM field.field_updates WHERE user_id = $1 AND client_uuid = $2 LIMIT 1`,
        [userId, clientUuid]
    );
    return rows[0] || null;
};

const create = async (client, { userId, layerId, featureId, action, attributes, clientUuid, note, mediaUrls, lng, lat }) => {
    const { rows } = await exec(client)(
        `INSERT INTO field.field_updates (user_id, layer_id, feature_id, action, attributes, client_uuid, note, media_urls, lng, lat)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)
         RETURNING *`,
        [userId, layerId, featureId, action, attributes || {}, clientUuid || null, note || null,
            JSON.stringify(mediaUrls || []), lng, lat]
    );
    return rows[0];
};

const findSince = async (userId, since, limit = 500) => {
    const params = [userId];
    let where = 'user_id = $1';
    if (since) {
        params.push(since);
        where += ` AND created_at > $${params.length}`;
    }
    params.push(limit);
    const { rows } = await db.query(
        `SELECT fu.id, fu.layer_id, l.code AS layer_code, fu.feature_id, fu.action,
                fu.attributes, fu.client_uuid, fu.note, fu.media_urls, fu.lng, fu.lat, fu.created_at
         FROM field.field_updates fu
         JOIN gis.layer_registry l ON l.id = fu.layer_id
         WHERE ${where}
         ORDER BY fu.created_at ASC
         LIMIT $${params.length}`,
        params
    );
    return rows;
};

// Danh sách toàn hệ thống cho báo cáo hiện trường (GET /admin/field-updates) —
// join tên cán bộ + tên lớp để hiển thị, phân trang page/limit như feedback.
const findAllPaged = async ({ page = 1, limit = 20, layerCode, userId, action, from, to }) => {
    const params = [];
    const where = [];
    if (layerCode) {
        params.push(layerCode);
        where.push(`l.code = $${params.length}`);
    }
    if (userId) {
        params.push(userId);
        where.push(`fu.user_id = $${params.length}`);
    }
    if (action) {
        params.push(action);
        where.push(`fu.action = $${params.length}`);
    }
    if (from) {
        params.push(from);
        where.push(`fu.created_at >= $${params.length}`);
    }
    if (to) {
        params.push(to);
        where.push(`fu.created_at <= $${params.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const countResult = await db.query(
        `SELECT COUNT(*)::int AS total
         FROM field.field_updates fu
         JOIN gis.layer_registry l ON l.id = fu.layer_id
         ${whereSql}`,
        params
    );

    params.push(limit, (page - 1) * limit);
    const { rows } = await db.query(
        `SELECT fu.id, fu.layer_id, l.code AS layer_code, l.name_vi AS layer_name,
                fu.feature_id, fu.action, fu.attributes, fu.client_uuid, fu.note,
                fu.media_urls, fu.lng, fu.lat, fu.created_at,
                fu.user_id, u.full_name AS user_name
         FROM field.field_updates fu
         JOIN gis.layer_registry l ON l.id = fu.layer_id
         LEFT JOIN auth.users u ON u.id = fu.user_id
         ${whereSql}
         ORDER BY fu.created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
    );

    return { items: rows, total: countResult.rows[0].total };
};

module.exports = { create, findDuplicateByClientUuid, findSince, findAllPaged };
