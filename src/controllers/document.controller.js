const documentService = require('../services/document.service');
const { OK, CREATED, OK_LIST } = require('../core/success.response');
const { t } = require('../utils/i18n.util');

const buildActor = (req) => req.user ? ({
    id: req.user.id,
    role: req.user.role,
    lang: req.lang,
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
}) : null;

// ─── Public ───────────────────────────────────────────────────────────────────

const listDocuments = async (req, res) => {
    const { page, limit, q, docType, isPublic, lang, sortBy, sortOrder } = req.query;
    const { items, total } = await documentService.listDocuments(buildActor(req), { page, limit, q, docType, isPublic, lang, sortBy, sortOrder });
    OK_LIST(res, t('get_list_success', req.lang), items, { page, limit, total });
};

const getDocumentById = async (req, res) => {
    const lang = req.query.lang || req.lang;
    const document = await documentService.getDocumentById(buildActor(req), Number(req.params.id), { lang });
    OK(res, t('get_success', req.lang), document);
};

// ─── Admin ────────────────────────────────────────────────────────────────────

const getAdminDocumentById = async (req, res) => {
    const document = await documentService.getAdminDocumentById(buildActor(req), Number(req.params.id), { lang: req.lang });
    OK(res, t('get_success', req.lang), document);
};

const createDocument = async (req, res) => {
    const result = await documentService.createDocument(buildActor(req), req.body, req.file, { lang: req.lang });
    CREATED(res, result.message, result.document);
};

const updateDocumentMeta = async (req, res) => {
    const result = await documentService.updateDocumentMeta(buildActor(req), Number(req.params.id), req.body, { lang: req.lang });
    OK(res, result.message, result.document);
};

const upsertDocumentTranslation = async (req, res) => {
    const result = await documentService.upsertDocumentTranslation(
        buildActor(req),
        Number(req.params.id),
        req.params.lang,
        req.body,
        { lang: req.lang }
    );
    OK(res, result.message, result.translation);
};

const deleteDocument = async (req, res) => {
    const result = await documentService.deleteDocument(buildActor(req), Number(req.params.id), { lang: req.lang });
    OK(res, result.message, {});
};

module.exports = { listDocuments, getDocumentById, getAdminDocumentById, createDocument, updateDocumentMeta, upsertDocumentTranslation, deleteDocument };
