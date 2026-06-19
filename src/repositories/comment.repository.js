const db = require('../configs/database');

const COMMENT_SELECT = `
    SELECT c.id, c.news_id AS "newsId", c.user_id AS "userId", c.content, 
           c.is_approved AS "isApproved", c.created_at AS "createdAt", c.updated_at AS "updatedAt",
           u.full_name AS "userName", u.avatar_url AS "userAvatar"
    FROM cms.comments c
    LEFT JOIN auth.users u ON c.user_id = u.id
`;

const findById = async (id) => {
    const { rows } = await db.query(
        `${COMMENT_SELECT} WHERE c.id = $1 AND c.deleted_at IS NULL`,
        [id]
    );
    return rows[0] || null;
};

const create = async ({ newsId, userId, content }) => {
    const { rows } = await db.query(
        `INSERT INTO cms.comments (news_id, user_id, content, is_approved)
         VALUES ($1, $2, $3, false)
         RETURNING id`,
        [newsId, userId, content]
    );
    return rows[0] ? findById(rows[0].id) : null;
};

const findAllByNewsId = async ({ newsId, limit, offset, approvedOnly }) => {
    const params = [newsId];
    const conditions = ['c.news_id = $1', 'c.deleted_at IS NULL'];
    let idx = 2;

    if (approvedOnly) {
        conditions.push(`c.is_approved = true`);
    }

    params.push(limit, offset);
    const limitIdx = idx++;
    const offsetIdx = idx++;

    const { rows } = await db.query(
        `${COMMENT_SELECT}
         WHERE ${conditions.join(' AND ')}
         ORDER BY c.created_at DESC
         LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
        params
    );
    return rows;
};

const countAllByNewsId = async ({ newsId, approvedOnly }) => {
    const params = [newsId];
    const conditions = ['c.news_id = $1', 'c.deleted_at IS NULL'];

    if (approvedOnly) {
        conditions.push(`c.is_approved = true`);
    }

    const { rows } = await db.query(
        `SELECT COUNT(c.id)::int AS total
         FROM cms.comments c
         WHERE ${conditions.join(' AND ')}`,
        params
    );
    return rows[0]?.total || 0;
};

const updateApproval = async (id, isApproved) => {
    const { rows } = await db.query(
        `UPDATE cms.comments
         SET is_approved = $2, updated_at = NOW()
         WHERE id = $1 AND deleted_at IS NULL
         RETURNING id`,
        [id, isApproved]
    );
    return rows[0] ? findById(rows[0].id) : null;
};

const softDelete = async (id) => {
    const { rows } = await db.query(
        `UPDATE cms.comments
         SET deleted_at = NOW()
         WHERE id = $1 AND deleted_at IS NULL
         RETURNING id`,
        [id]
    );
    return rows[0] || null;
};

module.exports = {
    findById,
    create,
    findAllByNewsId,
    countAllByNewsId,
    updateApproval,
    softDelete,
};
