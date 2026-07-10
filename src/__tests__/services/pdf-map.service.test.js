'use strict';

// ── Mocks ──────────────────────────────────────────────────────────────────────

jest.mock('../../repositories/pdf-map.repository', () => ({
    findAll:          jest.fn(),
    countAll:         jest.fn(),
    findById:         jest.fn(),
    findRaw:          jest.fn(),
    findAdminById:    jest.fn(),
    createMeta:       jest.fn(),
    createTranslation: jest.fn(),
    updateMeta:       jest.fn(),
    upsertTranslation: jest.fn(),
    softDelete:       jest.fn(),
}));

jest.mock('../../configs/database', () => ({
    getClient: jest.fn(),
}));

jest.mock('../../core/error.response', () => {
    class Api400Error extends Error { constructor(msg) { super(msg); this.status = 400; } }
    class Api403Error extends Error { constructor(msg) { super(msg); this.status = 403; } }
    class Api404Error extends Error { constructor(msg) { super(msg); this.status = 404; } }
    class Api409Error extends Error { constructor(msg) { super(msg); this.status = 409; } }
    return { Api400Error, Api403Error, Api404Error, Api409Error };
});

jest.mock('../../utils/i18n.util', () => ({ t: (key) => key }));
jest.mock('../../utils/cms.util', () => ({
    stripTags:    (str) => (str || '').replace(/<[^>]*>/g, ''),
    sanitizeHtml: (str) => str,
    normalizeLang: (lang) => (lang === 'en' ? 'en' : 'vi'),
}));

const pdfMapRepo = require('../../repositories/pdf-map.repository');
const db         = require('../../configs/database');
const svc        = require('../../services/pdf-map.service');

// ── Fixtures ───────────────────────────────────────────────────────────────────

const adminActor   = { id: 1, role: 'system_admin' };
const soNnmtActor  = { id: 2, role: 'so_nnmt' };
const ubndActor    = { id: 4, role: 'ubnd_tinh' };
const citizenActor = { id: 3, role: 'citizen' };

const fakePdfRow = {
    id: 5, theme_code: 'chay_rung', year: 2024, scale: '1:10000', region: 'Kon Tum',
    file_url: '/uploads/pdf-maps/map.pdf', file_name: 'map.pdf',
    mime_type: 'application/pdf', file_size: 512000,
    thumbnail_url: null, is_public: true, uploaded_by: 1, uploaded_by_name: 'Admin',
    created_at: new Date(), updated_at: new Date(),
    title: 'Bản đồ cháy rừng 2024', description: null, lang: 'vi', fallback_used: false,
};

const fakePdfFile  = { _relativeDir: '/uploads/pdf-maps/2026/07', filename: 'map-abc.pdf',  originalname: 'map.pdf',    mimetype: 'application/pdf', size: 512000 };
const fakeThumbFile = { _relativeDir: '/uploads/images/2026/07',   filename: 'thumb-abc.jpg', originalname: 'thumb.jpg', mimetype: 'image/jpeg',      size: 20000 };

function makeMockClient() {
    return { query: jest.fn().mockResolvedValue({}), release: jest.fn() };
}

beforeEach(() => jest.clearAllMocks());

// ── listPdfMaps ────────────────────────────────────────────────────────────────

