const commentRepository = require('../repositories/comment.repository');
const newsRepository = require('../repositories/news.repository');
const { Api404Error, Api403Error } = require('../core/error.response');
const { t } = require('../utils/i18n.util');
const { stripTags } = require('../utils/cms.util');

const MODERATOR_ROLES = ['system_admin', 'so_nnmt'];

const canModerate = (actor) => actor && MODERATOR_ROLES.includes(actor.role);

const createComment = async (actor, newsId, payload, context = {}) => {
    // Requires authenticated user (verified by verifyToken middleware, which sets actor)
    if (!actor) {
        throw new Api403Error(t('no_permission', context.lang));
    }

    // 1. Citizen comments are only allowed on published news.
    const news = await newsRepository.findPublishedById(newsId);
    if (!news) {
        throw new Api404Error(t('news_not_found', context.lang));
    }

    // 2. Sanitize content (strip HTML tags completely for security)
    const content = stripTags(payload.content || '').trim();

    // 3. Create comment
    const comment = await commentRepository.create({
        newsId,
        userId: actor.id,
        content,
    });

    return {
        message: t('comment_created_success', context.lang),
        comment,
    };
};

const listComments = async (actor, newsId, { page = 1, limit = 20 }, context = {}) => {
    const limitNum = Number(limit);
    const offset = (Number(page) - 1) * limitNum;

    // Moderation check: only admins/moderators can view unapproved comments.
    const approvedOnly = !canModerate(actor);

    // Public users can only list comments for published news; moderators may inspect drafts.
    const news = approvedOnly
        ? await newsRepository.findPublishedById(newsId)
        : await newsRepository.findAdminById(newsId);
    if (!news) {
        throw new Api404Error(t('news_not_found', context.lang));
    }

    const [items, total] = await Promise.all([
        commentRepository.findAllByNewsId({ newsId, limit: limitNum, offset, approvedOnly }),
        commentRepository.countAllByNewsId({ newsId, approvedOnly }),
    ]);

    return { items, total };
};

const approveComment = async (actor, id, payload, context = {}) => {
    if (!canModerate(actor)) {
        throw new Api403Error(t('no_permission', context.lang));
    }

    const comment = await commentRepository.findById(id);
    if (!comment) {
        throw new Api404Error(t('comment_not_found', context.lang));
    }

    const isApproved = payload.isApproved !== false; // Default to true
    const updated = await commentRepository.updateApproval(id, isApproved);

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

    // Citizen can delete their own comment, but moderators can delete any comment
    const isOwner = String(comment.userId) === String(actor.id);
    if (!isOwner && !canModerate(actor)) {
        throw new Api403Error(t('no_permission', context.lang));
    }

    await commentRepository.softDelete(id);

    return {
        message: t('comment_deleted_success', context.lang),
    };
};

module.exports = {
    createComment,
    listComments,
    approveComment,
    deleteComment,
};
