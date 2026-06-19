const { Router } = require('express');
const asyncHandler = require('../helpers/async-handler');
const commentController = require('../controllers/comment.controller');
const { verifyToken, requirePermission, enforcePasswordChange } = require('../middlewares/auth.middleware');
const { validate } = require('../middlewares/validate.middleware');
const {
    commentIdParamsSchema,
    approveCommentSchema,
} = require('../validators/comment.validator');

const router = Router();

// PATCH /comments/:id/approve — duyệt hoặc từ chối bình luận (chỉ dành cho admin/so_nnmt)
router.patch(
    '/:id/approve',
    verifyToken,
    enforcePasswordChange,
    requirePermission('comments', 'approve'),
    validate(commentIdParamsSchema, 'params'),
    validate(approveCommentSchema),
    asyncHandler(commentController.approveComment)
);

// DELETE /comments/:id — xóa bình luận (admin/so_nnmt hoặc chính người tạo bình luận)
router.delete(
    '/:id',
    verifyToken,
    enforcePasswordChange,
    validate(commentIdParamsSchema, 'params'),
    asyncHandler(commentController.deleteComment)
);

module.exports = router;