describe('listPdfMaps', () => {
    beforeEach(() => {
        pdfMapRepo.findAll.mockResolvedValue([fakePdfRow]);
        pdfMapRepo.countAll.mockResolvedValue(1);
    });

    test('citizen/null gets publicOnly=true', async () => {
        await svc.listPdfMaps(citizenActor, {});
        expect(pdfMapRepo.findAll).toHaveBeenCalledWith(expect.objectContaining({ publicOnly: true }));
        jest.clearAllMocks();
        pdfMapRepo.findAll.mockResolvedValue([]);
        pdfMapRepo.countAll.mockResolvedValue(0);
        await svc.listPdfMaps(null, {});
        expect(pdfMapRepo.findAll).toHaveBeenCalledWith(expect.objectContaining({ publicOnly: true }));
    });

    test('internal roles get publicOnly=false', async () => {
        for (const actor of [adminActor, soNnmtActor, ubndActor]) {
            jest.clearAllMocks();
            pdfMapRepo.findAll.mockResolvedValue([]);
            pdfMapRepo.countAll.mockResolvedValue(0);
            await svc.listPdfMaps(actor, {});
            expect(pdfMapRepo.findAll).toHaveBeenCalledWith(expect.objectContaining({ publicOnly: false }));
        }
    });

    test('returns mapped items with camelCase fields', async () => {
        const result = await svc.listPdfMaps(null, {});
        expect(result.items[0].themeCode).toBe('chay_rung');
        expect(result.items[0].thumbnailUrl).toBeNull();
        expect(result.items[0]).not.toHaveProperty('theme_code');
    });

    test('passes theme filter to repository', async () => {
        await svc.listPdfMaps(adminActor, { theme: 'lop_phu_rung' });
        expect(pdfMapRepo.findAll).toHaveBeenCalledWith(
            expect.objectContaining({ filter: expect.objectContaining({ theme: 'lop_phu_rung' }) }),
        );
    });

    test('passes year range filters', async () => {
        await svc.listPdfMaps(adminActor, { yearFrom: 2020, yearTo: 2024 });
        expect(pdfMapRepo.findAll).toHaveBeenCalledWith(
            expect.objectContaining({ filter: expect.objectContaining({ yearFrom: 2020, yearTo: 2024 }) }),
        );
    });
});

// ── getPdfMapById ──────────────────────────────────────────────────────────────

describe('getPdfMapById', () => {
    test('returns public item when found', async () => {
        pdfMapRepo.findById.mockResolvedValue(fakePdfRow);
        const result = await svc.getPdfMapById(null, 5);
        expect(result.id).toBe(5);
        expect(result.themeCode).toBe('chay_rung');
    });

    test('throws 404 when not found', async () => {
        pdfMapRepo.findById.mockResolvedValue(null);
        await expect(svc.getPdfMapById(null, 999)).rejects.toMatchObject({ status: 404 });
    });

    test('citizen gets publicOnly=true', async () => {
        pdfMapRepo.findById.mockResolvedValue(fakePdfRow);
        await svc.getPdfMapById(citizenActor, 5);
        expect(pdfMapRepo.findById).toHaveBeenCalledWith(5, expect.objectContaining({ publicOnly: true }));
    });
});

// ── getAdminPdfMapById ─────────────────────────────────────────────────────────

describe('getAdminPdfMapById', () => {
    test('throws 403 for non-manage roles', async () => {
        await expect(svc.getAdminPdfMapById(citizenActor, 5)).rejects.toMatchObject({ status: 403 });
        await expect(svc.getAdminPdfMapById(ubndActor, 5)).rejects.toMatchObject({ status: 403 });
    });

    test('throws 404 when not found', async () => {
        pdfMapRepo.findAdminById.mockResolvedValue(null);
        await expect(svc.getAdminPdfMapById(adminActor, 999)).rejects.toMatchObject({ status: 404 });
    });

    test('returns admin detail with translations', async () => {
        pdfMapRepo.findAdminById.mockResolvedValue({ ...fakePdfRow, translations: { vi: { title: 'Bản đồ' } } });
        const result = await svc.getAdminPdfMapById(adminActor, 5);
        expect(result.translations).toBeDefined();
    });
});

// ── createPdfMap ───────────────────────────────────────────────────────────────

