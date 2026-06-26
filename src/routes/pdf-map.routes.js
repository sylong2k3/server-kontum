const { Router } = require('express');
const asyncHandler = require('../helpers/async-handler');
const pdfMapController = require('../controllers/pdf-map.controller');
const { verifyToken, requirePermission, enforcePasswordChange, optionalAuth } = require('../middlewares/auth.middleware');
const { validate } = require('../middlewares/validate.middleware');
const { uploadPdfMapFields, handleUploadError } = require('../middlewares/upload.middleware');
const {
    pdfMapIdParamsSchema,
    pdfMapTranslationParamsSchema,
    listPdfMapsSchema,
    createPdfMapSchema,
    updatePdfMapFullSchema,
    upsertPdfMapTranslationSchema,
} = require('../validators/pdf-map.validator');

const publicRouter = Router();
const adminRouter = Router();

// ─── Public endpoints: /api/v1/pdf-maps ────────────────────────────────────────

// GET /pdf-maps — danh sách bản đồ PDF (lọc theme/year), chỉ public với khách
publicRouter.get('/', optionalAuth, validate(listPdfMapsSchema, 'query'), asyncHandler(pdfMapController.listPdfMaps));

// GET /pdf-maps/:id — chi tiết + link tải
publicRouter.get('/:id', optionalAuth, validate(pdfMapIdParamsSchema, 'params'), asyncHandler(pdfMapController.getPdfMapById));

// ─── Admin endpoints: /api/v1/admin/pdf-maps ───────────────────────────────────

// GET /admin/pdf-maps — list toàn bộ (kể cả is_public=false) qua listPdfMaps (role nội bộ)
adminRouter.get(
    '/',
    verifyToken,
    enforcePasswordChange,
    requirePermission('pdf_maps', 'read'),
    validate(listPdfMapsSchema, 'query'),
    asyncHandler(pdfMapController.listPdfMaps)
);

// GET /admin/pdf-maps/:id — admin detail với đầy đủ translations
adminRouter.get(
    '/:id',
    verifyToken,
    enforcePasswordChange,
    requirePermission('pdf_maps', 'read'),
    validate(pdfMapIdParamsSchema, 'params'),
    asyncHandler(pdfMapController.getAdminPdfMapById)
);

// POST /admin/pdf-maps — upload bản đồ PDF mới (file + metadata + bản dịch đầu)
adminRouter.post(
    '/',
    verifyToken,
    enforcePasswordChange,
    requirePermission('pdf_maps', 'create'),
    uploadPdfMapFields,
    handleUploadError,
    validate(createPdfMapSchema),
    asyncHandler(pdfMapController.createPdfMap)
);

// PUT /admin/pdf-maps/:id — update gộp metadata + translations
adminRouter.put(
    '/:id',
    verifyToken,
    enforcePasswordChange,
    requirePermission('pdf_maps', 'update'),
    validate(pdfMapIdParamsSchema, 'params'),
    validate(updatePdfMapFullSchema),
    asyncHandler(pdfMapController.updatePdfMapFull)
);

// PUT /admin/pdf-maps/:id/translations/:lang — upsert 1 bản dịch (vi|en)
adminRouter.put(
    '/:id/translations/:lang',
    verifyToken,
    enforcePasswordChange,
    requirePermission('pdf_map_translations', 'update'),
    validate(pdfMapTranslationParamsSchema, 'params'),
    validate(upsertPdfMapTranslationSchema),
    asyncHandler(pdfMapController.upsertPdfMapTranslation)
);

// DELETE /admin/pdf-maps/:id — soft delete
adminRouter.delete(
    '/:id',
    verifyToken,
    enforcePasswordChange,
    requirePermission('pdf_maps', 'delete'),
    validate(pdfMapIdParamsSchema, 'params'),
    asyncHandler(pdfMapController.deletePdfMap)
);

module.exports = {
    publicRouter,
    adminRouter,
};
