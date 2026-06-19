const { Router } = require('express');
const asyncHandler = require('../helpers/async-handler');
const documentController = require('../controllers/document.controller');
const { verifyToken, requirePermission, enforcePasswordChange, optionalAuth } = require('../middlewares/auth.middleware');
const { validate } = require('../middlewares/validate.middleware');
const { uploadDocument, handleUploadError } = require('../middlewares/upload.middleware');
const {
    documentIdParamsSchema,
    listDocumentsSchema,
    createDocumentSchema,
    updateDocumentMetaSchema,
    updateDocumentFullSchema,
} = require('../validators/document.validator');

const publicRouter = Router();
const adminRouter = Router();

// ─── Public endpoints: /api/v1/documents ──────────────────────────────────────

publicRouter.get('/', optionalAuth, validate(listDocumentsSchema, 'query'), asyncHandler(documentController.listDocuments));

// GET /documents/:id — public detail
publicRouter.get('/:id', optionalAuth, validate(documentIdParamsSchema, 'params'), asyncHandler(documentController.getDocumentById));

// ─── Admin endpoints: /api/v1/admin/documents ─────────────────────────────────

// GET /admin/documents/:id — admin detail với đầy đủ translations
adminRouter.get(
    '/:id',
    verifyToken,
    enforcePasswordChange,
    requirePermission('documents', 'read'),
    validate(documentIdParamsSchema, 'params'),
    asyncHandler(documentController.getAdminDocumentById)
);

// POST /admin/documents — upload tài liệu mới (metadata + bản dịch đầu tiên)
adminRouter.post(
    '/',
    verifyToken,
    enforcePasswordChange,
    requirePermission('documents', 'create'),
    uploadDocument.single('file'),
    handleUploadError,
    validate(createDocumentSchema),
    asyncHandler(documentController.createDocument)
);

// PATCH /admin/documents/:id — update metadata chung (docType, isPublic)
adminRouter.patch(
    '/:id',
    verifyToken,
    enforcePasswordChange,
    requirePermission('documents', 'update'),
    validate(documentIdParamsSchema, 'params'),
    validate(updateDocumentMetaSchema),
    asyncHandler(documentController.updateDocumentMeta)
);

// PUT /admin/documents/:id — update gộp metadata + translations
adminRouter.put(
    '/:id',
    verifyToken,
    enforcePasswordChange,
    requirePermission('documents', 'update'),
    validate(documentIdParamsSchema, 'params'),
    validate(updateDocumentFullSchema),
    asyncHandler(documentController.updateDocumentFull)
);

// DELETE /admin/documents/:id
adminRouter.delete(
    '/:id',
    verifyToken,
    enforcePasswordChange,
    requirePermission('documents', 'delete'),
    validate(documentIdParamsSchema, 'params'),
    asyncHandler(documentController.deleteDocument)
);

module.exports = {
    publicRouter,
    adminRouter,
};