describe('createPdfMap', () => {
    const payload = { themeCode: 'chay_rung', year: 2024, scale: '1:10000', region: 'Kon Tum', lang: 'vi', title: 'Bản đồ <b>cháy rừng</b>', isPublic: true };
    let client;

    beforeEach(() => {
        client = makeMockClient();
        db.getClient.mockResolvedValue(client);
        pdfMapRepo.createMeta.mockResolvedValue({
            id: 50, theme_code: 'chay_rung', year: 2024, scale: '1:10000', region: 'Kon Tum',
            file_url: '/uploads/pdf-maps/2026/07/map-abc.pdf', thumbnail_url: null,
            is_public: true, created_at: new Date(),
        });
        pdfMapRepo.createTranslation.mockResolvedValue({ lang: 'vi', title: 'Bản đồ cháy rừng', description: null });
    });

    test('throws 403 for non-manage roles', async () => {
        await expect(svc.createPdfMap(citizenActor, payload, fakePdfFile, null)).rejects.toMatchObject({ status: 403 });
        await expect(svc.createPdfMap(ubndActor, payload, fakePdfFile, null)).rejects.toMatchObject({ status: 403 });
    });

    test('throws 400 when no pdf file provided', async () => {
        await expect(svc.createPdfMap(adminActor, payload, null, null)).rejects.toMatchObject({ status: 400 });
    });

    test('strips HTML from title', async () => {
        await svc.createPdfMap(adminActor, payload, fakePdfFile, null);
        expect(pdfMapRepo.createTranslation).toHaveBeenCalledWith(
            expect.objectContaining({ title: 'Bản đồ cháy rừng' }),
            expect.anything(),
        );
    });

    test('uses thumbnail file path when thumbFile provided', async () => {
        pdfMapRepo.createMeta.mockResolvedValue({
            ...pdfMapRepo.createMeta.mock.results[0]?.value,
            id: 51, theme_code: 'chay_rung', year: 2024, scale: null, region: null,
            file_url: '/uploads/pdf-maps/2026/07/map-abc.pdf',
            thumbnail_url: '/uploads/images/2026/07/thumb-abc.jpg',
            is_public: true, created_at: new Date(),
        });
        await svc.createPdfMap(adminActor, payload, fakePdfFile, fakeThumbFile);
        expect(pdfMapRepo.createMeta).toHaveBeenCalledWith(
            expect.objectContaining({ thumbnailUrl: '/uploads/images/2026/07/thumb-abc.jpg' }),
            expect.anything(),
        );
    });

    test('uses thumbnailUrl from payload when no thumbFile', async () => {
        await svc.createPdfMap(adminActor, { ...payload, thumbnailUrl: '/existing/thumb.jpg' }, fakePdfFile, null);
        expect(pdfMapRepo.createMeta).toHaveBeenCalledWith(
            expect.objectContaining({ thumbnailUrl: '/existing/thumb.jpg' }),
            expect.anything(),
        );
    });

    test('commits transaction and returns pdfMap', async () => {
        const result = await svc.createPdfMap(soNnmtActor, payload, fakePdfFile, null);
        expect(client.query).toHaveBeenCalledWith('BEGIN');
        expect(client.query).toHaveBeenCalledWith('COMMIT');
        expect(result.pdfMap.id).toBe(50);
    });

    test('rolls back on error and re-throws', async () => {
        pdfMapRepo.createMeta.mockRejectedValue(new Error('DB error'));
        await expect(svc.createPdfMap(adminActor, payload, fakePdfFile, null)).rejects.toThrow('DB error');
        expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    });

    test('always releases db client', async () => {
        pdfMapRepo.createMeta.mockRejectedValue(new Error('fail'));
        await svc.createPdfMap(adminActor, payload, fakePdfFile, null).catch(() => {});
        expect(client.release).toHaveBeenCalled();
    });
});

// ── upsertPdfMapTranslation ────────────────────────────────────────────────────

describe('upsertPdfMapTranslation', () => {
    beforeEach(() => {
        pdfMapRepo.findRaw.mockResolvedValue(fakePdfRow);
        pdfMapRepo.upsertTranslation.mockResolvedValue({ lang: 'en', title: 'Fire Risk Map 2024', description: null });
    });

    test('throws 403 for non-manage roles', async () => {
        await expect(svc.upsertPdfMapTranslation(citizenActor, 5, 'en', { title: 'Map' })).rejects.toMatchObject({ status: 403 });
    });

    test('throws 404 when pdf map not found', async () => {
        pdfMapRepo.findRaw.mockResolvedValue(null);
        await expect(svc.upsertPdfMapTranslation(adminActor, 999, 'en', { title: 'Map' })).rejects.toMatchObject({ status: 404 });
    });

    test('strips HTML from title', async () => {
        await svc.upsertPdfMapTranslation(adminActor, 5, 'en', { title: '<b>Fire Risk Map</b>' });
        expect(pdfMapRepo.upsertTranslation).toHaveBeenCalledWith(5, 'en', expect.objectContaining({ title: 'Fire Risk Map' }));
    });

    test('returns translation with pdfMapId', async () => {
        const result = await svc.upsertPdfMapTranslation(adminActor, 5, 'en', { title: 'Fire Risk Map 2024' });
        expect(result.translation.pdfMapId).toBe(5);
        expect(result.translation.lang).toBe('en');
    });
});

