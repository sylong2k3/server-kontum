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
        `SELECT c.id, c.news_id AS "newsId", c.user_id AS "userId", c.content,
                c.is_approved AS "isApproved", c.created_at AS "createdAt", c.updated_at AS "updatedAt",
                u.full_name AS "userName", u.avatar_url AS "userAvatar",
                COUNT(*) OVER()::int AS "totalCount"
         FROM cms.comments c
         LEFT JOIN auth.users u ON c.user_id = u.id
         WHERE ${conditions.join(' AND ')}
         ORDER BY c.created_at DESC
         LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
        params
    );

    if (rows.length === 0) {
        const total = offset > 0 ? await countAllByNewsId({ newsId, approvedOnly }) : 0;
        return { items: [], total };
    }

    const total = rows[0].totalCount;
    const items = rows.map(({ totalCount, ...row }) => row);
    return { items, total };
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

// ─── Admin: list toàn hệ thống cho moderation ──────────────────────────────────

const buildAdminWhere = ({ approved, newsId } = {}, startIdx = 1) => {
    const conditions = ['c.deleted_at IS NULL'];
    const params = [];
    let idx = startIdx;
    if (approved !== undefined) {
        conditions.push(`c.is_approved = $${idx++}`);
        params.push(approved);
    }
    if (newsId !== undefined) {
        conditions.push(`c.news_id = $${idx++}`);
        params.push(newsId);
    }
    return { where: conditions.join(' AND '), params, idx };
};

const findAll = async ({ limit, offset, approved, newsId }) => {
    const { where, params, idx } = buildAdminWhere({ approved, newsId });
    params.push(limit, offset);
    const { rows } = await db.query(
        `SELECT c.id, c.news_id AS "newsId", c.user_id AS "userId", c.content,
                c.is_approved AS "isApproved", c.created_at AS "createdAt", c.updated_at AS "updatedAt",
                u.full_name AS "userName", u.avatar_url AS "userAvatar",
                nt.title AS "newsTitle", nt.slug AS "newsSlug",
                COUNT(*) OVER()::int AS "totalCount"
         FROM cms.comments c
         LEFT JOIN auth.users u ON c.user_id = u.id
         LEFT JOIN LATERAL (
             SELECT title, slug FROM cms.news_translations t
             WHERE t.news_id = c.news_id
             ORDER BY (t.lang = 'vi') DESC
             LIMIT 1
         ) nt ON true
         WHERE ${where}
         ORDER BY c.created_at DESC
         LIMIT $${idx} OFFSET $${idx + 1}`,
        params
    );

    if (rows.length === 0) {
        const total = offset > 0 ? await countAll({ approved, newsId }) : 0;
        return { items: [], total };
    }

    const total = rows[0].totalCount;
    const items = rows.map(({ totalCount, ...row }) => row);
    return { items, total };
};

const countAll = async ({ approved, newsId }) => {
    const { where, params } = buildAdminWhere({ approved, newsId });
    const { rows } = await db.query(
        `SELECT COUNT(c.id)::int AS total FROM cms.comments c WHERE ${where}`,
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
    findAll,
    countAll,
    updateApproval,
    softDelete,
};
