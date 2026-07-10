'use strict';

// ── Mocks ──────────────────────────────────────────────────────────────────────

jest.mock('../../repositories/document.repository', () => ({
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

const docRepo = require('../../repositories/document.repository');
const db      = require('../../configs/database');
const svc     = require('../../services/document.service');

// ── Fixtures ───────────────────────────────────────────────────────────────────

const adminActor   = { id: 1, role: 'system_admin' };
const soNnmtActor  = { id: 2, role: 'so_nnmt' };
const ubndActor    = { id: 4, role: 'ubnd_tinh' };
const citizenActor = { id: 3, role: 'citizen' };

const fakeDocRow = {
    id: 20, doc_type: 'bao_cao', file_url: '/uploads/documents/doc.pdf',
    file_name: 'doc.pdf', mime_type: 'application/pdf', file_size: 1024,
    is_public: true, uploaded_by: 1, uploaded_by_name: 'Admin',
    created_at: new Date(), updated_at: new Date(),
    title: 'Báo cáo', description: null, lang: 'vi', fallback_used: false,
};

const fakeFile = {
    _relativeDir: '/uploads/documents/2026/07',
    filename: 'report-abc123.pdf',
    originalname: 'bao-cao.pdf',
    mimetype: 'application/pdf',
    size: 2048,
};

function makeMockClient() {
    return { query: jest.fn().mockResolvedValue({}), release: jest.fn() };
}

beforeEach(() => jest.clearAllMocks());

// ── listDocuments ──────────────────────────────────────────────────────────────

describe('listDocuments', () => {
    beforeEach(() => {
        docRepo.findAll.mockResolvedValue([fakeDocRow]);
        docRepo.countAll.mockResolvedValue(1);
    });

    test('public (citizen/null) gets publicOnly=true', async () => {
        await svc.listDocuments(citizenActor, {});
        expect(docRepo.findAll).toHaveBeenCalledWith(expect.objectContaining({ publicOnly: true }));
        await svc.listDocuments(null, {});
        expect(docRepo.findAll).toHaveBeenCalledWith(expect.objectContaining({ publicOnly: true }));
    });

    test('internal roles (ubnd_tinh, so_nnmt, system_admin) get publicOnly=false', async () => {
        for (const actor of [adminActor, soNnmtActor, ubndActor]) {
            jest.clearAllMocks();
            docRepo.findAll.mockResolvedValue([]);
            docRepo.countAll.mockResolvedValue(0);
            await svc.listDocuments(actor, {});
            expect(docRepo.findAll).toHaveBeenCalledWith(expect.objectContaining({ publicOnly: false }));
        }
    });

    test('returns mapped items with camelCase fields', async () => {
        const result = await svc.listDocuments(null, {});
        expect(result.items[0].docType).toBe('bao_cao');
        expect(result.items[0].fileUrl).toBe('/uploads/documents/doc.pdf');
        expect(result.items[0]).not.toHaveProperty('doc_type');
    });

    test('applies correct pagination offset', async () => {
        await svc.listDocuments(adminActor, { page: 2, limit: 10 });
        expect(docRepo.findAll).toHaveBeenCalledWith(expect.objectContaining({ offset: 10 }));
    });
});

// ── getDocumentById ────────────────────────────────────────────────────────────

describe('getDocumentById', () => {
    test('returns public item when found', async () => {
        docRepo.findById.mockResolvedValue(fakeDocRow);
        const result = await svc.getDocumentById(null, 20);
        expect(result.id).toBe(20);
    });

    test('throws 404 when document not found', async () => {
        docRepo.findById.mockResolvedValue(null);
        await expect(svc.getDocumentById(null, 999)).rejects.toMatchObject({ status: 404 });
    });

    test('passes publicOnly based on actor role', async () => {
        docRepo.findById.mockResolvedValue(fakeDocRow);
        await svc.getDocumentById(citizenActor, 20);
        expect(docRepo.findById).toHaveBeenCalledWith(20, expect.objectContaining({ publicOnly: true }));

        await svc.getDocumentById(adminActor, 20);
        expect(docRepo.findById).toHaveBeenCalledWith(20, expect.objectContaining({ publicOnly: false }));
    });
});

// ── getAdminDocumentById ───────────────────────────────────────────────────────

describe('getAdminDocumentById', () => {
    test('throws 403 for non-manage roles', async () => {
        await expect(svc.getAdminDocumentById(citizenActor, 20)).rejects.toMatchObject({ status: 403 });
        await expect(svc.getAdminDocumentById(ubndActor, 20)).rejects.toMatchObject({ status: 403 });
    });

    test('throws 404 when document not found', async () => {
        docRepo.findAdminById.mockResolvedValue(null);
        await expect(svc.getAdminDocumentById(adminActor, 999)).rejects.toMatchObject({ status: 404 });
    });

    test('returns admin detail with translations', async () => {
        docRepo.findAdminById.mockResolvedValue({ ...fakeDocRow, translations: { vi: { title: 'Báo cáo' } } });
        const result = await svc.getAdminDocumentById(adminActor, 20);
        expect(result.translations).toBeDefined();
    });
});

// ── createDocument ─────────────────────────────────────────────────────────────

describe('createDocument', () => {
    const payload = { docType: 'bao_cao', isPublic: true, lang: 'vi', title: 'Báo cáo <b>mới</b>', description: null };

    beforeEach(() => {
        docRepo.createMeta.mockResolvedValue({ id: 30, doc_type: 'bao_cao', file_url: '/uploads/doc.pdf', is_public: true, created_at: new Date() });
        docRepo.createTranslation.mockResolvedValue({ lang: 'vi', title: 'Báo cáo mới', description: null });
    });

    test('throws 403 for non-manage roles', async () => {
        await expect(svc.createDocument(citizenActor, payload, fakeFile)).rejects.toMatchObject({ status: 403 });
        await expect(svc.createDocument(ubndActor, payload, fakeFile)).rejects.toMatchObject({ status: 403 });
    });

    test('throws 400 when no file provided', async () => {
        await expect(svc.createDocument(adminActor, payload, null)).rejects.toMatchObject({ status: 400 });
    });

    test('strips HTML tags from title before saving', async () => {
        await svc.createDocument(adminActor, payload, fakeFile);
        expect(docRepo.createTranslation).toHaveBeenCalledWith(
            expect.objectContaining({ title: 'Báo cáo mới' }),  // stripTags removes <b>
        );
    });

    test('builds file path from file object', async () => {
        await svc.createDocument(soNnmtActor, payload, fakeFile);
        expect(docRepo.createMeta).toHaveBeenCalledWith(
            expect.objectContaining({ fileUrl: '/uploads/documents/2026/07/report-abc123.pdf' }),
        );
    });

    test('so_nnmt can create document', async () => {
        const result = await svc.createDocument(soNnmtActor, payload, fakeFile);
        expect(result).toHaveProperty('document');
        expect(result.document.id).toBe(30);
    });
});

// ── updateDocumentMeta ─────────────────────────────────────────────────────────

describe('updateDocumentMeta', () => {
    beforeEach(() => {
        docRepo.findRaw.mockResolvedValue(fakeDocRow);
        docRepo.updateMeta.mockResolvedValue({ id: 20, doc_type: 'van_ban', is_public: false });
    });

    test('throws 403 for non-manage roles', async () => {
        await expect(svc.updateDocumentMeta(citizenActor, 20, {})).rejects.toMatchObject({ status: 403 });
    });

    test('throws 404 when document not found', async () => {
        docRepo.findRaw.mockResolvedValue(null);
        await expect(svc.updateDocumentMeta(adminActor, 999, {})).rejects.toMatchObject({ status: 404 });
    });

    test('throws 409 on optimistic lock conflict', async () => {
        docRepo.updateMeta.mockResolvedValue(null);
        await expect(svc.updateDocumentMeta(adminActor, 20, {})).rejects.toMatchObject({ status: 409 });
    });

    test('returns updated document summary', async () => {
        const result = await svc.updateDocumentMeta(adminActor, 20, { docType: 'van_ban' });
        expect(result.document.id).toBe(20);
    });
});

// ── deleteDocument ─────────────────────────────────────────────────────────────

describe('deleteDocument', () => {
    test('throws 403 for non-manage roles', async () => {
        await expect(svc.deleteDocument(citizenActor, 20)).rejects.toMatchObject({ status: 403 });
    });

    test('throws 404 when document not found', async () => {
        docRepo.softDelete.mockResolvedValue(null);
        await expect(svc.deleteDocument(adminActor, 999)).rejects.toMatchObject({ status: 404 });
    });

    test('soft deletes successfully', async () => {
        docRepo.softDelete.mockResolvedValue({ id: 20 });
        const result = await svc.deleteDocument(adminActor, 20);
        expect(result).toHaveProperty('message');
        expect(docRepo.softDelete).toHaveBeenCalledWith(20);
    });
});

// ── updateDocumentFull ─────────────────────────────────────────────────────────

describe('updateDocumentFull', () => {
    let client;
    beforeEach(() => {
        client = makeMockClient();
        db.getClient.mockResolvedValue(client);
        docRepo.findRaw.mockResolvedValue(fakeDocRow);
        docRepo.updateMeta.mockResolvedValue({ id: 20, doc_type: 'bao_cao', is_public: true });
        docRepo.upsertTranslation.mockResolvedValue({ lang: 'vi', title: 'Cập nhật', description: null });
        docRepo.findAdminById.mockResolvedValue({ ...fakeDocRow, translations: { vi: { title: 'Cập nhật' } } });
    });

    test('throws 403 for non-manage roles', async () => {
        await expect(svc.updateDocumentFull(citizenActor, 20, {})).rejects.toMatchObject({ status: 403 });
    });

    test('throws 404 when document not found', async () => {
        docRepo.findRaw.mockResolvedValue(null);
        await expect(svc.updateDocumentFull(adminActor, 999, {})).rejects.toMatchObject({ status: 404 });
    });

    test('commits transaction and returns full detail', async () => {
        const result = await svc.updateDocumentFull(adminActor, 20, {
            translations: { vi: { title: 'Cập nhật', description: null } },
        });
        expect(client.query).toHaveBeenCalledWith('BEGIN');
        expect(client.query).toHaveBeenCalledWith('COMMIT');
        expect(result.document).toBeDefined();
    });

    test('rolls back and throws on optimistic lock conflict', async () => {
        docRepo.updateMeta.mockResolvedValue(null);
        await expect(svc.updateDocumentFull(adminActor, 20, {})).rejects.toMatchObject({ status: 409 });
        expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    });

    test('always releases db client', async () => {
        docRepo.updateMeta.mockResolvedValue(null);
        await svc.updateDocumentFull(adminActor, 20, {}).catch(() => {});
        expect(client.release).toHaveBeenCalled();
    });

    test('upserts each provided translation', async () => {
        await svc.updateDocumentFull(adminActor, 20, {
            translations: { vi: { title: 'Tiêu đề vi', description: null }, en: { title: 'Title en', description: null } },
        });
        expect(docRepo.upsertTranslation).toHaveBeenCalledTimes(2);
    });
});
