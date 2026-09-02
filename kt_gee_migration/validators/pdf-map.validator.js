const Joi = require('joi');

const langSchema = Joi.string().valid('vi', 'en').default('vi');
const THEME_CODES = ['lop_phu_nhiet', 'chay_rung', 'lop_phu_rung', 'khac'];
const MIN_YEAR = 1900;
const MAX_YEAR = 2100;

// ─── Params ───────────────────────────────────────────────────────────────────

const pdfMapIdParamsSchema = Joi.object({
    id: Joi.number().integer().positive().required(),
});

const pdfMapTranslationParamsSchema = Joi.object({
    id: Joi.number().integer().positive().required(),
    lang: Joi.string().valid('vi', 'en').required(),
});

// ─── List ─────────────────────────────────────────────────────────────────────

const listPdfMapsSchema = Joi.object({
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(100).default(20),
    q: Joi.string().trim().max(255).optional().allow(''),
    theme: Joi.string().valid(...THEME_CODES).optional(),
    year: Joi.number().integer().min(MIN_YEAR).max(MAX_YEAR).optional(),
    yearFrom: Joi.number().integer().min(MIN_YEAR).max(MAX_YEAR).optional(),
    yearTo: Joi.number().integer().min(MIN_YEAR).max(MAX_YEAR).optional(),
    isPublic: Joi.boolean().optional(),
    lang: langSchema,
    sortBy: Joi.string()
        .valid('id', 'created_at', 'updated_at', 'year', 'theme_code', 'title')
        .optional()
        .default('year'),
    sortOrder: Joi.string().valid('ASC', 'DESC', 'asc', 'desc').optional().default('DESC'),
});

// ─── Create ───────────────────────────────────────────────────────────────────
// multipart/form-data: file + metadata + bản dịch đầu tiên.

const createPdfMapSchema = Joi.object({
    themeCode: Joi.string().valid(...THEME_CODES).required(),
    year: Joi.number().integer().min(MIN_YEAR).max(MAX_YEAR).required(),
    scale: Joi.string().trim().max(30).optional().allow('', null),
    region: Joi.string().trim().max(150).optional().allow('', null),
    thumbnailUrl: Joi.string().trim().uri({ relativeOnly: false }).max(500).optional().allow('', null),
    isPublic: Joi.boolean().default(false),
    lang: langSchema,
    title: Joi.string().trim().min(3).max(255).required(),
    description: Joi.string().trim().max(2000).optional().allow('', null),
});

// ─── Update gộp metadata + translations ──────────────────────────────────────
// PUT /admin/pdf-maps/:id

const pdfMapTranslationBodySchema = Joi.object({
    title: Joi.string().trim().min(3).max(255).required(),
    description: Joi.string().trim().max(2000).optional().allow('', null),
});

const updatePdfMapFullSchema = Joi.object({
    themeCode: Joi.string().valid(...THEME_CODES).optional(),
    year: Joi.number().integer().min(MIN_YEAR).max(MAX_YEAR).optional(),
    scale: Joi.string().trim().max(30).optional().allow('', null),
    region: Joi.string().trim().max(150).optional().allow('', null),
    thumbnailUrl: Joi.string().trim().uri({ relativeOnly: false }).max(500).optional().allow('', null),
    isPublic: Joi.boolean().optional(),
    expectedUpdatedAt: Joi.date().iso().required(),
    translations: Joi.object().pattern(
        Joi.string().valid('vi', 'en'),
        pdfMapTranslationBodySchema
    ).optional(),
});

// ─── Upsert 1 bản dịch ────────────────────────────────────────────────────────
// PUT /admin/pdf-maps/:id/translations/:lang

const upsertPdfMapTranslationSchema = pdfMapTranslationBodySchema;

module.exports = {
    pdfMapIdParamsSchema,
    pdfMapTranslationParamsSchema,
    listPdfMapsSchema,
    createPdfMapSchema,
    updatePdfMapFullSchema,
    upsertPdfMapTranslationSchema,
    THEME_CODES,
};
