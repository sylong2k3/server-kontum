const { Router } = require('express');
const asyncHandler = require('../helpers/async-handler');
const commentController = require('../controllers/comment.controller');
const { verifyToken, requirePermission, enforcePasswordChange } = require('../middlewares/auth.middleware');
const { validate } = require('../middlewares/validate.middleware');
const {
    commentIdParamsSchema,
    approveCommentSchema,
    listAllCommentsQuerySchema,
} = require('../validators/comment.validator');

const adminRouter = Router();

// GET /admin/comments — moderator xem tất cả bình luận (lọc ?approved=false để duyệt)
adminRouter.get(
    '/',
    verifyToken,
    enforcePasswordChange,
    requirePermission('comments', 'approve'),
    validate(listAllCommentsQuerySchema, 'query'),
    asyncHandler(commentController.listAllComments)
);

// PATCH /admin/comments/:id/approve — duyệt hoặc từ chối bình luận (chỉ dành cho admin/so_nnmt)
adminRouter.patch(
    '/:id/approve',
    verifyToken,
    enforcePasswordChange,
    requirePermission('comments', 'approve'),
    validate(commentIdParamsSchema, 'params'),
    validate(approveCommentSchema),
    asyncHandler(commentController.approveComment)
);

// DELETE /admin/comments/:id — moderator (admin/so_nnmt) xóa bất kỳ bình luận nào
// Citizen tự xóa bình luận của mình qua DELETE /news/:id/comments/:commentId
adminRouter.delete(
    '/:id',
    verifyToken,
    enforcePasswordChange,
    requirePermission('comments', 'delete'),
    validate(commentIdParamsSchema, 'params'),
    asyncHandler(commentController.deleteComment)
);

module.exports = {
    adminRouter,
};
