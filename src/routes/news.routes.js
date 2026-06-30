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
    newsCommentParamsSchema,
} = require('../validators/comment.validator');

const publicRouter = Router();
const adminRouter = Router();

// ─── Public endpoints: /api/v1/news ───────────────────────────────────────────

publicRouter.get('/', optionalAuth, validate(listNewsSchema, 'query'), asyncHandler(newsController.listNews));

// GET /news/:id/comments — public list comments (only approved comments unless admin)
publicRouter.get(
    '/:id/comments',
    optionalAuth,
    validate(newsIdParamsSchema, 'params'),
    validate(listCommentsQuerySchema, 'query'),
    asyncHandler(commentController.listComments)
);

// POST /news/:id/comments — tạo bình luận mới (chỉ citizen đã đăng nhập)
publicRouter.post(
    '/:id/comments',
    verifyToken,
    enforcePasswordChange,
    requirePermission('comments', 'create'),
    validate(newsIdParamsSchema, 'params'),
    validate(createCommentSchema),
    asyncHandler(commentController.createComment)
);

// DELETE /news/:id/comments/:commentId — citizen tự xóa bình luận của mình
publicRouter.delete(
    '/:id/comments/:commentId',
    verifyToken,
    enforcePasswordChange,
    requirePermission('comments', 'delete_own'),
    validate(newsCommentParamsSchema, 'params'),
    asyncHandler(commentController.deleteComment)
);

// GET /news/:slug — public detail
publicRouter.get('/:slug', optionalAuth, validate(newsSlugParamsSchema, 'params'), asyncHandler(newsController.getNewsBySlug));

// ─── Admin endpoints: /api/v1/admin/news ──────────────────────────────────────

// GET /admin/news/:id — admin detail với đầy đủ translations
adminRouter.get(
    '/:id',
    verifyToken,
    enforcePasswordChange,
    requirePermission('news', 'read'),
    validate(newsIdParamsSchema, 'params'),
    asyncHandler(newsController.getAdminNewsById)
);

// POST /admin/news — tạo tin mới (metadata + bản dịch đầu tiên)
adminRouter.post(
    '/',
    verifyToken,
    enforcePasswordChange,
    requirePermission('news', 'create'),
    uploadImage.single('cover'),
    handleUploadError,
    validate(createNewsSchema),
    asyncHandler(newsController.createNews)
);

// PATCH /admin/news/:id — update metadata chung (status, cover)
adminRouter.patch(
    '/:id',
    verifyToken,
    enforcePasswordChange,
    requirePermission('news', 'update'),
    validate(newsIdParamsSchema, 'params'),
    uploadImage.single('cover'),
    handleUploadError,
    validate(updateNewsMetaSchema),
    asyncHandler(newsController.updateNewsMeta)
);

// PUT /admin/news/:id — update gộp metadata + tất cả translations (1 request)
adminRouter.put(
    '/:id',
    verifyToken,
    enforcePasswordChange,
    requirePermission('news', 'update'),
    validate(newsIdParamsSchema, 'params'),
    uploadImage.single('cover'),
    handleUploadError,
    validate(updateNewsFullSchema),
    asyncHandler(newsController.updateNewsFull)
);

// DELETE /admin/news/:id
adminRouter.delete(
    '/:id',
    verifyToken,
    enforcePasswordChange,
    requirePermission('news', 'delete'),
    validate(newsIdParamsSchema, 'params'),
    asyncHandler(newsController.deleteNews)
);

module.exports = {
    publicRouter,
    adminRouter,
};
