const commentRepository = require('../repositories/comment.repository');
const newsRepository = require('../repositories/news.repository');
const notificationService = require('./notification.service');
const { Api404Error, Api403Error } = require('../core/error.response');
const { hasPermission } = require('../middlewares/auth.middleware');
const { t } = require('../utils/i18n.util');
const { stripTags } = require('../utils/cms.util');

const COMMENT_MODERATOR_ROLES = ['system_admin'];

// Kiểm tra quyền moderation theo RBAC (permissions từ DB), system_admin luôn vượt qua.
const can = (actor, action) =>
    !!actor && (actor.role === 'system_admin' || hasPermission(actor.permissions, 'comments', action));

// Notification là tác vụ phụ: lỗi lưu/push/realtime không được làm hỏng thao tác bình luận.
const dispatchSafe = (fn) => {
    try {
        const result = fn();
        if (result && typeof result.catch === 'function') {
            result.catch((err) => console.error('[COMMENT] notify error:', err.message));
        }
    } catch (err) {
        console.error('[COMMENT] notify error:', err.message);
    }
};

const resolveNewsForComments = async (actor, slug, context = {}) => {
    const publicOnly = !can(actor, 'approve');
    const news = await newsRepository.findBySlug(slug, {
        lang: context.lang,
        publicOnly,
    });
    if (!news) {
        throw new Api404Error(t('news_not_found', context.lang));
    }
    return news;
};

const createComment = async (actor, slug, payload, context = {}) => {
    // Requires authenticated user (verified by verifyToken middleware, which sets actor)
    if (!actor) {
        throw new Api403Error(t('no_permission', context.lang));
    }

    // 1. Citizen comments are only allowed on published news.
    const news = await resolveNewsForComments(actor, slug, context);
    const newsId = news.id;

    // 2. Sanitize content (strip HTML tags completely for security)
    const content = stripTags(payload.content || '').trim();

    // 3. Create comment
    const comment = await commentRepository.create({
        newsId,
        userId: actor.id,
        content,
    });

    const moderationNotification = {
        channel: 'comment',
        type: 'comment_created',
        title: t('comment_notify_new_title', context.lang),
        body: t('comment_notify_new_body', context.lang, {
            userName: comment.userName || `#${actor.id}`,
            newsTitle: news.title,
        }),
        data: {
            commentId: comment.id,
            newsId: comment.newsId,
            newsTitle: news.title,
            newsSlug: news.slug,
            userId: comment.userId,
            path: '/news-comments',
        },
    };
    COMMENT_MODERATOR_ROLES.forEach((roleCode) => {
        dispatchSafe(() => notificationService.broadcastToRole(
            roleCode,
            moderationNotification,
            context
        ));
    });

    return {
        message: t('comment_created_success', context.lang),
        comment,
    };
};

const listComments = async (actor, slug, { page = 1, limit = 20 }, context = {}) => {
    const limitNum = Number(limit);
    const offset = (Number(page) - 1) * limitNum;

    // Moderation check: only users with comments.approve can view unapproved comments.
    const approvedOnly = !can(actor, 'approve');

    // Public users can only list comments for published news; moderators may inspect drafts.
    const news = await resolveNewsForComments(actor, slug, context);
    const newsId = news.id;

    const { items, total } = await commentRepository.findAllByNewsId({ newsId, limit: limitNum, offset, approvedOnly });

    return { items, total };
};

// Danh sách bình luận toàn hệ thống cho moderator duyệt (lọc theo trạng thái duyệt nếu có).
const listAllComments = async (actor, { page = 1, limit = 20, approved, newsId } = {}, context = {}) => {
    if (!can(actor, 'read')) {
        throw new Api403Error(t('no_permission', context.lang));
    }

    const limitNum = Number(limit);
    const offset = (Number(page) - 1) * limitNum;

    const filter = { approved, newsId: newsId ? Number(newsId) : undefined };

    const { items, total } = await commentRepository.findAll({ limit: limitNum, offset, ...filter });

    return { items, total };
};

const getCommentById = async (actor, id, context = {}) => {
    if (!can(actor, 'read')) {
        throw new Api403Error(t('no_permission', context.lang));
    }

    const comment = await commentRepository.findById(id);
    if (!comment) {
        throw new Api404Error(t('comment_not_found', context.lang));
    }

    return { comment };
};

const approveComment = async (actor, id, payload, context = {}) => {
    if (!can(actor, 'approve')) {
        throw new Api403Error(t('no_permission', context.lang));
    }

    const comment = await commentRepository.findById(id);
    if (!comment) {
        throw new Api404Error(t('comment_not_found', context.lang));
    }

    const isApproved = payload.isApproved !== false; // Default to true
    const updated = await commentRepository.updateApproval(id, isApproved);

    if (comment.userId && comment.isApproved !== isApproved) {
        dispatchSafe(() => notificationService.sendToUser(comment.userId, {
            channel: 'comment',
            type: isApproved ? 'comment_approved' : 'comment_rejected',
            title: t(
                isApproved ? 'comment_notify_approved_title' : 'comment_notify_rejected_title',
                context.lang
            ),
            body: t(
                isApproved ? 'comment_notify_approved_body' : 'comment_notify_rejected_body',
                context.lang,
                { newsTitle: comment.newsTitle || `#${comment.newsId}` }
            ),
            data: {
                commentId: comment.id,
                newsId: comment.newsId,
                newsTitle: comment.newsTitle,
                newsSlug: comment.newsSlug,
                isApproved,
                path: comment.newsSlug ? `/news/${comment.newsSlug}` : '/news',
            },
        }, context));
    }

    return {
        message: isApproved ? t('comment_approved_success', context.lang) : t('comment_rejected_success', context.lang),
        comment: updated,
    };
};

const deleteComment = async (actor, id, context = {}) => {
    if (!actor) {
        throw new Api403Error(t('no_permission', context.lang));
    }

    const comment = await commentRepository.findById(id);
    if (!comment) {
        throw new Api404Error(t('comment_not_found', context.lang));
    }

    // Citizen can delete their own comment, but users with comments.delete can delete any comment
    const isOwner = String(comment.userId) === String(actor.id);
    if (!isOwner && !can(actor, 'delete')) {
        throw new Api403Error(t('no_permission', context.lang));
    }

    await commentRepository.softDelete(id);

    if (!isOwner && comment.userId) {
        dispatchSafe(() => notificationService.sendToUser(comment.userId, {
            channel: 'comment',
            type: 'comment_removed',
            title: t('comment_notify_removed_title', context.lang),
            body: t('comment_notify_removed_body', context.lang, {
                newsTitle: comment.newsTitle || `#${comment.newsId}`,
            }),
            data: {
                commentId: comment.id,
                newsId: comment.newsId,
                newsTitle: comment.newsTitle,
                newsSlug: comment.newsSlug,
                path: comment.newsSlug ? `/news/${comment.newsSlug}` : '/news',
            },
        }, context));
    }

    return {
        message: t('comment_deleted_success', context.lang),
    };
};

module.exports = {
    createComment,
    listComments,
    listAllComments,
    getCommentById,
    approveComment,
    deleteComment,
};
