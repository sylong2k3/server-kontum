const Joi = require('joi');

const langSchema = Joi.string().valid('vi', 'en').default('vi');

// ─── Params ───────────────────────────────────────────────────────────────────

const newsIdParamsSchema = Joi.object({
    id: Joi.number().integer().positive().required(),
});

const newsSlugParamsSchema = Joi.object({
    slug: Joi.string().trim().min(1).max(255).required(),
});


// ─── List ─────────────────────────────────────────────────────────────────────

const listNewsSchema = Joi.object({
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(100).default(20),
    q: Joi.string().trim().max(255).optional().allow(''),
    status: Joi.string().valid('draft', 'published').optional(),
    lang: langSchema,
    sortBy: Joi.string()
        .valid('id', 'created_at', 'updated_at', 'published_at', 'title')
        .optional()
        .default('created_at'),
    sortOrder: Joi.string().valid('ASC', 'DESC', 'asc', 'desc').optional().default('DESC'),
});

// ─── Create ───────────────────────────────────────────────────────────────────
// Tạo bài mới gồm metadata + bản dịch đầu tiên.

const createNewsSchema = Joi.object({
    lang: langSchema,
    title: Joi.string().trim().min(5).max(255).required(),
    summary: Joi.string().trim().max(500).optional().allow('', null),
    content: Joi.string().min(1).required(),
    status: Joi.string().valid('draft', 'published').default('draft'),
    coverUrl: Joi.string().uri({ allowRelative: true }).max(1000).optional().allow('', null),
});

// ─── Update metadata chung ────────────────────────────────────────────────────
// Dùng cho PATCH /news/admin/:id (không phải bản dịch)

const updateNewsMetaSchema = Joi.object({
    status: Joi.string().valid('draft', 'published').optional(),
    coverUrl: Joi.string().uri({ allowRelative: true }).max(1000).optional().allow('', null),
}).min(1);


// ─── Update gộp metadata + translations ──────────────────────────────────────
// Dùng cho PUT /news/admin/:id — admin sửa toàn bộ rồi bấm Lưu 1 lần.

const translationBodySchema = Joi.object({
    title: Joi.string().trim().min(5).max(255).required(),
    summary: Joi.string().trim().max(500).optional().allow('', null),
    content: Joi.string().min(1).required(),
});

const updateNewsFullSchema = Joi.object({
    status: Joi.string().valid('draft', 'published').optional(),
    coverUrl: Joi.string().uri({ allowRelative: true }).max(1000).optional().allow('', null),
    translations: Joi.object().pattern(
        Joi.string().valid('vi', 'en'),
        translationBodySchema
    ).min(1).required(),
});

module.exports = {
    newsIdParamsSchema,
    newsSlugParamsSchema,
    listNewsSchema,
    createNewsSchema,
    updateNewsMetaSchema,
    updateNewsFullSchema,
};
