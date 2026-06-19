const { Router } = require('express');
const asyncHandler = require('../helpers/async-handler');
const newsController = require('../controllers/news.controller');
const { verifyToken, requirePermission, enforcePasswordChange, optionalAuth } = require('../middlewares/auth.middleware');
const { validate } = require('../middlewares/validate.middleware');
const { uploadImage, handleUploadError } = require('../middlewares/upload.middleware');
const {
    listNewsSchema,
    newsIdParamsSchema,
    newsSlugParamsSchema,
    createNewsSchema,
    updateNewsMetaSchema,
    updateNewsFullSchema,
} = require('../validators/news.validator');
const commentController = require('../controllers/comment.controller');
const {
    createCommentSchema,
    listCommentsQuerySchema,
} = require('../validators/comment.validator');

const router = Router();

// ─── Public endpoints ─────────────────────────────────────────────────────────

router.get('/', optionalAuth, validate(listNewsSchema, 'query'), asyncHandler(newsController.listNews));

// GET /news/:id/comments — public list comments (only approved comments unless admin)
router.get(
    '/:id/comments',
    optionalAuth,
    validate(newsIdParamsSchema, 'params'),
    validate(listCommentsQuerySchema, 'query'),
    asyncHandler(commentController.listComments)
);

// ─── Admin endpoints — phải đặt TRƯỚC /:slug để tránh conflict ───────────────

// GET /news/admin/:id — admin detail với đầy đủ translations
router.get(
    '/admin/:id',
    verifyToken,
    enforcePasswordChange,
    requirePermission('news', 'read'),
    validate(newsIdParamsSchema, 'params'),
    asyncHandler(newsController.getAdminNewsById)
);

// PATCH /news/admin/:id — update metadata chung (status, cover)
router.patch(
    '/admin/:id',
    verifyToken,
    enforcePasswordChange,
    requirePermission('news', 'update'),
    validate(newsIdParamsSchema, 'params'),
    uploadImage.single('cover'),
    handleUploadError,
    validate(updateNewsMetaSchema),
    asyncHandler(newsController.updateNewsMeta)
);

// PUT /news/admin/:id — update gộp metadata + tất cả translations (1 request)
router.put(
    '/admin/:id',
    verifyToken,
    enforcePasswordChange,
    requirePermission('news', 'update'),
    validate(newsIdParamsSchema, 'params'),
    uploadImage.single('cover'),
    handleUploadError,
    validate(updateNewsFullSchema),
    asyncHandler(newsController.updateNewsFull)
);

// POST /news/:id/comments — tạo bình luận mới (chỉ citizen đã đăng nhập)
router.post(
    '/:id/comments',
    verifyToken,
    enforcePasswordChange,
    requirePermission('comments', 'create'),
    validate(newsIdParamsSchema, 'params'),
    validate(createCommentSchema),
    asyncHandler(commentController.createComment)
);

// POST /news — tạo tin mới (metadata + bản dịch đầu tiên)
router.post(
    '/',
    verifyToken,
    enforcePasswordChange,
    requirePermission('news', 'create'),
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
    requirePermission('news', 'delete'),
    validate(newsIdParamsSchema, 'params'),
    asyncHandler(newsController.deleteNews)
);

// GET /news/:slug — public detail (phải sau tất cả /admin/* để không conflict)
router.get('/:slug', optionalAuth, validate(newsSlugParamsSchema, 'params'), asyncHandler(newsController.getNewsBySlug));

module.exports = router;
