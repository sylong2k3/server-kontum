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

const router = Router();

// POST /feedback — user đăng nhập hoặc ẩn danh với x-anonymous-id.
router.post(
    '/',
    optionalAuth,
    uploadMedia.array('media', Number(process.env.FEEDBACK_MAX_MEDIA_FILES || 10)),
    handleUploadError,
    validate(createFeedbackSchema),
    asyncHandler(feedbackController.createFeedback)
);

// GET /feedback/mine — lấy phản ánh của JWT user hoặc anonymous id.
router.get(
    '/mine',
    optionalAuth,
    validate(listFeedbackSchema, 'query'),
    asyncHandler(feedbackController.listMine)
);

// GET /feedback/map — GeoJSON cho dashboard/bản đồ phản ánh.
router.get(
    '/map',
    verifyToken,
    enforcePasswordChange,
    requirePermission('feedback', 'map'),
    validate(mapFeedbackSchema, 'query'),
    asyncHandler(feedbackController.getMap)
);

// GET /feedback — danh sách quản trị.
router.get(
    '/',
    verifyToken,
    enforcePasswordChange,
    requirePermission('feedback', 'read'),
    validate(listFeedbackSchema, 'query'),
    asyncHandler(feedbackController.listFeedback)
);

// GET /feedback/:id — staff xem mọi phản ánh, owner xem phản ánh của mình.
router.get(
    '/:id',
    optionalAuth,
    validate(feedbackIdParamsSchema, 'params'),
    asyncHandler(feedbackController.getFeedbackById)
);

// PATCH /feedback/:id/status — cán bộ xử lý trạng thái.
router.patch(
    '/:id/status',
    verifyToken,
    enforcePasswordChange,
    requirePermission('feedback', 'update_status'),
    validate(feedbackIdParamsSchema, 'params'),
    validate(updateFeedbackStatusSchema),
    asyncHandler(feedbackController.updateStatus)
);

module.exports = router;
