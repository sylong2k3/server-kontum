const db = require('../configs/database');
const { versionCondition } = require('../utils/optimistic-lock.util');

// ─── Sort whitelist ───────────────────────────────────────────────────────────

const PDF_MAP_SORT_COLUMNS = {
    id: 'm.id',
    created_at: 'm.created_at',
    updated_at: 'm.updated_at',
    year: 'm.year',
    theme_code: 'm.theme_code',
    title: 'mt_eff.title',
};

const normalizeSort = (sortBy = 'year', sortOrder = 'DESC') => ({
    column: PDF_MAP_SORT_COLUMNS[sortBy] || PDF_MAP_SORT_COLUMNS.year,
    direction: String(sortOrder).toUpperCase() === 'ASC' ? 'ASC' : 'DESC',
});

// ─── WHERE builder ────────────────────────────────────────────────────────────

const buildWhere = ({ q, theme, year, yearFrom, yearTo, isPublic, publicOnly = true } = {}, startIdx = 1) => {
    const conditions = ['m.deleted_at IS NULL'];
    const params = [];
    let idx = startIdx;

    if (publicOnly) {
        conditions.push('m.is_public = true');
    } else if (isPublic !== undefined) {
        params.push(isPublic);
        conditions.push(`m.is_public = $${idx++}`);
    }

    if (theme) {
        params.push(theme);
        conditions.push(`m.theme_code = $${idx++}`);
    }

    if (year !== undefined) {
        params.push(year);
        conditions.push(`m.year = $${idx++}`);
    }

    if (yearFrom !== undefined) {
        params.push(yearFrom);
        conditions.push(`m.year >= $${idx++}`);
    }

    if (yearTo !== undefined) {
        params.push(yearTo);
        conditions.push(`m.year <= $${idx++}`);
    }

    if (q) {
        params.push(q);
        const qi = idx++;
        conditions.push(
            `(mt_eff.title ILIKE '%' || $${qi} || '%'` +
            ` OR COALESCE(mt_eff.description, '') ILIKE '%' || $${qi} || '%'` +
            ` OR CAST(m.id AS TEXT) ILIKE '%' || $${qi} || '%'` +
            ` OR m.theme_code ILIKE '%' || $${qi} || '%'` +
            ` OR CAST(m.year AS TEXT) ILIKE '%' || $${qi} || '%'` +
            ` OR COALESCE(m.scale, '') ILIKE '%' || $${qi} || '%'` +
            ` OR COALESCE(m.region, '') ILIKE '%' || $${qi} || '%'` +
            ` OR COALESCE(m.file_name, '') ILIKE '%' || $${qi} || '%'` +
            ` OR COALESCE(m.mime_type, '') ILIKE '%' || $${qi} || '%'` +
            ` OR CAST(m.file_size AS TEXT) ILIKE '%' || $${qi} || '%'` +
            ` OR COALESCE(u.full_name, '') ILIKE '%' || $${qi} || '%'` +
            ` OR to_char(m.created_at, 'YYYY-MM-DD HH24:MI:SS') ILIKE '%' || $${qi} || '%'` +
            ` OR to_char(m.updated_at, 'YYYY-MM-DD HH24:MI:SS') ILIKE '%' || $${qi} || '%')`
        );
    }

    return { where: conditions.join(' AND '), params };
};

// ─── Translation join fragment ────────────────────────────────────────────────

const translationJoin = (reqLang = 'vi', fbLang = 'vi') => `
    LEFT JOIN cms.pdf_map_translations mt_req
        ON mt_req.pdf_map_id = m.id AND mt_req.lang = '${reqLang}'
    LEFT JOIN cms.pdf_map_translations mt_fb
        ON mt_fb.pdf_map_id = m.id AND mt_fb.lang = '${fbLang}'
    LEFT JOIN LATERAL (
        SELECT
            COALESCE(mt_req.id, mt_fb.id) AS id,
            COALESCE(mt_req.title, mt_fb.title) AS title,
            COALESCE(mt_req.description, mt_fb.description) AS description,
            CASE WHEN mt_req.id IS NOT NULL THEN '${reqLang}' ELSE '${fbLang}' END AS effective_lang,
            (mt_req.id IS NULL AND mt_fb.id IS NOT NULL) AS fallback_used
    ) mt_eff ON true
`;

const SELECT_COLUMNS = `
    m.id, m.theme_code, m.year, m.scale, m.region,
    m.file_url, m.file_name, m.mime_type, m.file_size, m.thumbnail_url,
    m.is_public, m.uploaded_by, m.created_at, m.updated_at,
    mt_eff.title, mt_eff.description,
    mt_eff.effective_lang AS lang,
    mt_eff.fallback_used,
    u.full_name AS uploaded_by_name
`;

// ─── Public find/list ─────────────────────────────────────────────────────────

