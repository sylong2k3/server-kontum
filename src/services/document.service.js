const documentRepository = require('../repositories/document.repository');
const db = require('../configs/database');
const { Api400Error, Api404Error, Api403Error, Api409Error } = require('../core/error.response');
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
    if (!doc) {throw new Api404Error(t('document_not_found', context.lang));}
    return toPublicItem(doc);
};

// ─── Admin API ────────────────────────────────────────────────────────────────

const getAdminDocumentById = async (actor, id, context = {}) => {
    if (!canManage(actor)) {throw new Api403Error(t('no_permission', context.lang));}
    const doc = await documentRepository.findAdminById(id);
    if (!doc) {throw new Api404Error(t('document_not_found', context.lang));}
    return toAdminDetail(doc);
};

const createDocument = async (actor, payload, file, context = {}) => {
    if (!canManage(actor)) {throw new Api403Error(t('no_permission', context.lang, { roles: MANAGE_ROLES.join(', ') }));}
    if (!file) {throw new Api400Error(t('upload_no_file', context.lang));}

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
    if (!canManage(actor)) {throw new Api403Error(t('no_permission', context.lang, { roles: MANAGE_ROLES.join(', ') }));}

    const existing = await documentRepository.findRaw(id);
    if (!existing) {throw new Api404Error(t('document_not_found', context.lang));}

    const updated = await documentRepository.updateMeta(id, payload);
    if (!updated) {throw new Api409Error('Tài liệu đã được cập nhật bởi người dùng khác. Vui lòng tải lại dữ liệu mới nhất.');}

    return { message: t('document_updated_success', context.lang), document: { id: updated.id, docType: updated.doc_type, isPublic: updated.is_public } };
};

const upsertDocumentTranslation = async (actor, id, lang, payload, context = {}) => {
    if (!canManage(actor)) {throw new Api403Error(t('no_permission', context.lang, { roles: MANAGE_ROLES.join(', ') }));}

    const existing = await documentRepository.findRaw(id);
    if (!existing) {throw new Api404Error(t('document_not_found', context.lang));}

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
    if (!canManage(actor)) {throw new Api403Error(t('no_permission', context.lang, { roles: MANAGE_ROLES.join(', ') }));}
    const deleted = await documentRepository.softDelete(id);
    if (!deleted) {throw new Api404Error(t('document_not_found', context.lang));}
    return { message: t('document_deleted_success', context.lang) };
};
const updateDocumentFull = async (actor, id, payload, context = {}) => {
    if (!canManage(actor)) {throw new Api403Error(t('no_permission', context.lang, { roles: MANAGE_ROLES.join(', ') }));}

    const existing = await documentRepository.findRaw(id);
    if (!existing) {throw new Api404Error(t('document_not_found', context.lang));}

    const client = await db.getClient();
    try {
        await client.query('BEGIN');

        // 1. Update metadata nếu có thay đổi, đồng thời check optimistic lock.
        const metaPayload = { expectedUpdatedAt: payload.expectedUpdatedAt };
        if (Object.prototype.hasOwnProperty.call(payload, 'docType')) {metaPayload.docType = payload.docType;}
        if (Object.prototype.hasOwnProperty.call(payload, 'isPublic')) {metaPayload.isPublic = payload.isPublic;}

        const metaUpdated = await documentRepository.updateMeta(id, metaPayload, { client });
        if (!metaUpdated) {
            throw new Api409Error('Tài liệu đã được cập nhật bởi người dùng khác. Vui lòng tải lại dữ liệu mới nhất.');
        }

        // 2. Upsert từng bản dịch trong cùng transaction.
        for (const [lang, body] of Object.entries(payload.translations || {})) {
            const resolvedLang = normalizeLang(lang);
            const title = stripTags(body.title);
            const description = body.description ? sanitizeHtml(body.description) : null;
            await documentRepository.upsertTranslation(id, resolvedLang, { title, description }, { client });
        }

        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }

    // 3. Trả về admin detail đầy đủ
    const updated = await documentRepository.findAdminById(id);
    return {
        message: t('document_updated_success', context.lang),
        document: toAdminDetail(updated),
    };
};

module.exports = { listDocuments, getDocumentById, getAdminDocumentById, createDocument, updateDocumentMeta, upsertDocumentTranslation, deleteDocument, updateDocumentFull };
