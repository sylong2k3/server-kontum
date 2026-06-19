const Joi = require('joi');

const langSchema = Joi.string().valid('vi', 'en').default('vi');

// ─── Params ───────────────────────────────────────────────────────────────────

const documentIdParamsSchema = Joi.object({
    id: Joi.number().integer().positive().required(),
});


// ─── List ─────────────────────────────────────────────────────────────────────

const listDocumentsSchema = Joi.object({
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(100).default(20),
    q: Joi.string().trim().max(255).optional().allow(''),
    docType: Joi.string().valid('bao_cao', 'van_ban', 'pdf_map').optional(),
    isPublic: Joi.boolean().optional(),
    lang: langSchema,
    sortBy: Joi.string()
        .valid('id', 'created_at', 'updated_at', 'title', 'doc_type')
        .optional()
        .default('created_at'),
    sortOrder: Joi.string().valid('ASC', 'DESC', 'asc', 'desc').optional().default('DESC'),
});

// ─── Create ───────────────────────────────────────────────────────────────────
// Tạo tài liệu mới = metadata + bản dịch đầu tiên.

const createDocumentSchema = Joi.object({
    lang: langSchema,
    title: Joi.string().trim().min(5).max(255).required(),
    description: Joi.string().trim().max(2000).optional().allow('', null),
    docType: Joi.string().valid('bao_cao', 'van_ban', 'pdf_map').required(),
    isPublic: Joi.boolean().default(false),
});

// ─── Update metadata chung ────────────────────────────────────────────────────
// PATCH /admin/documents/:id

const updateDocumentMetaSchema = Joi.object({
    docType: Joi.string().valid('bao_cao', 'van_ban', 'pdf_map').optional(),
    isPublic: Joi.boolean().optional(),
    expectedUpdatedAt: Joi.date().iso().required(),
}).min(2);

// ─── Update gộp metadata + translations ──────────────────────────────────────
// Dùng cho PUT /admin/documents/:id — admin sửa toàn bộ rồi bấm Lưu 1 lần.

const docTranslationBodySchema = Joi.object({
    title: Joi.string().trim().min(5).max(255).required(),
    description: Joi.string().trim().max(2000).optional().allow('', null),
});

const updateDocumentFullSchema = Joi.object({
    docType: Joi.string().valid('bao_cao', 'van_ban', 'pdf_map').optional(),
    isPublic: Joi.boolean().optional(),
    expectedUpdatedAt: Joi.date().iso().required(),
    translations: Joi.object().pattern(
        Joi.string().valid('vi', 'en'),
        docTranslationBodySchema
    ).min(1).required(),
});

module.exports = {
    documentIdParamsSchema,
    listDocumentsSchema,
    createDocumentSchema,
    updateDocumentMetaSchema,
    updateDocumentFullSchema,
};
