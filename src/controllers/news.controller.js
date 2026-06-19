const newsService = require('../services/news.service');
const { OK, CREATED, OK_LIST } = require('../core/success.response');
const { t } = require('../utils/i18n.util');
const { buildActor } = require('../utils/actor.util');

// ─── Public ───────────────────────────────────────────────────────────────────

const listNews = async (req, res) => {
    const { page, limit, q, status, lang, sortBy, sortOrder } = req.query;
    const { items, total } = await newsService.listNews(buildActor(req), { page, limit, q, status, lang, sortBy, sortOrder });
    OK_LIST(res, t('get_list_success', req.lang), items, { page, limit, total });
};

const getNewsBySlug = async (req, res) => {
    const lang = req.query.lang || req.lang;
    const news = await newsService.getNewsBySlug(buildActor(req), req.params.slug, { lang });
    OK(res, t('get_success', req.lang), news);
};

// ─── Admin ────────────────────────────────────────────────────────────────────

const getAdminNewsById = async (req, res) => {
    const news = await newsService.getAdminNewsById(buildActor(req), Number(req.params.id), { lang: req.lang });
    OK(res, t('get_success', req.lang), news);
};

const createNews = async (req, res) => {
    const result = await newsService.createNews(buildActor(req), req.body, req.file, { lang: req.lang });
    CREATED(res, result.message, result.news);
};

const updateNewsMeta = async (req, res) => {
    const result = await newsService.updateNewsMeta(buildActor(req), Number(req.params.id), req.body, req.file, { lang: req.lang });
    OK(res, result.message, result.news);
};

const upsertNewsTranslation = async (req, res) => {
    const result = await newsService.upsertNewsTranslation(
        buildActor(req),
        Number(req.params.id),
        req.params.lang,
        req.body,
        { lang: req.lang }
    );
    OK(res, result.message, result.translation);
};

const deleteNews = async (req, res) => {
    const result = await newsService.deleteNews(buildActor(req), Number(req.params.id), { lang: req.lang });
    OK(res, result.message, {});
};

const updateNewsFull = async (req, res) => {
    const result = await newsService.updateNewsFull(buildActor(req), Number(req.params.id), req.body, req.file, { lang: req.lang });
    OK(res, result.message, result.news);
};

module.exports = { listNews, getNewsBySlug, getAdminNewsById, createNews, updateNewsMeta, upsertNewsTranslation, deleteNews, updateNewsFull };
