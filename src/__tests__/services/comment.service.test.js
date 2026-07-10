'use strict';

// ── Mocks ──────────────────────────────────────────────────────────────────────

jest.mock('../../repositories/comment.repository', () => ({
    create:           jest.fn(),
    findAllByNewsId:  jest.fn(),
    countAllByNewsId: jest.fn(),
    findAll:          jest.fn(),
    countAll:         jest.fn(),
    findById:         jest.fn(),
    updateApproval:   jest.fn(),
    softDelete:       jest.fn(),
}));

jest.mock('../../repositories/news.repository', () => ({
    findBySlug: jest.fn(),
}));

jest.mock('../../middlewares/auth.middleware', () => ({
    hasPermission: jest.fn((permissions, resource, action) => !!(permissions?.[resource]?.[action])),
}));

jest.mock('../../core/error.response', () => {
    class Api403Error extends Error { constructor(msg) { super(msg); this.status = 403; } }
    class Api404Error extends Error { constructor(msg) { super(msg); this.status = 404; } }
    return { Api403Error, Api404Error };
});

jest.mock('../../utils/i18n.util', () => ({ t: (key) => key }));
jest.mock('../../utils/cms.util', () => ({
    stripTags: (str) => (str || '').replace(/<[^>]*>/g, ''),
}));

const commentRepo = require('../../repositories/comment.repository');
const newsRepo    = require('../../repositories/news.repository');
const svc         = require('../../services/comment.service');

// ── Fixtures ───────────────────────────────────────────────────────────────────

const adminActor  = { id: 1, role: 'system_admin', permissions: {} };
const moderActor  = { id: 2, role: 'so_nnmt',      permissions: { comments: { approve: true, delete: true } } };
const citizenActor = { id: 3, role: 'citizen',      permissions: { comments: { create: true, delete_own: true } } };

const fakeNews    = { id: 10, slug: 'tin-test', status: 'published' };
const fakeComment = { id: 100, newsId: 10, userId: 3, content: 'Bình luận hay', is_approved: false };

beforeEach(() => {
    jest.clearAllMocks();
    newsRepo.findBySlug.mockResolvedValue(fakeNews);
});

// ── createComment ──────────────────────────────────────────────────────────────

describe('createComment', () => {
    beforeEach(() => {
        commentRepo.create.mockResolvedValue({ ...fakeComment, id: 101 });
    });

    test('throws 403 when actor is null', async () => {
        await expect(svc.createComment(null, 'tin-test', { content: 'hay' })).rejects.toMatchObject({ status: 403 });
    });

    test('throws 404 when news slug not found', async () => {
        newsRepo.findBySlug.mockResolvedValue(null);
        await expect(svc.createComment(citizenActor, 'khong-ton-tai', { content: 'hay' })).rejects.toMatchObject({ status: 404 });
    });

    test('strips HTML tags (not text content) before saving', async () => {
        // Mock stripTags removes tag markers; script body text stays (matches regex /<[^>]*>/g)
        await svc.createComment(citizenActor, 'tin-test', { content: '<script>alert(1)</script>Bình luận' });
        expect(commentRepo.create).toHaveBeenCalledWith(
            expect.objectContaining({ content: 'alert(1)Bình luận' }),
        );
    });

    test('creates comment with correct newsId and userId', async () => {
        await svc.createComment(citizenActor, 'tin-test', { content: 'Bình luận hay' });
        expect(commentRepo.create).toHaveBeenCalledWith(
            expect.objectContaining({ newsId: 10, userId: 3 }),
        );
    });

    test('returns message and comment on success', async () => {
        const result = await svc.createComment(citizenActor, 'tin-test', { content: 'hay' });
        expect(result).toHaveProperty('message');
        expect(result).toHaveProperty('comment');
    });
});

// ── listComments ───────────────────────────────────────────────────────────────

describe('listComments', () => {
    beforeEach(() => {
        commentRepo.findAllByNewsId.mockResolvedValue([fakeComment]);
        commentRepo.countAllByNewsId.mockResolvedValue(1);
    });

    test('public actor gets approvedOnly=true', async () => {
        await svc.listComments(citizenActor, 'tin-test', {});
        expect(commentRepo.findAllByNewsId).toHaveBeenCalledWith(
            expect.objectContaining({ approvedOnly: true }),
        );
    });

    test('moderator gets approvedOnly=false', async () => {
        await svc.listComments(moderActor, 'tin-test', {});
        expect(commentRepo.findAllByNewsId).toHaveBeenCalledWith(
            expect.objectContaining({ approvedOnly: false }),
        );
    });

    test('throws 404 when news not found', async () => {
        newsRepo.findBySlug.mockResolvedValue(null);
        await expect(svc.listComments(citizenActor, 'khong-ton-tai', {})).rejects.toMatchObject({ status: 404 });
    });

    test('applies pagination offset correctly', async () => {
        await svc.listComments(adminActor, 'tin-test', { page: 3, limit: 10 });
        expect(commentRepo.findAllByNewsId).toHaveBeenCalledWith(
            expect.objectContaining({ offset: 20, limit: 10 }),
        );
    });

    test('returns items and total', async () => {
        const result = await svc.listComments(citizenActor, 'tin-test', {});
        expect(result.total).toBe(1);
        expect(result.items).toHaveLength(1);
    });
});

