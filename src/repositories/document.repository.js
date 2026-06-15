const db = require('../configs/database');

// ─── Sort whitelist ───────────────────────────────────────────────────────────

const DOCUMENT_SORT_COLUMNS = {
    id: 'd.id',
    created_at: 'd.created_at',
    updated_at: 'd.updated_at',
    title: 'dt_eff.title',
    doc_type: 'd.doc_type',
};

const normalizeSort = (sortBy = 'created_at', sortOrder = 'DESC') => ({
    column: DOCUMENT_SORT_COLUMNS[sortBy] || DOCUMENT_SORT_COLUMNS.created_at,
    direction: String(sortOrder).toUpperCase() === 'ASC' ? 'ASC' : 'DESC',
});

// ─── WHERE builder ────────────────────────────────────────────────────────────

const buildWhere = ({ q, docType, isPublic, publicOnly = true } = {}, startIdx = 1) => {
    const conditions = ['d.deleted_at IS NULL'];
    const params = [];
    let idx = startIdx;

    if (publicOnly) {
        conditions.push('d.is_public = true');
    } else if (isPublic !== undefined) {
        params.push(isPublic);
        conditions.push(`d.is_public = $${idx++}`);
    }

    if (docType) {
        params.push(docType);
        conditions.push(`d.doc_type = $${idx++}`);
    }

    if (q) {
        params.push(q);
        const qi = idx++;
        conditions.push(
            `(dt_eff.title ILIKE '%' || $${qi} || '%'` +
            ` OR dt_eff.description ILIKE '%' || $${qi} || '%')`
        );
    }

    return { where: conditions.join(' AND '), params };
};

// ─── Translation join fragment ────────────────────────────────────────────────

const translationJoin = (reqLang = 'vi', fbLang = 'vi') => `
    LEFT JOIN cms.document_translations dt_req
        ON dt_req.document_id = d.id AND dt_req.lang = '${reqLang}'
    LEFT JOIN cms.document_translations dt_fb
        ON dt_fb.document_id = d.id AND dt_fb.lang = '${fbLang}'
    LEFT JOIN LATERAL (
        SELECT
            COALESCE(dt_req.id, dt_fb.id) AS id,
            COALESCE(dt_req.title, dt_fb.title) AS title,
            COALESCE(dt_req.description, dt_fb.description) AS description,
            CASE WHEN dt_req.id IS NOT NULL THEN '${reqLang}' ELSE '${fbLang}' END AS effective_lang,
            (dt_req.id IS NULL AND dt_fb.id IS NOT NULL) AS fallback_used
    ) dt_eff ON true
`;

// ─── Public find/list ─────────────────────────────────────────────────────────

