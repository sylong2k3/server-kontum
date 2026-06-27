const feedbackService = require('../services/feedback.service');
const { CREATED, OK, OK_LIST } = require('../core/success.response');
const { t } = require('../utils/i18n.util');
const { buildActor } = require('../utils/actor.util');

const getAnonymousId = (req) => req.get('x-anonymous-id') || null;

const createFeedback = async (req, res) => {
    const result = await feedbackService.createFeedback(buildActor(req), req.body, req.files || [], {
        lang: req.lang,
        anonymousId: getAnonymousId(req),
    });
    const respond = result.duplicated ? OK : CREATED;
    respond(res, result.message, {
        feedback: result.feedback,
        duplicated: result.duplicated,
    });
};

const listFeedback = async (req, res) => {
    const { page, limit } = req.query;
    const { items, total } = await feedbackService.listFeedback(buildActor(req), req.query, { lang: req.lang });
    OK_LIST(res, t('get_list_success', req.lang), items, { page, limit, total });
};

const listMine = async (req, res) => {
    const { page, limit } = req.query;
    const { items, total } = await feedbackService.listMine(buildActor(req), req.query, {
        lang: req.lang,
        anonymousId: getAnonymousId(req),
    });
    OK_LIST(res, t('get_list_success', req.lang), items, { page, limit, total });
};

const getFeedbackById = async (req, res) => {
    const feedback = await feedbackService.getFeedbackById(buildActor(req), Number(req.params.id), {
        lang: req.lang,
        anonymousId: getAnonymousId(req),
    });
    OK(res, t('get_success', req.lang), feedback);
};

const updateStatus = async (req, res) => {
    const result = await feedbackService.updateStatus(buildActor(req), Number(req.params.id), req.body, { lang: req.lang });
    OK(res, result.message, result.feedback);
};

const getMap = async (req, res) => {
    const geojson = await feedbackService.getMap(buildActor(req), req.query, { lang: req.lang });
    OK(res, t('get_success', req.lang), geojson);
};

module.exports = {
    createFeedback,
    listFeedback,
    listMine,
    getFeedbackById,
    updateStatus,
    getMap,
};
