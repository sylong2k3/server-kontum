const commentService = require('../services/comment.service');
const { OK, CREATED, OK_LIST } = require('../core/success.response');
const { t } = require('../utils/i18n.util');
const { buildActor } = require('../utils/actor.util');

const createComment = async (req, res) => {
    const result = await commentService.createComment(
        buildActor(req),
        req.params.slug,
        req.body,
        { lang: req.lang }
    );
    CREATED(res, result.message, result.comment);
};

const listComments = async (req, res) => {
    const { page, limit } = req.query;
    const { items, total } = await commentService.listComments(
        buildActor(req),
        req.params.slug,
        { page, limit },
        { lang: req.lang }
    );
    OK_LIST(res, t('get_list_success', req.lang), items, { page, limit, total });
};

const listAllComments = async (req, res) => {
    const { page, limit, approved, newsId } = req.query;
    const { items, total } = await commentService.listAllComments(
        buildActor(req),
        { page, limit, approved, newsId: req.params.newsId || newsId },
        { lang: req.lang }
    );
    OK_LIST(res, t('get_list_success', req.lang), items, { page, limit, total });
};

const approveComment = async (req, res) => {
    const result = await commentService.approveComment(
        buildActor(req),
        Number(req.params.id), // commentId
        req.body,
        { lang: req.lang }
    );
    OK(res, result.message, result.comment);
};

const deleteComment = async (req, res) => {
    // Public route: /news/:slug/comments/:commentId → dùng commentId
    // Admin route:  /admin/comments/:id              → dùng id
    const commentId = Number(req.params.commentId ?? req.params.id);
    const result = await commentService.deleteComment(
        buildActor(req),
        commentId,
        { lang: req.lang }
    );
    OK(res, result.message, {});
};

module.exports = {
    createComment,
    listComments,
    listAllComments,
    approveComment,
    deleteComment,
};
