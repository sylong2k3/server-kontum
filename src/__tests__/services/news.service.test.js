'use strict';

// ── Mocks ──────────────────────────────────────────────────────────────────────

jest.mock('../../repositories/news.repository', () => ({
    findAll:              jest.fn(),
    countAll:             jest.fn(),
    findBySlug:           jest.fn(),
    findById:             jest.fn(),
    findAdminById:        jest.fn(),
    createMeta:           jest.fn(),
    createTranslation:    jest.fn(),
    updateMeta:           jest.fn(),
    upsertTranslation:    jest.fn(),
    softDelete:           jest.fn(),
    translationSlugExists: jest.fn(),
}));

jest.mock('../../configs/database', () => ({
    getClient: jest.fn(),
}));

jest.mock('../../core/error.response', () => {
    class Api403Error extends Error { constructor(msg) { super(msg); this.status = 403; } }
    class Api404Error extends Error { constructor(msg) { super(msg); this.status = 404; } }
    class Api409Error extends Error { constructor(msg) { super(msg); this.status = 409; } }
    return { Api403Error, Api404Error, Api409Error };
});

jest.mock('../../utils/i18n.util', () => ({ t: (key) => key }));

jest.mock('../../utils/cms.util', () => ({
    slugify:      (str) => str.toLowerCase().replace(/\s+/g, '-'),
    stripTags:    (str) => (str || '').replace(/<[^>]*>/g, ''),
    sanitizeHtml: (str) => str,
    normalizeLang: (lang) => (lang === 'en' ? 'en' : 'vi'),
}));

const newsRepo = require('../../repositories/news.repository');
const db       = require('../../configs/database');
const svc      = require('../../services/news.service');

// ── Fixtures ───────────────────────────────────────────────────────────────────

const adminActor   = { id: 1, role: 'system_admin', permissions: {} };
const soNnmtActor  = { id: 2, role: 'so_nnmt',      permissions: { news: { read: true, create: true, update: true, delete: true } } };
const citizenActor = { id: 3, role: 'citizen',       permissions: {} };
const noActor      = null;

const fakeNewsRow = {
    id: 10, slug: 'tin-moi', title: 'Tin Mới', summary: 'tóm tắt', content: '<p>nội dung</p>',
    cover_url: null, status: 'published', category: 'general', author_id: 1, author_name: 'Admin',
    published_at: new Date('2026-01-01'), created_at: new Date(), updated_at: new Date(),
    lang: 'vi', fallback_used: false,
};

const fakeNewsGeneral  = { ...fakeNewsRow, category: 'general' };
const fakeNewsSoNnmt   = { ...fakeNewsRow, category: 'so_nnmt' };

function makeMockClient() {
    return { query: jest.fn().mockResolvedValue({}), release: jest.fn() };
}

beforeEach(() => {
    jest.clearAllMocks();
    newsRepo.translationSlugExists.mockResolvedValue(false);
});

// ── listNews ───────────────────────────────────────────────────────────────────

describe('listNews', () => {
    beforeEach(() => {
        newsRepo.findAll.mockResolvedValue([fakeNewsRow]);
        newsRepo.countAll.mockResolvedValue(1);
    });

    test('public actor (null) passes publicOnly=true', async () => {
        await svc.listNews(noActor, {});
        expect(newsRepo.findAll).toHaveBeenCalledWith(expect.objectContaining({ publicOnly: true }));
    });

    test('system_admin passes publicOnly=false', async () => {
        await svc.listNews(adminActor, {});
        expect(newsRepo.findAll).toHaveBeenCalledWith(expect.objectContaining({ publicOnly: false }));
    });

    test('so_nnmt always filters category to so_nnmt', async () => {
        await svc.listNews(soNnmtActor, { category: 'general' });
        expect(newsRepo.findAll).toHaveBeenCalledWith(
            expect.objectContaining({ filter: expect.objectContaining({ category: 'so_nnmt' }) }),
        );
    });

    test('returns mapped items and total', async () => {
        const result = await svc.listNews(adminActor, { page: 2, limit: 5 });
        expect(result.total).toBe(1);
        expect(result.items[0].id).toBe(10);
        expect(result.items[0]).not.toHaveProperty('cover_url'); // camelCased in mapper
        expect(result.items[0].coverUrl).toBeNull();
    });

    test('respects pagination offset', async () => {
        await svc.listNews(adminActor, { page: 3, limit: 10 });
        expect(newsRepo.findAll).toHaveBeenCalledWith(expect.objectContaining({ offset: 20 }));
    });
});

// ── getNewsBySlug ──────────────────────────────────────────────────────────────

