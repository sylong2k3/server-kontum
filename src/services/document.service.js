const documentRepository = require('../repositories/document.repository');
const { Api400Error, Api404Error, Api403Error } = require('../core/error.response');
const { t } = require('../utils/i18n.util');
const { stripTags, sanitizeHtml, normalizeLang } = require('../utils/cms.util');

const MANAGE_ROLES = ['system_admin', 'so_nnmt'];
const INTERNAL_ROLES = ['system_admin', 'so_nnmt', 'ubnd_tinh'];

const canManage = (actor) => actor && MANAGE_ROLES.includes(actor.role);
const canViewInternal = (actor) => actor && INTERNAL_ROLES.includes(actor.role);

// ─── Response mappers ─────────────────────────────────────────────────────────

const toPublicItem = (doc) => ({
    id: doc.id,
    title: doc.title,
    description: doc.description,
    docType: doc.doc_type,
    fileUrl: doc.file_url,
    fileName: doc.file_name,
    mimeType: doc.mime_type,
    fileSize: doc.file_size,
    isPublic: doc.is_public,
    uploadedBy: doc.uploaded_by,
    uploadedByName: doc.uploaded_by_name,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
    lang: doc.lang,
    fallbackUsed: doc.fallback_used || false,
});

const toAdminDetail = (doc) => ({
    id: doc.id,
    docType: doc.doc_type,
    fileUrl: doc.file_url,
    fileName: doc.file_name,
    mimeType: doc.mime_type,
    fileSize: doc.file_size,
    isPublic: doc.is_public,
    uploadedBy: doc.uploaded_by,
    uploadedByName: doc.uploaded_by_name,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
    translations: doc.translations || {},
});

// ─── Public API ───────────────────────────────────────────────────────────────

const listDocuments = async (actor, { page = 1, limit = 20, q, docType, isPublic, lang = 'vi', sortBy = 'created_at', sortOrder = 'DESC' }) => {
    const resolvedLang = normalizeLang(lang);
    const publicOnly = !canViewInternal(actor);
    const filter = { q, docType, isPublic, sortBy, sortOrder };
    const offset = (Number(page) - 1) * Number(limit);

    const [items, total] = await Promise.all([
        documentRepository.findAll({ limit: Number(limit), offset, filter, publicOnly, lang: resolvedLang }),
        documentRepository.countAll({ filter, publicOnly, lang: resolvedLang }),
    ]);

    return { items: items.map(toPublicItem), total };
};

const getDocumentById = async (actor, id, context = {}) => {
    const lang = normalizeLang(context.lang);
    const doc = await documentRepository.findById(id, {
        lang,
        publicOnly: !canViewInternal(actor),
    });
    if (!doc) throw new Api404Error(t('document_not_found', context.lang));
    return toPublicItem(doc);
};

// ─── Admin API ────────────────────────────────────────────────────────────────

const getAdminDocumentById = async (actor, id, context = {}) => {
    if (!canManage(actor)) throw new Api403Error(t('no_permission', context.lang));
    const doc = await documentRepository.findAdminById(id);
    if (!doc) throw new Api404Error(t('document_not_found', context.lang));
    return toAdminDetail(doc);
};

const createDocument = async (actor, payload, file, context = {}) => {
    if (!canManage(actor)) throw new Api403Error(t('no_permission', context.lang, { roles: MANAGE_ROLES.join(', ') }));
    if (!file) throw new Api400Error(t('upload_no_file', context.lang));

    const lang = normalizeLang(payload.lang);
    const title = stripTags(payload.title);
    const description = payload.description ? sanitizeHtml(payload.description) : null;

    // 1. Tạo metadata row
    const meta = await documentRepository.createMeta({
        docType: payload.docType,
        fileUrl: `${file._relativeDir}/${file.filename}`,
        fileName: file.originalname,
        mimeType: file.mimetype,
        fileSize: file.size,
        isPublic: payload.isPublic === true,
        uploadedBy: actor.id,
    });

    // 2. Tạo translation
    const translation = await documentRepository.createTranslation({
        documentId: meta.id,
        lang,
        title,
        description,
    });

    return {
        message: t('document_created_success', context.lang),
        document: {
            id: meta.id,
            docType: meta.doc_type,
            fileUrl: meta.file_url,
            isPublic: meta.is_public,
            lang: translation.lang,
            title: translation.title,
            description: translation.description,
            createdAt: meta.created_at,
        },
    };
};

const updateDocumentMeta = async (actor, id, payload, context = {}) => {
    if (!canManage(actor)) throw new Api403Error(t('no_permission', context.lang, { roles: MANAGE_ROLES.join(', ') }));

    const existing = await documentRepository.findRaw(id);
    if (!existing) throw new Api404Error(t('document_not_found', context.lang));

    const updated = await documentRepository.updateMeta(id, payload);
    if (!updated) throw new Api404Error(t('document_not_found', context.lang));

    return { message: t('document_updated_success', context.lang), document: { id: updated.id, docType: updated.doc_type, isPublic: updated.is_public } };
};

const upsertDocumentTranslation = async (actor, id, lang, payload, context = {}) => {
    if (!canManage(actor)) throw new Api403Error(t('no_permission', context.lang, { roles: MANAGE_ROLES.join(', ') }));

    const existing = await documentRepository.findRaw(id);
    if (!existing) throw new Api404Error(t('document_not_found', context.lang));

    const resolvedLang = normalizeLang(lang);
    const title = stripTags(payload.title);
    const description = payload.description ? sanitizeHtml(payload.description) : null;

    const translation = await documentRepository.upsertTranslation(id, resolvedLang, { title, description });

    return {
        message: t('document_updated_success', context.lang),
        translation: {
            documentId: id,
            lang: translation.lang,
            title: translation.title,
            description: translation.description,
        },
    };
};

const deleteDocument = async (actor, id, context = {}) => {
    if (!canManage(actor)) throw new Api403Error(t('no_permission', context.lang, { roles: MANAGE_ROLES.join(', ') }));
    const deleted = await documentRepository.softDelete(id);
    if (!deleted) throw new Api404Error(t('document_not_found', context.lang));
    return { message: t('document_deleted_success', context.lang) };
};

module.exports = { listDocuments, getDocumentById, getAdminDocumentById, createDocument, updateDocumentMeta, upsertDocumentTranslation, deleteDocument };
