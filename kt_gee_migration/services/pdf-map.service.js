const pdfMapRepository = require('../repositories/pdf-map.repository');
const db = require('../configs/database');
const { Api400Error, Api404Error, Api403Error, Api409Error } = require('../core/error.response');
const { t } = require('../utils/i18n.util');
const { stripTags, sanitizeHtml, normalizeLang } = require('../utils/cms.util');

const MANAGE_ROLES = ['system_admin', 'so_nnmt'];
const INTERNAL_ROLES = ['system_admin', 'so_nnmt', 'ubnd_tinh'];

const canManage = (actor) => actor && MANAGE_ROLES.includes(actor.role);
const canViewInternal = (actor) => actor && INTERNAL_ROLES.includes(actor.role);

// ─── Response mappers ─────────────────────────────────────────────────────────

const toPublicItem = (m) => ({
    id: m.id,
    themeCode: m.theme_code,
    year: m.year,
    scale: m.scale,
    region: m.region,
    title: m.title,
    description: m.description,
    fileUrl: m.file_url,
    fileName: m.file_name,
    mimeType: m.mime_type,
    fileSize: m.file_size,
    thumbnailUrl: m.thumbnail_url,
    isPublic: m.is_public,
    uploadedBy: m.uploaded_by,
    uploadedByName: m.uploaded_by_name,
    createdAt: m.created_at,
    updatedAt: m.updated_at,
    lang: m.lang,
    fallbackUsed: m.fallback_used || false,
});

const toAdminDetail = (m) => ({
    id: m.id,
    themeCode: m.theme_code,
    year: m.year,
    scale: m.scale,
    region: m.region,
    fileUrl: m.file_url,
    fileName: m.file_name,
    mimeType: m.mime_type,
    fileSize: m.file_size,
    thumbnailUrl: m.thumbnail_url,
    isPublic: m.is_public,
    uploadedBy: m.uploaded_by,
    uploadedByName: m.uploaded_by_name,
    createdAt: m.created_at,
    updatedAt: m.updated_at,
    translations: m.translations || {},
});

// ─── Public API ───────────────────────────────────────────────────────────────

const listPdfMaps = async (actor, {
    page = 1, limit = 20, q, theme, year, yearFrom, yearTo, isPublic,
    lang = 'vi', sortBy = 'year', sortOrder = 'DESC',
}) => {
    const resolvedLang = normalizeLang(lang);
    const publicOnly = !canViewInternal(actor);
    const filter = { q, theme, year, yearFrom, yearTo, isPublic, sortBy, sortOrder };
    const offset = (Number(page) - 1) * Number(limit);

    const { items, total } = await pdfMapRepository.findAll({ limit: Number(limit), offset, filter, publicOnly, lang: resolvedLang });

    return { items: items.map(toPublicItem), total };
};

const getPdfMapById = async (actor, id, context = {}) => {
    const lang = normalizeLang(context.lang);
    const pdfMap = await pdfMapRepository.findById(id, {
        lang,
        publicOnly: !canViewInternal(actor),
    });
    if (!pdfMap) {throw new Api404Error(t('pdf_map_not_found', context.lang));}
    return toPublicItem(pdfMap);
};

// ─── Admin API ────────────────────────────────────────────────────────────────

const getAdminPdfMapById = async (actor, id, context = {}) => {
    if (!canManage(actor)) {throw new Api403Error(t('no_permission', context.lang, { roles: MANAGE_ROLES.join(', ') }));}
    const pdfMap = await pdfMapRepository.findAdminById(id);
    if (!pdfMap) {throw new Api404Error(t('pdf_map_not_found', context.lang));}
    return toAdminDetail(pdfMap);
};

