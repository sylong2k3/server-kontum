const commentService = require('../services/comment.service');
const { OK, CREATED, OK_LIST } = require('../core/success.response');
const { t } = require('../utils/i18n.util');
const { buildActor } = require('../utils/actor.util');

const createComment = async (req, res) => {
    const result = await commentService.createComment(
        buildActor(req),
        Number(req.params.id), // newsId
        req.body,
        { lang: req.lang }
    );
    CREATED(res, result.message, result.comment);
};

const listComments = async (req, res) => {
    const { page, limit } = req.query;
    const { items, total } = await commentService.listComments(
        buildActor(req),
        Number(req.params.id), // newsId
        { page, limit },
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
    const result = await commentService.deleteComment(
        buildActor(req),
        Number(req.params.id), // commentId
        { lang: req.lang }
    );
    OK(res, result.message, {});
};

module.exports = {
    createComment,
    listComments,
    approveComment,
    deleteComment,
};
