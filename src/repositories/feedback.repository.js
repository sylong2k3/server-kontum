const db = require('../configs/database');

const _escapeLike = (value) => value.replace(/[\\%_]/g, '\\$&');

const SORT_COLUMNS = {
    created_at: 'f.created_at',
    updated_at: 'f.updated_at',
    priority: 'f.priority',
    status: 'f.status',
    category: 'f.category',
};

const normalizeSort = (sortBy = 'created_at', sortOrder = 'DESC') => ({
    column: SORT_COLUMNS[sortBy] || SORT_COLUMNS.created_at,
    direction: String(sortOrder).toUpperCase() === 'ASC' ? 'ASC' : 'DESC',
});

const buildWhere = (filter = {}, startIdx = 1) => {
    const conditions = ['f.deleted_at IS NULL'];
    const params = [];
    let idx = startIdx;

    if (filter.status) {
        params.push(filter.status);
        conditions.push(`f.status = $${idx++}`);
    }
    if (filter.category) {
        params.push(filter.category);
        conditions.push(`f.category = $${idx++}`);
    }
    if (filter.priority) {
        params.push(filter.priority);
        conditions.push(`f.priority = $${idx++}`);
    }
    if (filter.q) {
        params.push(`%${_escapeLike(filter.q)}%`);
        const qi = idx++;
        conditions.push(`(
            CAST(f.id AS TEXT) ILIKE $${qi} ESCAPE '\\'
            OR CAST(f.user_id AS TEXT) ILIKE $${qi} ESCAPE '\\'
            OR COALESCE(f.anonymous_id, '') ILIKE $${qi} ESCAPE '\\'
            OR COALESCE(f.client_uuid, '') ILIKE $${qi} ESCAPE '\\'
            OR f.category ILIKE $${qi} ESCAPE '\\'
            OR f.title ILIKE $${qi} ESCAPE '\\'
            OR COALESCE(f.description, '') ILIKE $${qi} ESCAPE '\\'
            OR f.status ILIKE $${qi} ESCAPE '\\'
            OR f.priority ILIKE $${qi} ESCAPE '\\'
            OR CAST(f.lng AS TEXT) ILIKE $${qi} ESCAPE '\\'
            OR CAST(f.lat AS TEXT) ILIKE $${qi} ESCAPE '\\'
            OR COALESCE(u.full_name, '') ILIKE $${qi} ESCAPE '\\'
            OR COALESCE(cu.full_name, '') ILIKE $${qi} ESCAPE '\\'
            OR COALESCE(uu.full_name, '') ILIKE $${qi} ESCAPE '\\'
            OR to_char(f.created_at, 'YYYY-MM-DD HH24:MI:SS') ILIKE $${qi} ESCAPE '\\'
            OR to_char(f.updated_at, 'YYYY-MM-DD HH24:MI:SS') ILIKE $${qi} ESCAPE '\\'
        )`);
    }
    if (filter.from) {
        params.push(filter.from);
        conditions.push(`f.created_at >= $${idx++}`);
    }
    if (filter.to) {
        params.push(filter.to);
        conditions.push(`f.created_at <= $${idx++}`);
    }
    if (filter.userId) {
        params.push(filter.userId);
        conditions.push(`f.user_id = $${idx++}`);
    }
    if (filter.anonymousId) {
        params.push(filter.anonymousId);
        conditions.push(`f.anonymous_id = $${idx++}`);
    }
    if (filter.bbox) {
        const [minLng, minLat, maxLng, maxLat] = filter.bbox;
        params.push(minLng, minLat, maxLng, maxLat);
        conditions.push(`f.geom && ST_MakeEnvelope($${idx++}, $${idx++}, $${idx++}, $${idx++}, 4326)`);
    }

    return { where: conditions.join(' AND '), params };
};

const selectFeedback = `
    f.id, f.user_id, f.anonymous_id, f.client_uuid,
    f.category, f.title, f.description, f.status, f.priority,
    f.media_urls, f.lng, f.lat, f.created_by, f.updated_by,
    f.resolved_at, f.created_at, f.updated_at,
    u.full_name AS user_name,
    cu.full_name AS created_by_name,
    uu.full_name AS updated_by_name
`;

const joinUsers = `
    LEFT JOIN auth.users u ON u.id = f.user_id
    LEFT JOIN auth.users cu ON cu.id = f.created_by
    LEFT JOIN auth.users uu ON uu.id = f.updated_by
`;

const findDuplicate = async ({ userId, anonymousId, clientUuid }) => {
    if (!clientUuid) {return null;}
    const params = [clientUuid];
    const conditions = ['client_uuid = $1', 'deleted_at IS NULL'];

    if (userId) {
        params.push(userId);
        conditions.push(`user_id = $${params.length}`);
    } else if (anonymousId) {
        params.push(anonymousId);
        conditions.push(`anonymous_id = $${params.length}`);
    } else {
        return null;
    }

    const result = await db.query(
        `SELECT * FROM field.feedback WHERE ${conditions.join(' AND ')} LIMIT 1`,
        params
    );
    return result.rows[0] || null;
};

