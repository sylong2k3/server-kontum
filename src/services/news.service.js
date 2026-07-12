const newsRepository = require('../repositories/news.repository');
const db = require('../configs/database');
const { Api404Error, Api403Error, Api409Error } = require('../core/error.response');
const { t } = require('../utils/i18n.util');
const { slugify, stripTags, sanitizeHtml, normalizeLang } = require('../utils/cms.util');

const INTERNAL_ROLES = ['system_admin', 'so_nnmt', 'ubnd_tinh'];

const hasPermission = (actor, resource, action) => {
    if (actor?.role === 'system_admin') {return true;}
    const resourcePerms = actor?.permissions?.[resource];
    return resourcePerms && typeof resourcePerms === 'object' && resourcePerms[action] === true;
};
const canReadNews = (actor) => hasPermission(actor, 'news', 'read');
const canCreateNews = (actor) => hasPermission(actor, 'news', 'create');
const canUpdateNews = (actor) => hasPermission(actor, 'news', 'update');
const canDeleteNews = (actor) => hasPermission(actor, 'news', 'delete');
const canViewInternal = (actor) => actor && INTERNAL_ROLES.includes(actor.role);

// ─── Response mappers ─────────────────────────────────────────────────────────

const toPublicItem = (n) => ({
    id: n.id,
    title: n.title,
    slug: n.slug,
    summary: n.summary,
    coverUrl: n.cover_url,
    status: n.status,
    category: n.category,
    authorId: n.author_id,
    authorName: n.author_name,
    publishedAt: n.published_at,
    createdAt: n.created_at,
    updatedAt: n.updated_at,
    lang: n.lang,
    fallbackUsed: n.fallback_used || false,
});

const toPublicDetail = (n) => ({
    ...toPublicItem(n),
    content: n.content,
});

const toAdminDetail = (n) => ({
    id: n.id,
    coverUrl: n.cover_url,
    status: n.status,
    category: n.category,
    authorId: n.author_id,
    authorName: n.author_name,
    publishedAt: n.published_at,
    createdAt: n.created_at,
    updatedAt: n.updated_at,
    translations: n.translations || {},
});

// ─── Slug builder ─────────────────────────────────────────────────────────────

const buildUniqueSlug = async (title, lang, excludeNewsId = null) => {
    const base = slugify(title);
    let slug = base;
    let suffix = 2;
    while (await newsRepository.translationSlugExists(slug, lang, excludeNewsId)) {
        slug = `${base}-${suffix}`;
        suffix += 1;
    }
    return slug;
};

// ─── Public API ───────────────────────────────────────────────────────────────

const resolveNewsCategory = (actor, category = 'general') => (actor?.role === 'so_nnmt' ? 'so_nnmt' : category);

const assertNewsCategoryAccess = (actor, news, context = {}, action = 'update') => {
    if (actor?.role === 'so_nnmt' && news?.category !== 'so_nnmt') {
        throw new Api403Error(t('no_permission_resource', context.lang, { resource: 'news', action }));
    }
};

const listNews = async (actor, { page = 1, limit = 20, q, status, category, lang = 'vi', sortBy = 'created_at', sortOrder = 'DESC' }) => {
    const resolvedLang = normalizeLang(lang);
    const publicOnly = !canViewInternal(actor);
    const categoryFilter = actor?.role === 'so_nnmt' ? 'so_nnmt' : category;
    const filter = { q, status, category: categoryFilter, sortBy, sortOrder };
    const offset = (Number(page) - 1) * Number(limit);

    const { items, total } = await newsRepository.findAll({ limit: Number(limit), offset, filter, publicOnly, lang: resolvedLang });

    return { items: items.map(toPublicItem), total };
};

const getNewsBySlug = async (actor, slug, context = {}) => {
    const lang = normalizeLang(context.lang);
    const news = await newsRepository.findBySlug(slug, {
        lang,
        publicOnly: !canViewInternal(actor),
    });
    if (!news) {throw new Api404Error(t('news_not_found', context.lang));}
    return toPublicDetail(news);
};

// ─── Admin API ────────────────────────────────────────────────────────────────

const getAdminNewsById = async (actor, id, context = {}) => {
    if (!canReadNews(actor)) {throw new Api403Error(t('no_permission_resource', context.lang, { resource: 'news', action: 'read' }));}
    const news = await newsRepository.findAdminById(id);
    if (!news) {throw new Api404Error(t('news_not_found', context.lang));}
    return toAdminDetail(news);
};

const createNews = async (actor, payload, file, context = {}) => {
    if (!canCreateNews(actor)) {throw new Api403Error(t('no_permission_resource', context.lang, { resource: 'news', action: 'create' }));}

    const lang = normalizeLang(payload.lang);
    const status = payload.status || 'draft';
    const category = resolveNewsCategory(actor, payload.category);
    const title = stripTags(payload.title);
    const slug = await buildUniqueSlug(title, lang);
    const summary = payload.summary ? stripTags(payload.summary) : null;
    const content = sanitizeHtml(payload.content);
    const coverUrl = file ? `${file._relativeDir}/${file.filename}` : payload.coverUrl || null;
    const publishedAt = status === 'published' ? new Date() : null;

    // 1. Tạo metadata row
    const meta = await newsRepository.createMeta({ coverUrl, status, category, authorId: actor.id, publishedAt });

    // 2. Tạo translation
    const translation = await newsRepository.createTranslation({
        newsId: meta.id,
        lang,
        title,
        slug,
        summary,
        content,
    });

    return {
        message: t('news_created_success', context.lang),
        news: {
            id: meta.id,
            coverUrl: meta.cover_url,
            status: meta.status,
            category: meta.category,
            lang: translation.lang,
            title: translation.title,
            slug: translation.slug,
            summary: translation.summary,
            publishedAt: meta.published_at,
            createdAt: meta.created_at,
        },
    };
};