describe('getNewsBySlug', () => {
    test('returns detail when slug exists', async () => {
        newsRepo.findBySlug.mockResolvedValue(fakeNewsRow);
        const result = await svc.getNewsBySlug(noActor, 'tin-moi', { lang: 'vi' });
        expect(result.content).toBe(fakeNewsRow.content);
    });

    test('throws 404 when slug not found', async () => {
        newsRepo.findBySlug.mockResolvedValue(null);
        await expect(svc.getNewsBySlug(noActor, 'khong-ton-tai')).rejects.toMatchObject({ status: 404 });
    });

    test('public actor uses publicOnly=true', async () => {
        newsRepo.findBySlug.mockResolvedValue(fakeNewsRow);
        await svc.getNewsBySlug(noActor, 'tin-moi');
        expect(newsRepo.findBySlug).toHaveBeenCalledWith('tin-moi', expect.objectContaining({ publicOnly: true }));
    });

    test('internal actor uses publicOnly=false', async () => {
        newsRepo.findBySlug.mockResolvedValue(fakeNewsRow);
        await svc.getNewsBySlug(adminActor, 'tin-noi-bo');
        expect(newsRepo.findBySlug).toHaveBeenCalledWith('tin-noi-bo', expect.objectContaining({ publicOnly: false }));
    });
});

// ── getAdminNewsById ───────────────────────────────────────────────────────────

describe('getAdminNewsById', () => {
    test('throws 403 when actor has no read permission', async () => {
        await expect(svc.getAdminNewsById(citizenActor, 1)).rejects.toMatchObject({ status: 403 });
    });

    test('throws 404 when news not found', async () => {
        newsRepo.findAdminById.mockResolvedValue(null);
        await expect(svc.getAdminNewsById(adminActor, 999)).rejects.toMatchObject({ status: 404 });
    });

    test('returns admin detail with translations', async () => {
        newsRepo.findAdminById.mockResolvedValue({ ...fakeNewsRow, translations: { vi: { title: 'Tin Mới' } } });
        const result = await svc.getAdminNewsById(adminActor, 10);
        expect(result.translations).toEqual({ vi: { title: 'Tin Mới' } });
    });
});

// ── createNews ─────────────────────────────────────────────────────────────────

describe('createNews', () => {
    const payload = { title: 'Tin <b>Mới</b>', content: '<p>nội dung</p>', lang: 'vi', status: 'draft' };

    beforeEach(() => {
        newsRepo.createMeta.mockResolvedValue({ id: 20, cover_url: null, status: 'draft', category: 'general', published_at: null, created_at: new Date() });
        newsRepo.createTranslation.mockResolvedValue({ lang: 'vi', title: 'Tin Mới', slug: 'tin-moi', summary: null });
    });

    test('throws 403 when actor cannot create', async () => {
        await expect(svc.createNews(citizenActor, payload, null)).rejects.toMatchObject({ status: 403 });
    });

    test('strips HTML tags from title before saving', async () => {
        await svc.createNews(adminActor, payload, null);
        expect(newsRepo.createTranslation).toHaveBeenCalledWith(
            expect.objectContaining({ title: 'Tin Mới' }),
        );
    });

    test('sets publishedAt when status is published', async () => {
        newsRepo.createMeta.mockResolvedValue({ id: 21, status: 'published', category: 'general', published_at: new Date(), created_at: new Date(), cover_url: null });
        await svc.createNews(adminActor, { ...payload, status: 'published' }, null);
        expect(newsRepo.createMeta).toHaveBeenCalledWith(
            expect.objectContaining({ publishedAt: expect.any(Date) }),
        );
    });

    test('does not set publishedAt for draft', async () => {
        await svc.createNews(adminActor, payload, null);
        expect(newsRepo.createMeta).toHaveBeenCalledWith(
            expect.objectContaining({ publishedAt: null }),
        );
    });

    test('so_nnmt always creates with category so_nnmt', async () => {
        newsRepo.createMeta.mockResolvedValue({ id: 22, status: 'draft', category: 'so_nnmt', published_at: null, created_at: new Date(), cover_url: null });
        await svc.createNews(soNnmtActor, { ...payload, category: 'general' }, null);
        expect(newsRepo.createMeta).toHaveBeenCalledWith(
            expect.objectContaining({ category: 'so_nnmt' }),
        );
    });

    test('handles slug collision by appending suffix', async () => {
        // Mock slugify keeps Vietnamese chars; real slugify would romanize to 'tin-moi'
        // but we test the collision-retry logic, not the romanization
        newsRepo.translationSlugExists
            .mockResolvedValueOnce(true)  // base slug already exists
            .mockResolvedValueOnce(false); // base-2 is free
        await svc.createNews(adminActor, payload, null);
        expect(newsRepo.createTranslation).toHaveBeenCalledWith(
            expect.objectContaining({ slug: expect.stringMatching(/-2$/) }),
        );
    });

    test('uses file path for coverUrl when file provided', async () => {
        const file = { _relativeDir: '/uploads/images', filename: 'cover.jpg' };
        await svc.createNews(adminActor, payload, file);
        expect(newsRepo.createMeta).toHaveBeenCalledWith(
            expect.objectContaining({ coverUrl: '/uploads/images/cover.jpg' }),
        );
    });
});

// ── updateNewsMeta ─────────────────────────────────────────────────────────────

