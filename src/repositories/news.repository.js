const db = require('../configs/database');
const { versionCondition } = require('../utils/optimistic-lock.util');

// ─── Sort whitelist ───────────────────────────────────────────────────────────

const NEWS_SORT_COLUMNS = {
    id: 'n.id',
    created_at: 'n.created_at',
    updated_at: 'n.updated_at',
    published_at: 'n.published_at',
    title: 'nt_eff.title',
};

const normalizeSort = (sortBy = 'created_at', sortOrder = 'DESC') => ({
    column: NEWS_SORT_COLUMNS[sortBy] || NEWS_SORT_COLUMNS.created_at,
    direction: String(sortOrder).toUpperCase() === 'ASC' ? 'ASC' : 'DESC',
});

const normalizeListSort = ({ sortBy, sortOrder } = {}, publicOnly = true) => {
    const effectiveSortBy = sortBy || (publicOnly ? 'published_at' : 'created_at');
    return normalizeSort(effectiveSortBy, sortOrder);
};

// ─── WHERE builder ────────────────────────────────────────────────────────────
// Returns { where, params }. Params index starts at startIdx (1-based).

const _escapeLike = (value) => value.replace(/[\\%_]/g, '\\$&');

const buildWhere = ({ q, status, category, publicOnly = true } = {}, startIdx = 1) => {
    const conditions = ['n.deleted_at IS NULL'];
    const params = [];
    let idx = startIdx;

    if (publicOnly) {
        conditions.push("n.status = 'published'");
    } else if (status) {
        params.push(status);
        conditions.push(`n.status = $${idx++}`);
    }

    if (category) {
        params.push(category);
        conditions.push(`n.category = $${idx++}`);
    }

    if (q) {
        params.push(q);
        const tsvIdx = idx++;
        params.push(`%${_escapeLike(q)}%`);
        const likeIdx = idx++;
        conditions.push(
            `(nt_eff.search_tsv @@ plainto_tsquery('simple', $${tsvIdx})` +
            ` OR nt_eff.title ILIKE $${likeIdx} ESCAPE '\\'` +
            ` OR nt_eff.summary ILIKE $${likeIdx} ESCAPE '\\')`
        );
    }

    return { where: conditions.join(' AND '), params };
};

// ─── Translation join fragment ────────────────────────────────────────────────
// Returns effective translation: requested lang or fallback to 'vi'.

const translationJoin = (reqLangParam = '$1', fbLangParam = '$2') => `
    LEFT JOIN cms.news_translations nt_req
        ON nt_req.news_id = n.id AND nt_req.lang = ${reqLangParam}
    LEFT JOIN cms.news_translations nt_fb
        ON nt_fb.news_id = n.id AND nt_fb.lang = ${fbLangParam}
    LEFT JOIN LATERAL (
        SELECT
            COALESCE(nt_req.id, nt_fb.id) AS id,
            COALESCE(nt_req.title, nt_fb.title) AS title,
            COALESCE(nt_req.slug, nt_fb.slug) AS slug,
            COALESCE(nt_req.summary, nt_fb.summary) AS summary,
            COALESCE(nt_req.content, nt_fb.content) AS content,
            COALESCE(nt_req.search_tsv, nt_fb.search_tsv) AS search_tsv,
            CASE WHEN nt_req.id IS NOT NULL THEN ${reqLangParam} ELSE ${fbLangParam} END AS effective_lang,
            (nt_req.id IS NULL AND nt_fb.id IS NOT NULL) AS fallback_used
    ) nt_eff ON true
`;

// ─── Public find/list ─────────────────────────────────────────────────────────

const findAll = async ({ limit, offset, filter = {}, publicOnly = true, lang = 'vi' }) => {
    const fbLang = lang === 'vi' ? 'en' : 'vi';
    const { where, params } = buildWhere({ ...filter, publicOnly }, 3);
    const { column, direction } = normalizeListSort(filter, publicOnly);
    const queryParams = [lang, fbLang, ...params];
    queryParams.push(limit, offset);

    const result = await db.query(
        `SELECT
            n.id, n.cover_url, n.status, n.category, n.author_id, n.published_at,
            n.created_at, n.updated_at,
            nt_eff.title, nt_eff.slug, nt_eff.summary,
            nt_eff.effective_lang AS lang,
            nt_eff.fallback_used,
            u.full_name AS author_name
         FROM cms.news n
         ${translationJoin('$1', '$2')}
         LEFT JOIN auth.users u ON u.id = n.author_id
         WHERE ${where}
           AND nt_eff.id IS NOT NULL
         ORDER BY ${column} ${direction} NULLS LAST, n.id DESC
         LIMIT $${queryParams.length - 1} OFFSET $${queryParams.length}`,
        queryParams
    );
    return result.rows;
};

const countAll = async ({ filter = {}, publicOnly = true, lang = 'vi' }) => {
    const fbLang = lang === 'vi' ? 'en' : 'vi';
    const { where, params } = buildWhere({ ...filter, publicOnly }, 3);
    const queryParams = [lang, fbLang, ...params];

    const result = await db.query(
        `SELECT COUNT(*)::int AS total
         FROM cms.news n
         ${translationJoin('$1', '$2')}
         WHERE ${where}
           AND nt_eff.id IS NOT NULL`,
        queryParams
    );
    return result.rows[0]?.total || 0;
};