// pdfFile  — multer file object (bắt buộc), trường "file"
// thumbFile — multer file object (tuỳ chọn), trường "thumbnail"
const createPdfMap = async (actor, payload, pdfFile, thumbFile, context = {}) => {
    if (!canManage(actor)) {throw new Api403Error(t('no_permission', context.lang, { roles: MANAGE_ROLES.join(', ') }));}
    if (!pdfFile) {throw new Api400Error(t('upload_no_file', context.lang));}

    const lang = normalizeLang(payload.lang);
    const title = stripTags(payload.title);
    const description = payload.description ? sanitizeHtml(payload.description) : null;

    // Ưu tiên file upload; fallback sang URL chuỗi nếu admin không đính ảnh
    const thumbnailUrl = thumbFile
        ? `${thumbFile._relativeDir}/${thumbFile.filename}`
        : (payload.thumbnailUrl || null);

    const client = await db.getClient();
    try {
        await client.query('BEGIN');

        // 1. Metadata row
        const meta = await pdfMapRepository.createMeta({
            themeCode: payload.themeCode,
            year: payload.year,
            scale: payload.scale,
            region: payload.region,
            fileUrl: `${pdfFile._relativeDir}/${pdfFile.filename}`,
            fileName: pdfFile.originalname,
            mimeType: pdfFile.mimetype,
            fileSize: pdfFile.size,
            thumbnailUrl,
            isPublic: payload.isPublic === true,
            uploadedBy: actor.id,
        }, { client });

        // 2. Bản dịch đầu tiên
        const translation = await pdfMapRepository.createTranslation({
            pdfMapId: meta.id,
            lang,
            title,
            description,
        }, { client });

        await client.query('COMMIT');

        return {
            message: t('pdf_map_created_success', context.lang),
            pdfMap: {
                id: meta.id,
                themeCode: meta.theme_code,
                year: meta.year,
                scale: meta.scale,
                region: meta.region,
                fileUrl: meta.file_url,
                thumbnailUrl: meta.thumbnail_url,
                isPublic: meta.is_public,
                lang: translation.lang,
                title: translation.title,
                description: translation.description,
                createdAt: meta.created_at,
            },
        };
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
};

const upsertPdfMapTranslation = async (actor, id, lang, payload, context = {}) => {
    if (!canManage(actor)) {throw new Api403Error(t('no_permission', context.lang, { roles: MANAGE_ROLES.join(', ') }));}

    const existing = await pdfMapRepository.findRaw(id);
    if (!existing) {throw new Api404Error(t('pdf_map_not_found', context.lang));}

    const resolvedLang = normalizeLang(lang);
    const title = stripTags(payload.title);
    const description = payload.description ? sanitizeHtml(payload.description) : null;

    const translation = await pdfMapRepository.upsertTranslation(id, resolvedLang, { title, description });

    return {
        message: t('pdf_map_updated_success', context.lang),
        translation: {
            pdfMapId: id,
            lang: translation.lang,
            title: translation.title,
            description: translation.description,
        },
    };
};

const deletePdfMap = async (actor, id, context = {}) => {
    if (!canManage(actor)) {throw new Api403Error(t('no_permission', context.lang, { roles: MANAGE_ROLES.join(', ') }));}
    const deleted = await pdfMapRepository.softDelete(id);
    if (!deleted) {throw new Api404Error(t('pdf_map_not_found', context.lang));}
    return { message: t('pdf_map_deleted_success', context.lang) };
};

// Cập nhật gộp metadata + translations trong cùng 1 transaction.
const updatePdfMapFull = async (actor, id, payload, context = {}) => {
    if (!canManage(actor)) {throw new Api403Error(t('no_permission', context.lang, { roles: MANAGE_ROLES.join(', ') }));}

    const existing = await pdfMapRepository.findRaw(id);
    if (!existing) {throw new Api404Error(t('pdf_map_not_found', context.lang));}

    const client = await db.getClient();
    try {
        await client.query('BEGIN');

        // 1. Update metadata + optimistic lock
        const metaPayload = { expectedUpdatedAt: payload.expectedUpdatedAt };
        ['themeCode', 'year', 'scale', 'region', 'thumbnailUrl', 'isPublic'].forEach((key) => {
            if (Object.prototype.hasOwnProperty.call(payload, key)) {metaPayload[key] = payload[key];}
        });

        const metaUpdated = await pdfMapRepository.updateMeta(id, metaPayload, { client });
        if (!metaUpdated) {
            throw new Api409Error(t('optimistic_lock_conflict', context.lang));
        }

        // 2. Upsert từng bản dịch
        for (const [lang, body] of Object.entries(payload.translations || {})) {
            const resolvedLang = normalizeLang(lang);
            const title = stripTags(body.title);
            const description = body.description ? sanitizeHtml(body.description) : null;
            await pdfMapRepository.upsertTranslation(id, resolvedLang, { title, description }, { client });
        }

        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }

    const updated = await pdfMapRepository.findAdminById(id);
    return {
        message: t('pdf_map_updated_success', context.lang),
        pdfMap: toAdminDetail(updated),
    };
};

module.exports = {
    listPdfMaps,
    getPdfMapById,
    getAdminPdfMapById,
    createPdfMap,
    upsertPdfMapTranslation,
    deletePdfMap,
    updatePdfMapFull,
};