const updateNewsMeta = async (actor, id, payload, file, context = {}) => {
    if (!canUpdateNews(actor)) {throw new Api403Error(t('no_permission_resource', context.lang, { resource: 'news', action: 'update' }));}

    const existing = await newsRepository.findById(id);
    if (!existing) {throw new Api404Error(t('news_not_found', context.lang));}
    assertNewsCategoryAccess(actor, existing, context);

    const updatePayload = {};
    if (Object.prototype.hasOwnProperty.call(payload, 'status')) {
        updatePayload.status = payload.status;
        if (payload.status === 'published' && existing.status !== 'published' && !existing.published_at) {
            updatePayload.publishedAt = new Date();
        }
    }
    if (file) {
        updatePayload.coverUrl = `${file._relativeDir}/${file.filename}`;
    } else if (Object.prototype.hasOwnProperty.call(payload, 'coverUrl')) {
        updatePayload.coverUrl = payload.coverUrl;
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'category')) {
        updatePayload.category = resolveNewsCategory(actor, payload.category);
    }

    updatePayload.expectedUpdatedAt = payload.expectedUpdatedAt;

    const updated = await newsRepository.updateMeta(id, updatePayload);
    if (!updated) {throw new Api409Error(t('news_optimistic_lock_conflict', context.lang));}

    return { message: t('news_updated_success', context.lang), news: { id: updated.id, status: updated.status, category: updated.category, coverUrl: updated.cover_url } };
};

const upsertNewsTranslation = async (actor, id, lang, payload, context = {}) => {
    if (!canUpdateNews(actor)) {throw new Api403Error(t('no_permission_resource', context.lang, { resource: 'news', action: 'update' }));}

    const existing = await newsRepository.findById(id);
    if (!existing) {throw new Api404Error(t('news_not_found', context.lang));}
    assertNewsCategoryAccess(actor, existing, context);

    const resolvedLang = normalizeLang(lang);
    const title = stripTags(payload.title);
    const summary = payload.summary ? stripTags(payload.summary) : null;
    const content = sanitizeHtml(payload.content);
    const slug = await buildUniqueSlug(title, resolvedLang, id);

    const translation = await newsRepository.upsertTranslation(id, resolvedLang, {
        title,
        slug,
        summary,
        content,
    });

    return {
        message: t('news_updated_success', context.lang),
        translation: {
            newsId: id,
            lang: translation.lang,
            title: translation.title,
            slug: translation.slug,
            summary: translation.summary,
        },
    };
};

const deleteNews = async (actor, id, context = {}) => {
    if (!canDeleteNews(actor)) {throw new Api403Error(t('no_permission_resource', context.lang, { resource: 'news', action: 'delete' }));}
    const existing = await newsRepository.findById(id);
    if (!existing) {throw new Api404Error(t('news_not_found', context.lang));}
    assertNewsCategoryAccess(actor, existing, context, 'delete');
    const deleted = await newsRepository.softDelete(id);
    if (!deleted) {throw new Api404Error(t('news_not_found', context.lang));}
    return { message: t('news_deleted_success', context.lang) };
};
const updateNewsFull = async (actor, id, payload, file, context = {}) => {
    if (!canUpdateNews(actor)) {throw new Api403Error(t('no_permission_resource', context.lang, { resource: 'news', action: 'update' }));}

    const existing = await newsRepository.findById(id);
    if (!existing) {throw new Api404Error(t('news_not_found', context.lang));}
    assertNewsCategoryAccess(actor, existing, context);

    const client = await db.getClient();
    try {
        await client.query('BEGIN');

        // 1. Update metadata nếu có thay đổi, đồng thời check optimistic lock.
        const metaPayload = { expectedUpdatedAt: payload.expectedUpdatedAt };
        if (Object.prototype.hasOwnProperty.call(payload, 'status')) {
            metaPayload.status = payload.status;
            if (payload.status === 'published' && existing.status !== 'published' && !existing.published_at) {
                metaPayload.publishedAt = new Date();
            }
        }
        if (file) {
            metaPayload.coverUrl = `${file._relativeDir}/${file.filename}`;
        } else if (Object.prototype.hasOwnProperty.call(payload, 'coverUrl')) {
            metaPayload.coverUrl = payload.coverUrl;
        }

        if (Object.prototype.hasOwnProperty.call(payload, 'category')) {
            metaPayload.category = resolveNewsCategory(actor, payload.category);
        }

        const metaUpdated = await newsRepository.updateMeta(id, metaPayload, { client });
        if (!metaUpdated) {
            throw new Api409Error(t('news_optimistic_lock_conflict', context.lang));
        }

        // 2. Upsert từng bản dịch trong cùng transaction.
        const translationResults = {};
        for (const [lang, body] of Object.entries(payload.translations || {})) {
            const resolvedLang = normalizeLang(lang);
            const title = stripTags(body.title);
            const summary = body.summary ? stripTags(body.summary) : null;
            const content = sanitizeHtml(body.content);
            const slug = await buildUniqueSlug(title, resolvedLang, id);

            const translation = await newsRepository.upsertTranslation(id, resolvedLang, {
                title, slug, summary, content,
            }, { client });
            translationResults[resolvedLang] = {
                title: translation.title,
                slug: translation.slug,
                summary: translation.summary,
            };
        }

        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }

    // 3. Trả về admin detail đầy đủ
    const updated = await newsRepository.findAdminById(id);
    return {
        message: t('news_updated_success', context.lang),
        news: toAdminDetail(updated),
    };
};

module.exports = { listNews, getNewsBySlug, getAdminNewsById, createNews, updateNewsMeta, upsertNewsTranslation, deleteNews, updateNewsFull };
