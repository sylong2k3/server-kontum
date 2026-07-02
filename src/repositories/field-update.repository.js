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

const create = async (client, { userId, layerId, featureId, action, attributes, clientUuid, note, lng, lat }) => {
    const { rows } = await exec(client)(
        `INSERT INTO field.field_updates (user_id, layer_id, feature_id, action, attributes, client_uuid, note, lng, lat)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING *`,
        [userId, layerId, featureId, action, attributes || {}, clientUuid || null, note || null, lng, lat]
    );
    return rows[0];
};

const findSince = async (userId, since) => {
    const params = [userId];
    let where = 'user_id = $1';
    if (since) {
        params.push(since);
        where += ` AND created_at > $${params.length}`;
    }
    const { rows } = await db.query(
        `SELECT fu.id, fu.layer_id, l.code AS layer_code, fu.feature_id, fu.action,
                fu.attributes, fu.client_uuid, fu.note, fu.lng, fu.lat, fu.created_at
         FROM field.field_updates fu
         JOIN gis.layer_registry l ON l.id = fu.layer_id
         WHERE ${where}
         ORDER BY fu.created_at ASC`,
        params
    );
    return rows;
};

module.exports = { create, findDuplicateByClientUuid, findSince };