const create = async ({ userId, anonymousId, clientUuid, category, title, description, priority, mediaUrls, lng, lat, createdBy }) => {
    const result = await db.query(
        `INSERT INTO field.feedback (
            user_id, anonymous_id, client_uuid, category, title, description,
            priority, media_urls, lng, lat, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)
         RETURNING *`,
        [userId || null, anonymousId || null, clientUuid || null, category, title, description || null,
            priority || 'normal', JSON.stringify(mediaUrls || []), lng, lat, createdBy || null]
    );
    return result.rows[0];
};

const findAll = async ({ limit, offset, filter = {}, sortBy, sortOrder }) => {
    const { where, params } = buildWhere(filter, 1);
    const { column, direction } = normalizeSort(sortBy, sortOrder);
    params.push(limit, offset);

    const result = await db.query(
        `SELECT ${selectFeedback},
            COUNT(*) OVER()::int AS total_count
         FROM field.feedback f
         ${joinUsers}
         WHERE ${where}
         ORDER BY ${column} ${direction}, f.id DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
    );

    if (result.rows.length === 0) {
        const total = offset > 0 ? await countAll({ filter }) : 0;
        return { items: [], total };
    }

    const total = result.rows[0].total_count;
    const items = result.rows.map(({ total_count, ...row }) => row);
    return { items, total };
};

const countAll = async ({ filter = {} }) => {
    const { where, params } = buildWhere(filter, 1);
    const result = await db.query(
        `SELECT COUNT(*)::int AS total
         FROM field.feedback f
         ${joinUsers}
         WHERE ${where}`,
        params
    );
    return result.rows[0]?.total || 0;
};

const findById = async (id) => {
    const result = await db.query(
        `SELECT ${selectFeedback}
         FROM field.feedback f
         ${joinUsers}
         WHERE f.id = $1 AND f.deleted_at IS NULL
         LIMIT 1`,
        [id]
    );
    return result.rows[0] || null;
};

const updateStatus = async (id, { toStatus, note, changedBy }) => {
    const client = await db.getClient();
    try {
        await client.query('BEGIN');

        const currentResult = await client.query(
            'SELECT * FROM field.feedback WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
            [id]
        );
        const current = currentResult.rows[0];
        if (!current) {
            await client.query('ROLLBACK');
            return null;
        }

        const resolvedAtSql = toStatus === 'resolved' ? 'NOW()' : 'resolved_at';
        const updateResult = await client.query(
            `UPDATE field.feedback
             SET status = $1,
                 updated_by = $2,
                 resolved_at = ${resolvedAtSql}
             WHERE id = $3 AND deleted_at IS NULL
             RETURNING *`,
            [toStatus, changedBy || null, id]
        );

        await client.query(
            `INSERT INTO field.feedback_status_log (feedback_id, from_status, to_status, note, changed_by)
             VALUES ($1, $2, $3, $4, $5)`,
            [id, current.status, toStatus, note || null, changedBy || null]
        );

        await client.query('COMMIT');
        return updateResult.rows[0];
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
};

const findStatusLogs = async (feedbackId) => {
    const result = await db.query(
        `SELECT l.id, l.feedback_id, l.from_status, l.to_status, l.note,
                l.changed_by, u.full_name AS changed_by_name, l.changed_at
         FROM field.feedback_status_log l
         LEFT JOIN auth.users u ON u.id = l.changed_by
         WHERE l.feedback_id = $1
         ORDER BY l.changed_at DESC, l.id DESC`,
        [feedbackId]
    );
    return result.rows;
};

const findGeoJson = async ({ filter = {} }) => {
    const { where, params } = buildWhere(filter, 1);
    const result = await db.query(
        `SELECT jsonb_build_object(
            'type', 'FeatureCollection',
            'features', COALESCE(jsonb_agg(
                jsonb_build_object(
                    'type', 'Feature',
                    'geometry', ST_AsGeoJSON(f.geom)::jsonb,
                    'properties', jsonb_build_object(
                        'id', f.id,
                        'category', f.category,
                        'title', f.title,
                        'status', f.status,
                        'priority', f.priority,
                        'createdAt', f.created_at
                    )
                ) ORDER BY f.created_at DESC
            ), '[]'::jsonb)
         ) AS geojson
         FROM field.feedback f
         WHERE ${where}`,
        params
    );
    return result.rows[0]?.geojson || { type: 'FeatureCollection', features: [] };
};

module.exports = {
    findDuplicate,
    create,
    findAll,
    countAll,
    findById,
    updateStatus,
    findStatusLogs,
    findGeoJson,
};