const findBySlug = async (slug, { lang = 'vi', publicOnly = true } = {}) => {
    const fbLang = lang === 'vi' ? 'en' : 'vi';
    const params = [lang, fbLang, slug];
    const conditions = ['n.deleted_at IS NULL', 'nt_eff.slug = $3'];
    if (publicOnly) {conditions.push("n.status = 'published'");}

    const result = await db.query(
        `SELECT
            n.id, n.cover_url, n.status, n.category, n.author_id, n.published_at,
            n.created_at, n.updated_at,
            nt_eff.title, nt_eff.slug, nt_eff.summary, nt_eff.content,
            nt_eff.effective_lang AS lang,
            nt_eff.fallback_used,
            u.full_name AS author_name
         FROM cms.news n
         ${translationJoin('$1', '$2')}
         LEFT JOIN auth.users u ON u.id = n.author_id
         WHERE ${conditions.join(' AND ')}
         LIMIT 1`,
        params
    );
    return result.rows[0] || null;
};

// ─── Admin find ───────────────────────────────────────────────────────────────

const findAdminById = async (id) => {
    const newsResult = await db.query(
        `SELECT n.*, u.full_name AS author_name
         FROM cms.news n
         LEFT JOIN auth.users u ON u.id = n.author_id
         WHERE n.id = $1 AND n.deleted_at IS NULL`,
        [id]
    );
    if (!newsResult.rows[0]) {return null;}

    const news = newsResult.rows[0];

    const transResult = await db.query(
        `SELECT lang, title, slug, summary, content, created_at, updated_at
         FROM cms.news_translations
         WHERE news_id = $1
         ORDER BY lang`,
        [id]
    );

    const translations = {};
    transResult.rows.forEach((row) => {
        translations[row.lang] = {
            title: row.title,
            slug: row.slug,
            summary: row.summary,
            content: row.content,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        };
    });

    return { ...news, translations };
};

// findById dùng cho update/soft-delete check (không cần bản dịch)
const findById = async (id) => {
    const result = await db.query(
        'SELECT * FROM cms.news WHERE id = $1 AND deleted_at IS NULL',
        [id]
    );
    return result.rows[0] || null;
};

// findPublishedById dùng cho luồng bình luận công khai — chỉ tin đã xuất bản
const findPublishedById = async (id) => {
    const result = await db.query(
        "SELECT * FROM cms.news WHERE id = $1 AND status = 'published' AND deleted_at IS NULL",
        [id]
    );
    return result.rows[0] || null;
};

// ─── Create ───────────────────────────────────────────────────────────────────

const createMeta = async ({ coverUrl, status, category, authorId, publishedAt }) => {
    const result = await db.query(
        `INSERT INTO cms.news (cover_url, status, category, author_id, published_at)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [coverUrl || null, status, category || 'general', authorId, publishedAt || null]
    );
    return result.rows[0];
};

const createTranslation = async ({ newsId, lang, title, slug, summary, content }) => {
    const result = await db.query(
        `INSERT INTO cms.news_translations (news_id, lang, title, slug, summary, content)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [newsId, lang, title, slug, summary || null, content]
    );
    return result.rows[0];
};

// ─── Slug helpers ─────────────────────────────────────────────────────────────

const translationSlugExists = async (slug, lang, excludeNewsId = null) => {
    const params = [slug, lang];
    let sql = `SELECT 1 FROM cms.news_translations nt
               JOIN cms.news n ON n.id = nt.news_id
               WHERE nt.slug = $1 AND nt.lang = $2 AND n.deleted_at IS NULL`;
    if (excludeNewsId) {
        params.push(excludeNewsId);
        sql += ` AND nt.news_id <> $${params.length}`;
    }
    const result = await db.query(sql, params);
    return result.rowCount > 0;
};

// ─── Update ───────────────────────────────────────────────────────────────────

const updateMeta = async (id, payload, options = {}) => {
    const queryExecutor = options.client || db;
    const fields = [];
    const params = [];
    const map = {
        coverUrl: 'cover_url',
        status: 'status',
        category: 'category',
        publishedAt: 'published_at',
    };

    Object.entries(map).forEach(([key, col]) => {
        if (Object.prototype.hasOwnProperty.call(payload, key)) {
            params.push(payload[key]);
            fields.push(`${col} = $${params.length}`);
        }
    });

    if (fields.length === 0 && !payload.expectedUpdatedAt) {return findById(id);}

    fields.push('updated_at = NOW()');
    params.push(id);
    const idParamIndex = params.length;

    let lockSql = '';
    if (payload.expectedUpdatedAt) {
        params.push(payload.expectedUpdatedAt);
        lockSql = versionCondition(params.length);
    }

    const result = await queryExecutor.query(
        `UPDATE cms.news SET ${fields.join(', ')}
         WHERE id = $${idParamIndex} AND deleted_at IS NULL${lockSql} RETURNING *`,
        params
    );
    return result.rows[0] || null;
};

const upsertTranslation = async (newsId, lang, { title, slug, summary, content }, options = {}) => {
    const queryExecutor = options.client || db;
    const result = await queryExecutor.query(
        `INSERT INTO cms.news_translations (news_id, lang, title, slug, summary, content)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (news_id, lang) DO UPDATE
           SET title = EXCLUDED.title,
               slug  = EXCLUDED.slug,
               summary = EXCLUDED.summary,
               content = EXCLUDED.content,
               updated_at = NOW()
         RETURNING *`,
        [newsId, lang, title, slug, summary || null, content]
    );
    return result.rows[0];
};

// ─── Soft delete ──────────────────────────────────────────────────────────────

const softDelete = async (id) => {
    const result = await db.query(
        'UPDATE cms.news SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING id',
        [id]
    );
    return result.rowCount > 0;
};

module.exports = {
    findAll,
    countAll,
    findBySlug,
    findAdminById,
    findById,
    findPublishedById,
    createMeta,
    createTranslation,
    translationSlugExists,
    updateMeta,
    upsertTranslation,
    softDelete,
};
