const { Router } = require('express');
const asyncHandler = require('../helpers/async-handler');
const feedbackController = require('../controllers/feedback.controller');
const { verifyToken, requirePermission, enforcePasswordChange, optionalAuth } = require('../middlewares/auth.middleware');
const { validate } = require('../middlewares/validate.middleware');
const { uploadMedia, handleUploadError } = require('../middlewares/upload.middleware');
const {
    feedbackIdParamsSchema,
    createFeedbackSchema,
    listFeedbackSchema,
    mapFeedbackSchema,
    updateFeedbackStatusSchema,
} = require('../validators/feedback.validator');

const publicRouter = Router();
const adminRouter = Router();

// ─── Public/Citizen endpoints — mounted at /feedback ─────────────────────────

// POST /feedback — user đăng nhập hoặc ẩn danh với x-anonymous-id.
publicRouter.post(
    '/',
    optionalAuth,
    uploadMedia.array('media', Number(process.env.FEEDBACK_MAX_MEDIA_FILES || 10)),
    handleUploadError,
    validate(createFeedbackSchema),
    asyncHandler(feedbackController.createFeedback)
);

// GET /feedback/mine — lấy phản ánh của JWT user hoặc anonymous id.
publicRouter.get(
    '/mine',
    optionalAuth,
    validate(listFeedbackSchema, 'query'),
    asyncHandler(feedbackController.listMine)
);

// GET /feedback/:id — owner xem chi tiết phản ánh của mình.
publicRouter.get(
    '/:id',
    optionalAuth,
    validate(feedbackIdParamsSchema, 'params'),
    asyncHandler(feedbackController.getFeedbackById)
);

// ─── Admin endpoints — mounted at /admin/feedback ────────────────────────────

// GET /admin/feedback/map — GeoJSON cho dashboard/bản đồ phản ánh.
adminRouter.get(
    '/map',
    verifyToken,
    enforcePasswordChange,
    requirePermission('feedback', 'map'),
    validate(mapFeedbackSchema, 'query'),
    asyncHandler(feedbackController.getMap)
);

// GET /admin/feedback — danh sách quản trị.
adminRouter.get(
    '/',
    verifyToken,
    enforcePasswordChange,
    requirePermission('feedback', 'read'),
    validate(listFeedbackSchema, 'query'),
    asyncHandler(feedbackController.listFeedback)
);

// GET /admin/feedback/:id — staff xem chi tiết phản ánh kèm statusLogs.
adminRouter.get(
    '/:id',
    verifyToken,
    enforcePasswordChange,
    requirePermission('feedback', 'read'),
    validate(feedbackIdParamsSchema, 'params'),
    asyncHandler(feedbackController.getFeedbackById)
);

// PATCH /admin/feedback/:id/status — cán bộ xử lý trạng thái.
adminRouter.patch(
    '/:id/status',
    verifyToken,
    enforcePasswordChange,
    requirePermission('feedback', 'update_status'),
    validate(feedbackIdParamsSchema, 'params'),
    validate(updateFeedbackStatusSchema),
    asyncHandler(feedbackController.updateStatus)
);

module.exports = {
    publicRouter,
    adminRouter,
};