// ── deletePdfMap ───────────────────────────────────────────────────────────────

describe('deletePdfMap', () => {
    test('throws 403 for non-manage roles', async () => {
        await expect(svc.deletePdfMap(citizenActor, 5)).rejects.toMatchObject({ status: 403 });
        await expect(svc.deletePdfMap(ubndActor, 5)).rejects.toMatchObject({ status: 403 });
    });

    test('throws 404 when pdf map not found', async () => {
        pdfMapRepo.softDelete.mockResolvedValue(null);
        await expect(svc.deletePdfMap(adminActor, 999)).rejects.toMatchObject({ status: 404 });
    });

    test('soft deletes and returns message', async () => {
        pdfMapRepo.softDelete.mockResolvedValue({ id: 5 });
        const result = await svc.deletePdfMap(adminActor, 5);
        expect(result).toHaveProperty('message');
        expect(pdfMapRepo.softDelete).toHaveBeenCalledWith(5);
    });
});

// ── updatePdfMapFull ───────────────────────────────────────────────────────────

describe('updatePdfMapFull', () => {
    let client;
    beforeEach(() => {
        client = makeMockClient();
        db.getClient.mockResolvedValue(client);
        pdfMapRepo.findRaw.mockResolvedValue(fakePdfRow);
        pdfMapRepo.updateMeta.mockResolvedValue({ id: 5, theme_code: 'chay_rung', year: 2024 });
        pdfMapRepo.upsertTranslation.mockResolvedValue({ lang: 'vi', title: 'Cập nhật', description: null });
        pdfMapRepo.findAdminById.mockResolvedValue({ ...fakePdfRow, translations: { vi: { title: 'Cập nhật' } } });
    });

    test('throws 403 for non-manage roles', async () => {
        await expect(svc.updatePdfMapFull(citizenActor, 5, {})).rejects.toMatchObject({ status: 403 });
    });

    test('throws 404 when pdf map not found', async () => {
        pdfMapRepo.findRaw.mockResolvedValue(null);
        await expect(svc.updatePdfMapFull(adminActor, 999, {})).rejects.toMatchObject({ status: 404 });
    });

    test('commits transaction and returns full detail', async () => {
        const result = await svc.updatePdfMapFull(adminActor, 5, {
            year: 2023,
            translations: { vi: { title: 'Cập nhật', description: null } },
        });
        expect(client.query).toHaveBeenCalledWith('BEGIN');
        expect(client.query).toHaveBeenCalledWith('COMMIT');
        expect(result.pdfMap).toBeDefined();
    });

    test('rolls back and throws 409 on optimistic lock conflict', async () => {
        pdfMapRepo.updateMeta.mockResolvedValue(null);
        await expect(svc.updatePdfMapFull(adminActor, 5, {})).rejects.toMatchObject({ status: 409 });
        expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    });

    test('always releases db client', async () => {
        pdfMapRepo.updateMeta.mockResolvedValue(null);
        await svc.updatePdfMapFull(adminActor, 5, {}).catch(() => {});
        expect(client.release).toHaveBeenCalled();
    });

    test('upserts multiple translations', async () => {
        await svc.updatePdfMapFull(adminActor, 5, {
            translations: { vi: { title: 'Bản đồ vi', description: null }, en: { title: 'Map en', description: null } },
        });
        expect(pdfMapRepo.upsertTranslation).toHaveBeenCalledTimes(2);
    });

    test('only updates meta fields that are provided', async () => {
        await svc.updatePdfMapFull(adminActor, 5, { year: 2023 });
        expect(pdfMapRepo.updateMeta).toHaveBeenCalledWith(
            5,
            expect.objectContaining({ year: 2023 }),
            expect.anything(),
        );
        // Fields not provided should not appear in payload (or be undefined)
        const callArgs = pdfMapRepo.updateMeta.mock.calls[0][1];
        expect(callArgs).not.toHaveProperty('isPublic');
    });
});
