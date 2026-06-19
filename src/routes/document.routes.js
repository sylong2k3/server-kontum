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

const router = Router();

// ─── Public endpoints ─────────────────────────────────────────────────────────

router.get('/', optionalAuth, validate(listDocumentsSchema, 'query'), asyncHandler(documentController.listDocuments));

// ─── Admin endpoints — phải đặt TRƯỚC /:id để tránh conflict ─────────────────

// GET /documents/admin/:id — admin detail với đầy đủ translations
router.get(
    '/admin/:id',
    verifyToken,
    enforcePasswordChange,
    requirePermission('documents', 'read'),
    validate(documentIdParamsSchema, 'params'),
    asyncHandler(documentController.getAdminDocumentById)
);

// PATCH /documents/admin/:id — update metadata chung (docType, isPublic)
router.patch(
    '/admin/:id',
    verifyToken,
    enforcePasswordChange,
    requirePermission('documents', 'update'),
    validate(documentIdParamsSchema, 'params'),
    validate(updateDocumentMetaSchema),
    asyncHandler(documentController.updateDocumentMeta)
);

// PUT /documents/admin/:id — update gộp metadata + translations
router.put(
    '/admin/:id',
    verifyToken,
    enforcePasswordChange,
    requirePermission('documents', 'update'),
    validate(documentIdParamsSchema, 'params'),
    validate(updateDocumentFullSchema),
    asyncHandler(documentController.updateDocumentFull)
);

// POST /documents — upload tài liệu mới (metadata + bản dịch đầu tiên)
router.post(
    '/',
    verifyToken,
    enforcePasswordChange,
    requirePermission('documents', 'create'),
    uploadDocument.single('file'),
    handleUploadError,
    validate(createDocumentSchema),
    asyncHandler(documentController.createDocument)
);

// DELETE /documents/:id
router.delete(
    '/:id',
    verifyToken,
    enforcePasswordChange,
    requirePermission('documents', 'delete'),
    validate(documentIdParamsSchema, 'params'),
    asyncHandler(documentController.deleteDocument)
);

// GET /documents/:id — public detail (phải sau /admin/*)
router.get('/:id', optionalAuth, validate(documentIdParamsSchema, 'params'), asyncHandler(documentController.getDocumentById));

module.exports = router;