describe('updateNewsMeta', () => {
    beforeEach(() => {
        newsRepo.findById.mockResolvedValue(fakeNewsGeneral);
        newsRepo.updateMeta.mockResolvedValue({ id: 10, status: 'published', category: 'general', cover_url: null });
    });

    test('throws 403 without update permission', async () => {
        await expect(svc.updateNewsMeta(citizenActor, 10, {})).rejects.toMatchObject({ status: 403 });
    });

    test('throws 404 when news not found', async () => {
        newsRepo.findById.mockResolvedValue(null);
        await expect(svc.updateNewsMeta(adminActor, 999, {})).rejects.toMatchObject({ status: 404 });
    });

    test('so_nnmt cannot update general news — throws 403', async () => {
        newsRepo.findById.mockResolvedValue(fakeNewsGeneral);
        await expect(svc.updateNewsMeta(soNnmtActor, 10, { status: 'published' })).rejects.toMatchObject({ status: 403 });
    });

    test('so_nnmt can update so_nnmt news', async () => {
        newsRepo.findById.mockResolvedValue(fakeNewsSoNnmt);
        const result = await svc.updateNewsMeta(soNnmtActor, 10, { status: 'published' });
        expect(result).toHaveProperty('news');
    });

    test('throws 409 on optimistic lock conflict', async () => {
        newsRepo.updateMeta.mockResolvedValue(null);
        await expect(svc.updateNewsMeta(adminActor, 10, { status: 'published' })).rejects.toMatchObject({ status: 409 });
    });

    test('sets publishedAt when transitioning to published for first time', async () => {
        newsRepo.findById.mockResolvedValue({ ...fakeNewsGeneral, status: 'draft', published_at: null });
        await svc.updateNewsMeta(adminActor, 10, { status: 'published' });
        expect(newsRepo.updateMeta).toHaveBeenCalledWith(
            10,
            expect.objectContaining({ publishedAt: expect.any(Date) }),
        );
    });
});

// ── deleteNews ─────────────────────────────────────────────────────────────────

describe('deleteNews', () => {
    test('throws 403 without delete permission', async () => {
        await expect(svc.deleteNews(citizenActor, 10)).rejects.toMatchObject({ status: 403 });
    });

    test('throws 404 when news not found', async () => {
        newsRepo.findById.mockResolvedValue(null);
        await expect(svc.deleteNews(adminActor, 999)).rejects.toMatchObject({ status: 404 });
    });

    test('so_nnmt cannot delete general news', async () => {
        newsRepo.findById.mockResolvedValue(fakeNewsGeneral);
        await expect(svc.deleteNews(soNnmtActor, 10)).rejects.toMatchObject({ status: 403 });
    });

    test('soft deletes when actor has permission', async () => {
        newsRepo.findById.mockResolvedValue(fakeNewsGeneral);
        newsRepo.softDelete.mockResolvedValue({ id: 10 });
        await svc.deleteNews(adminActor, 10);
        expect(newsRepo.softDelete).toHaveBeenCalledWith(10);
    });
});

// ── updateNewsFull ─────────────────────────────────────────────────────────────

describe('updateNewsFull', () => {
    let client;
    beforeEach(() => {
        client = makeMockClient();
        db.getClient.mockResolvedValue(client);
        newsRepo.findById.mockResolvedValue(fakeNewsGeneral);
        newsRepo.updateMeta.mockResolvedValue({ id: 10, status: 'draft', category: 'general', cover_url: null });
        newsRepo.upsertTranslation.mockResolvedValue({ lang: 'vi', title: 'Cập nhật', slug: 'cap-nhat', summary: null });
        newsRepo.findAdminById.mockResolvedValue({ ...fakeNewsGeneral, translations: { vi: { title: 'Cập nhật' } } });
    });

    test('throws 403 without update permission', async () => {
        await expect(svc.updateNewsFull(citizenActor, 10, {})).rejects.toMatchObject({ status: 403 });
    });

    test('throws 404 when news not found', async () => {
        newsRepo.findById.mockResolvedValue(null);
        await expect(svc.updateNewsFull(adminActor, 999, {})).rejects.toMatchObject({ status: 404 });
    });

    test('commits transaction and returns admin detail', async () => {
        const result = await svc.updateNewsFull(adminActor, 10, { translations: { vi: { title: 'Cập nhật', content: 'Nội dung' } } }, null);
        expect(client.query).toHaveBeenCalledWith('BEGIN');
        expect(client.query).toHaveBeenCalledWith('COMMIT');
        expect(result.news.translations).toBeDefined();
    });

    test('rolls back transaction on optimistic lock conflict', async () => {
        newsRepo.updateMeta.mockResolvedValue(null);
        await expect(svc.updateNewsFull(adminActor, 10, {})).rejects.toMatchObject({ status: 409 });
        expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    });

    test('releases db client even on error', async () => {
        newsRepo.updateMeta.mockResolvedValue(null);
        await svc.updateNewsFull(adminActor, 10, {}).catch(() => {});
        expect(client.release).toHaveBeenCalled();
    });
});
