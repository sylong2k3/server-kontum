const pdfMapService = require('../services/pdf-map.service');
const { OK, CREATED, OK_LIST } = require('../core/success.response');
const { t } = require('../utils/i18n.util');
const { buildActor } = require('../utils/actor.util');

// ─── Public ───────────────────────────────────────────────────────────────────

const listPdfMaps = async (req, res) => {
    const { page, limit, q, theme, year, yearFrom, yearTo, isPublic, lang, sortBy, sortOrder } = req.query;
    const { items, total } = await pdfMapService.listPdfMaps(buildActor(req), {
        page, limit, q, theme, year, yearFrom, yearTo, isPublic, lang, sortBy, sortOrder,
    });
    OK_LIST(res, t('get_list_success', req.lang), items, { page, limit, total });
};

const getPdfMapById = async (req, res) => {
    const lang = req.query.lang || req.lang;
    const pdfMap = await pdfMapService.getPdfMapById(buildActor(req), Number(req.params.id), { lang });
    OK(res, t('get_success', req.lang), pdfMap);
};

// ─── Admin ────────────────────────────────────────────────────────────────────

const getAdminPdfMapById = async (req, res) => {
    const pdfMap = await pdfMapService.getAdminPdfMapById(buildActor(req), Number(req.params.id), { lang: req.lang });
    OK(res, t('get_success', req.lang), pdfMap);
};

const createPdfMap = async (req, res) => {
    // req.files từ multer.fields(): { file: [FileObj], thumbnail: [FileObj] }
    const pdfFile = req.files?.file?.[0] || null;
    const thumbnailFile = req.files?.thumbnail?.[0] || null;
    const result = await pdfMapService.createPdfMap(buildActor(req), req.body, pdfFile, thumbnailFile, { lang: req.lang });
    CREATED(res, result.message, result.pdfMap);
};

const updatePdfMapFull = async (req, res) => {
    const result = await pdfMapService.updatePdfMapFull(buildActor(req), Number(req.params.id), req.body, { lang: req.lang });
    OK(res, result.message, result.pdfMap);
};

const upsertPdfMapTranslation = async (req, res) => {
    const result = await pdfMapService.upsertPdfMapTranslation(
        buildActor(req),
        Number(req.params.id),
        req.params.lang,
        req.body,
        { lang: req.lang }
    );
    OK(res, result.message, result.translation);
};

const deletePdfMap = async (req, res) => {
    const result = await pdfMapService.deletePdfMap(buildActor(req), Number(req.params.id), { lang: req.lang });
    OK(res, result.message, {});
};

module.exports = {
    listPdfMaps,
    getPdfMapById,
    getAdminPdfMapById,
    createPdfMap,
    updatePdfMapFull,
    upsertPdfMapTranslation,
    deletePdfMap,
};
