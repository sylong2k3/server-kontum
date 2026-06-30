const Joi = require('joi');

const createCommentSchema = Joi.object({
    content: Joi.string().trim().min(1).max(1000).required(),
});

const commentIdParamsSchema = Joi.object({
    id: Joi.number().integer().positive().required(),
});

// Params cho route public xóa bình luận: /news/:id/comments/:commentId
const newsCommentParamsSchema = Joi.object({
    id: Joi.number().integer().positive().required(), // newsId
    commentId: Joi.number().integer().positive().required(),
});

const approveCommentSchema = Joi.object({
    isApproved: Joi.boolean().optional().default(true),
});

const listCommentsQuerySchema = Joi.object({
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(100).default(20),
});

// Danh sách bình luận toàn hệ thống cho moderation, lọc theo trạng thái duyệt
const listAllCommentsQuerySchema = Joi.object({
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(100).default(20),
    approved: Joi.boolean().optional(),
});

module.exports = {
    createCommentSchema,
    commentIdParamsSchema,
    newsCommentParamsSchema,
    approveCommentSchema,
    listCommentsQuerySchema,
    listAllCommentsQuerySchema,
};
