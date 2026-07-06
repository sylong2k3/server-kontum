const Joi = require('joi');

const createCommentSchema = Joi.object({
    content: Joi.string().trim().min(1).max(1000).required(),
});

const commentIdParamsSchema = Joi.object({
    id: Joi.number().integer().positive().required(),
});

const newsIdParamsSchema = Joi.object({
    newsId: Joi.number().integer().positive().required(),
});

const newsSlugParamsSchema = Joi.object({
    slug: Joi.string().trim().min(1).max(255).required(),
});

// Params cho route public xóa bình luận: /news/:slug/comments/:commentId
const newsCommentSlugParamsSchema = Joi.object({
    slug: Joi.string().trim().min(1).max(255).required(),
    commentId: Joi.number().integer().positive().required(),
});

const approveCommentSchema = Joi.object({
    isApproved: Joi.boolean().optional().default(true),
});

const listCommentsQuerySchema = Joi.object({
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(100).default(20),
});

// Danh sách bình luận toàn hệ thống cho moderation, lọc theo trạng thái duyệt và tin tức
const listAllCommentsQuerySchema = Joi.object({
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(100).default(20),
    approved: Joi.boolean().optional(),
    newsId: Joi.number().integer().positive().optional(),
});

module.exports = {
    createCommentSchema,
    commentIdParamsSchema,
    newsIdParamsSchema,
    newsSlugParamsSchema,
    newsCommentSlugParamsSchema,
    approveCommentSchema,
    listCommentsQuerySchema,
    listAllCommentsQuerySchema,
};