// ── listAllComments ────────────────────────────────────────────────────────────

describe('listAllComments', () => {
    beforeEach(() => {
        commentRepo.findAll.mockResolvedValue([fakeComment]);
        commentRepo.countAll.mockResolvedValue(1);
    });

    test('throws 403 when actor has no approve permission', async () => {
        await expect(svc.listAllComments(citizenActor)).rejects.toMatchObject({ status: 403 });
    });

    test('moderator can list all comments', async () => {
        const result = await svc.listAllComments(moderActor);
        expect(result.items).toHaveLength(1);
    });

    test('system_admin can list all comments', async () => {
        await svc.listAllComments(adminActor);
        expect(commentRepo.findAll).toHaveBeenCalled();
    });

    test('passes approved filter to repository', async () => {
        await svc.listAllComments(moderActor, { approved: false });
        expect(commentRepo.findAll).toHaveBeenCalledWith(
            expect.objectContaining({ approved: false }),
        );
    });

    test('passes newsId filter when provided', async () => {
        await svc.listAllComments(moderActor, { newsId: '10' });
        expect(commentRepo.findAll).toHaveBeenCalledWith(
            expect.objectContaining({ newsId: 10 }),
        );
    });
});

// ── approveComment ─────────────────────────────────────────────────────────────

describe('approveComment', () => {
    beforeEach(() => {
        commentRepo.findById.mockResolvedValue(fakeComment);
        commentRepo.updateApproval.mockResolvedValue({ ...fakeComment, is_approved: true });
    });

    test('throws 403 when actor has no approve permission', async () => {
        await expect(svc.approveComment(citizenActor, 100, { isApproved: true })).rejects.toMatchObject({ status: 403 });
    });

    test('throws 404 when comment not found', async () => {
        commentRepo.findById.mockResolvedValue(null);
        await expect(svc.approveComment(moderActor, 999, {})).rejects.toMatchObject({ status: 404 });
    });

    test('approves when isApproved=true', async () => {
        await svc.approveComment(moderActor, 100, { isApproved: true });
        expect(commentRepo.updateApproval).toHaveBeenCalledWith(100, true);
    });

    test('rejects when isApproved=false', async () => {
        commentRepo.updateApproval.mockResolvedValue({ ...fakeComment, is_approved: false });
        await svc.approveComment(moderActor, 100, { isApproved: false });
        expect(commentRepo.updateApproval).toHaveBeenCalledWith(100, false);
    });

    test('defaults to approved when isApproved not provided', async () => {
        await svc.approveComment(moderActor, 100, {});
        expect(commentRepo.updateApproval).toHaveBeenCalledWith(100, true);
    });
});

// ── deleteComment ──────────────────────────────────────────────────────────────

describe('deleteComment', () => {
    beforeEach(() => {
        commentRepo.findById.mockResolvedValue(fakeComment); // userId: 3
    });

    test('throws 403 when actor is null', async () => {
        await expect(svc.deleteComment(null, 100)).rejects.toMatchObject({ status: 403 });
    });

    test('throws 404 when comment not found', async () => {
        commentRepo.findById.mockResolvedValue(null);
        await expect(svc.deleteComment(adminActor, 999)).rejects.toMatchObject({ status: 404 });
    });

    test('owner (citizen) can delete own comment', async () => {
        await svc.deleteComment(citizenActor, 100); // citizenActor.id = 3 = fakeComment.userId
        expect(commentRepo.softDelete).toHaveBeenCalledWith(100);
    });

    test('non-owner without delete permission throws 403', async () => {
        const otherCitizen = { id: 99, role: 'citizen', permissions: {} };
        await expect(svc.deleteComment(otherCitizen, 100)).rejects.toMatchObject({ status: 403 });
    });

    test('moderator with delete permission can delete any comment', async () => {
        await svc.deleteComment(moderActor, 100);
        expect(commentRepo.softDelete).toHaveBeenCalledWith(100);
    });
});