const findAll = async ({ limit, offset, filter = {}, publicOnly = true, lang = 'vi' }) => {
    const fbLang = lang === 'vi' ? 'en' : 'vi';
    const { where, params } = buildWhere({ ...filter, publicOnly }, 1);
    const { column, direction } = normalizeSort(filter.sortBy, filter.sortOrder);
    params.push(limit, offset);

    const result = await db.query(
        `SELECT
            d.id, d.doc_type, d.file_url, d.file_name, d.mime_type,
            d.file_size, d.is_public, d.uploaded_by,
            d.created_at, d.updated_at,
            dt_eff.title, dt_eff.description,
            dt_eff.effective_lang AS lang,
            dt_eff.fallback_used,
            u.full_name AS uploaded_by_name
         FROM cms.documents d
         ${translationJoin(lang, fbLang)}
         LEFT JOIN auth.users u ON u.id = d.uploaded_by
         WHERE ${where}
           AND dt_eff.id IS NOT NULL
         ORDER BY ${column} ${direction} NULLS LAST, d.id DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
    );
    return result.rows;
};

const countAll = async ({ filter = {}, publicOnly = true, lang = 'vi' }) => {
    const fbLang = lang === 'vi' ? 'en' : 'vi';
    const { where, params } = buildWhere({ ...filter, publicOnly }, 1);

    const result = await db.query(
        `SELECT COUNT(*)::int AS total
         FROM cms.documents d
         ${translationJoin(lang, fbLang)}
         WHERE ${where}
           AND dt_eff.id IS NOT NULL`,
        params
    );
    return result.rows[0]?.total || 0;
};

const findById = async (id, { lang = 'vi', publicOnly = true } = {}) => {
    const fbLang = lang === 'vi' ? 'en' : 'vi';
    const params = [id];
    const conditions = ['d.id = $1', 'd.deleted_at IS NULL'];
    if (publicOnly) conditions.push('d.is_public = true');

    const result = await db.query(
        `SELECT
            d.id, d.doc_type, d.file_url, d.file_name, d.mime_type,
            d.file_size, d.is_public, d.uploaded_by,
            d.created_at, d.updated_at,
            dt_eff.title, dt_eff.description,
            dt_eff.effective_lang AS lang,
            dt_eff.fallback_used,
            u.full_name AS uploaded_by_name
         FROM cms.documents d
         ${translationJoin(lang, fbLang)}
         LEFT JOIN auth.users u ON u.id = d.uploaded_by
         WHERE ${conditions.join(' AND ')}
         LIMIT 1`,
        params
    );
    return result.rows[0] || null;
};

// ─── Admin find ───────────────────────────────────────────────────────────────

const findAdminById = async (id) => {
    const docResult = await db.query(
        `SELECT d.*, u.full_name AS uploaded_by_name
         FROM cms.documents d
         LEFT JOIN auth.users u ON u.id = d.uploaded_by
         WHERE d.id = $1 AND d.deleted_at IS NULL`,
        [id]
    );
    if (!docResult.rows[0]) return null;

    const doc = docResult.rows[0];

    const transResult = await db.query(
        `SELECT lang, title, description, created_at, updated_at
         FROM cms.document_translations
         WHERE document_id = $1
         ORDER BY lang`,
        [id]
    );

    const translations = {};
    transResult.rows.forEach((row) => {
        translations[row.lang] = {
            title: row.title,
            description: row.description,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        };
    });

    return { ...doc, translations };
};

// findRaw dùng để check existence trước update/delete
const findRaw = async (id) => {
    const result = await db.query(
        'SELECT * FROM cms.documents WHERE id = $1 AND deleted_at IS NULL',
        [id]
    );
    return result.rows[0] || null;
};

// ─── Create ───────────────────────────────────────────────────────────────────

const createMeta = async ({ docType, fileUrl, fileName, mimeType, fileSize, isPublic, uploadedBy }) => {
    const result = await db.query(
        `INSERT INTO cms.documents (doc_type, file_url, file_name, mime_type, file_size, is_public, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [docType, fileUrl, fileName || null, mimeType || null, fileSize || null, isPublic, uploadedBy]
    );
    return result.rows[0];
};

const createTranslation = async ({ documentId, lang, title, description }) => {
    const result = await db.query(
        `INSERT INTO cms.document_translations (document_id, lang, title, description)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [documentId, lang, title, description || null]
    );
    return result.rows[0];
};

// ─── Update ───────────────────────────────────────────────────────────────────

const updateMeta = async (id, payload) => {
    const fields = [];
    const params = [];
    const map = {
        docType: 'doc_type',
        isPublic: 'is_public',
    };

    Object.entries(map).forEach(([key, col]) => {
        if (Object.prototype.hasOwnProperty.call(payload, key)) {
            params.push(payload[key]);
            fields.push(`${col} = $${params.length}`);
        }
    });

    if (fields.length === 0) return findRaw(id);

    params.push(id);
    const result = await db.query(
        `UPDATE cms.documents SET ${fields.join(', ')}
         WHERE id = $${params.length} AND deleted_at IS NULL RETURNING *`,
        params
    );
    return result.rows[0] || null;
};

const upsertTranslation = async (documentId, lang, { title, description }) => {
    const result = await db.query(
        `INSERT INTO cms.document_translations (document_id, lang, title, description)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (document_id, lang) DO UPDATE
           SET title = EXCLUDED.title,
               description = EXCLUDED.description
         RETURNING *`,
        [documentId, lang, title, description || null]
    );
    return result.rows[0];
};

// ─── Soft delete ──────────────────────────────────────────────────────────────

const softDelete = async (id) => {
    const result = await db.query(
        'UPDATE cms.documents SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING id',
        [id]
    );
    return result.rowCount > 0;
};

module.exports = {
    findAll,
    countAll,
    findById,
    findAdminById,
    findRaw,
    createMeta,
    createTranslation,
    updateMeta,
    upsertTranslation,
    softDelete,
};