const findAll = async ({ limit, offset, filter = {}, publicOnly = true, lang = 'vi' }) => {
    const fbLang = lang === 'vi' ? 'en' : 'vi';
    const { where, params } = buildWhere({ ...filter, publicOnly }, 1);
    const { column, direction } = normalizeSort(filter.sortBy, filter.sortOrder);
    params.push(limit, offset);

    const result = await db.query(
        `SELECT ${SELECT_COLUMNS},
            COUNT(*) OVER()::int AS total_count
         FROM cms.pdf_maps m
         ${translationJoin(lang, fbLang)}
         LEFT JOIN auth.users u ON u.id = m.uploaded_by
         WHERE ${where}
           AND mt_eff.id IS NOT NULL
         ORDER BY ${column} ${direction} NULLS LAST, m.id DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
    );

    if (result.rows.length === 0) {
        const total = offset > 0 ? await countAll({ filter, publicOnly, lang }) : 0;
        return { items: [], total };
    }

    const total = result.rows[0].total_count;
    const items = result.rows.map(({ total_count, ...row }) => row);
    return { items, total };
};

const countAll = async ({ filter = {}, publicOnly = true, lang = 'vi' }) => {
    const fbLang = lang === 'vi' ? 'en' : 'vi';
    const { where, params } = buildWhere({ ...filter, publicOnly }, 1);

    const result = await db.query(
        `SELECT COUNT(*)::int AS total
         FROM cms.pdf_maps m
         ${translationJoin(lang, fbLang)}
         LEFT JOIN auth.users u ON u.id = m.uploaded_by
         WHERE ${where}
           AND mt_eff.id IS NOT NULL`,
        params
    );
    return result.rows[0]?.total || 0;
};

const findById = async (id, { lang = 'vi', publicOnly = true } = {}) => {
    const fbLang = lang === 'vi' ? 'en' : 'vi';
    const params = [id];
    const conditions = ['m.id = $1', 'm.deleted_at IS NULL'];
    if (publicOnly) {conditions.push('m.is_public = true');}

    const result = await db.query(
        `SELECT ${SELECT_COLUMNS}
         FROM cms.pdf_maps m
         ${translationJoin(lang, fbLang)}
         LEFT JOIN auth.users u ON u.id = m.uploaded_by
         WHERE ${conditions.join(' AND ')}
         LIMIT 1`,
        params
    );
    return result.rows[0] || null;
};

// ─── Admin find ───────────────────────────────────────────────────────────────

const findAdminById = async (id) => {
    const mapResult = await db.query(
        `SELECT m.*, u.full_name AS uploaded_by_name
         FROM cms.pdf_maps m
         LEFT JOIN auth.users u ON u.id = m.uploaded_by
         WHERE m.id = $1 AND m.deleted_at IS NULL`,
        [id]
    );
    if (!mapResult.rows[0]) {return null;}

    const pdfMap = mapResult.rows[0];

    const transResult = await db.query(
        `SELECT lang, title, description, created_at, updated_at
         FROM cms.pdf_map_translations
         WHERE pdf_map_id = $1
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

    return { ...pdfMap, translations };
};

// findRaw dùng để check existence trước update/delete
const findRaw = async (id) => {
    const result = await db.query(
        'SELECT * FROM cms.pdf_maps WHERE id = $1 AND deleted_at IS NULL',
        [id]
    );
    return result.rows[0] || null;
};

// ─── Create ───────────────────────────────────────────────────────────────────

const createMeta = async (
    { themeCode, year, scale, region, fileUrl, fileName, mimeType, fileSize, thumbnailUrl, isPublic, uploadedBy },
    options = {}
) => {
    const queryExecutor = options.client || db;
    const result = await queryExecutor.query(
        `INSERT INTO cms.pdf_maps
            (theme_code, year, scale, region, file_url, file_name, mime_type, file_size, thumbnail_url, is_public, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [
            themeCode, year, scale || null, region || null,
            fileUrl, fileName || null, mimeType || null, fileSize || null,
            thumbnailUrl || null, isPublic, uploadedBy,
        ]
    );
    return result.rows[0];
};

const createTranslation = async ({ pdfMapId, lang, title, description }, options = {}) => {
    const queryExecutor = options.client || db;
    const result = await queryExecutor.query(
        `INSERT INTO cms.pdf_map_translations (pdf_map_id, lang, title, description)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [pdfMapId, lang, title, description || null]
    );
    return result.rows[0];
};

// ─── Update ───────────────────────────────────────────────────────────────────

const updateMeta = async (id, payload, options = {}) => {
    const queryExecutor = options.client || db;
    const fields = [];
    const params = [];
    const map = {
        themeCode: 'theme_code',
        year: 'year',
        scale: 'scale',
        region: 'region',
        thumbnailUrl: 'thumbnail_url',
        isPublic: 'is_public',
    };

    Object.entries(map).forEach(([key, col]) => {
        if (Object.prototype.hasOwnProperty.call(payload, key)) {
            params.push(payload[key]);
            fields.push(`${col} = $${params.length}`);
        }
    });

    if (fields.length === 0 && !payload.expectedUpdatedAt) {return findRaw(id);}

    fields.push('updated_at = NOW()');
    params.push(id);
    const idParamIndex = params.length;

    let lockSql = '';
    if (payload.expectedUpdatedAt) {
        params.push(payload.expectedUpdatedAt);
        lockSql = versionCondition(params.length);
    }

    const result = await queryExecutor.query(
        `UPDATE cms.pdf_maps SET ${fields.join(', ')}
         WHERE id = $${idParamIndex} AND deleted_at IS NULL${lockSql} RETURNING *`,
        params
    );
    return result.rows[0] || null;
};

const upsertTranslation = async (pdfMapId, lang, { title, description }, options = {}) => {
    const queryExecutor = options.client || db;
    const result = await queryExecutor.query(
        `INSERT INTO cms.pdf_map_translations (pdf_map_id, lang, title, description)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (pdf_map_id, lang) DO UPDATE
           SET title = EXCLUDED.title,
               description = EXCLUDED.description,
               updated_at = NOW()
         RETURNING *`,
        [pdfMapId, lang, title, description || null]
    );
    return result.rows[0];
};

// ─── Soft delete ──────────────────────────────────────────────────────────────

const softDelete = async (id) => {
    const result = await db.query(
        'UPDATE cms.pdf_maps SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING id',
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
