const { Router } = require('express');
const asyncHandler = require('../helpers/async-handler');
const newsController = require('../controllers/news.controller');
const { verifyToken, requireRole, enforcePasswordChange, optionalAuth } = require('../middlewares/auth.middleware');
const { validate } = require('../middlewares/validate.middleware');
const { uploadImage, handleUploadError } = require('../middlewares/upload.middleware');
const {
    listNewsSchema,
    newsIdParamsSchema,
    newsSlugParamsSchema,
    newsTranslationParamsSchema,
    createNewsSchema,
    updateNewsMetaSchema,
    upsertNewsTranslationSchema,
} = require('../validators/news.validator');

const router = Router();

// ─── Public endpoints ─────────────────────────────────────────────────────────

router.get('/', optionalAuth, validate(listNewsSchema, 'query'), asyncHandler(newsController.listNews));

// ─── Admin endpoints — phải đặt TRƯỚC /:slug để tránh conflict ───────────────

// GET /news/admin/:id — admin detail với đầy đủ translations
router.get(
    '/admin/:id',
    verifyToken,
    enforcePasswordChange,
    requireRole('system_admin', 'so_nnmt'),
    validate(newsIdParamsSchema, 'params'),
    asyncHandler(newsController.getAdminNewsById)
);

// PATCH /news/admin/:id — update metadata chung (status, cover)
router.patch(
    '/admin/:id',
    verifyToken,
    enforcePasswordChange,
    requireRole('system_admin', 'so_nnmt'),
    validate(newsIdParamsSchema, 'params'),
    uploadImage.single('cover'),
    handleUploadError,
    validate(updateNewsMetaSchema),
    asyncHandler(newsController.updateNewsMeta)
);

// PATCH /news/admin/:id/translations/:lang — upsert bản dịch
router.patch(
    '/admin/:id/translations/:lang',
    verifyToken,
    enforcePasswordChange,
    requireRole('system_admin', 'so_nnmt'),
    validate(newsTranslationParamsSchema, 'params'),
    validate(upsertNewsTranslationSchema),
    asyncHandler(newsController.upsertNewsTranslation)
);

// POST /news — tạo tin mới (metadata + bản dịch đầu tiên)
router.post(
    '/',
    verifyToken,
    enforcePasswordChange,
    requireRole('system_admin', 'so_nnmt'),
    uploadImage.single('cover'),
    handleUploadError,
    validate(createNewsSchema),
    asyncHandler(newsController.createNews)
);

// DELETE /news/:id
router.delete(
    '/:id',
    verifyToken,
    enforcePasswordChange,
    requireRole('system_admin', 'so_nnmt'),
    validate(newsIdParamsSchema, 'params'),
    asyncHandler(newsController.deleteNews)
);

// GET /news/:slug — public detail (phải sau tất cả /admin/* để không conflict)
router.get('/:slug', optionalAuth, validate(newsSlugParamsSchema, 'params'), asyncHandler(newsController.getNewsBySlug));

module.exports = router;
