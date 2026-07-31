'use strict';

jest.mock('../../configs/database', () => ({
    query: jest.fn(),
    getClient: jest.fn(),
}));
jest.mock('../../repositories/feedback.repository');
jest.mock('../../repositories/comment.repository');
jest.mock('../../repositories/news.repository');
jest.mock('../notification.service', () => ({
    broadcastToRole: jest.fn().mockResolvedValue({ id: 1 }),
    sendToUser: jest.fn().mockResolvedValue({ id: 2 }),
}));

const feedbackRepository = require('../../repositories/feedback.repository');
const commentRepository = require('../../repositories/comment.repository');
const newsRepository = require('../../repositories/news.repository');
const notificationService = require('../notification.service');
const feedbackService = require('../feedback.service');
const commentService = require('../comment.service');
const newsService = require('../news.service');

describe('notification events for feedback, comments, and news', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        notificationService.broadcastToRole.mockResolvedValue({ id: 1 });
        notificationService.sendToUser.mockResolvedValue({ id: 2 });
    });

    test('new feedback notifies every internal role with an admin path', async () => {
        feedbackRepository.findDuplicate.mockResolvedValue(null);
        feedbackRepository.create.mockResolvedValue({
            id: 15,
            user_id: 7,
            category: 'vi_pham',
            title: 'Khai thác rừng trái phép',
            description: 'Mô tả',
            status: 'new',
            priority: 'high',
            media_urls: [],
            lng: 107.9,
            lat: 14.4,
        });

        await feedbackService.createFeedback(
            { id: 7, role: 'citizen' },
            {
                category: 'vi_pham',
                title: 'Khai thác rừng trái phép',
                description: 'Mô tả',
                priority: 'high',
                lng: 107.9,
                lat: 14.4,
            },
            [],
            { lang: 'vi' }
        );

        expect(notificationService.broadcastToRole).toHaveBeenCalledTimes(3);
        expect(notificationService.broadcastToRole.mock.calls.map(([role]) => role)).toEqual([
            'system_admin',
            'so_nnmt',
            'ubnd_tinh',
        ]);
        expect(notificationService.broadcastToRole).toHaveBeenCalledWith(
            'system_admin',
            expect.objectContaining({
                channel: 'feedback',
                type: 'feedback_created',
                data: expect.objectContaining({ feedbackId: 15, path: '/feedbacks' }),
            }),
            { lang: 'vi' }
        );
    });

    test('feedback status change notifies its authenticated owner', async () => {
        feedbackRepository.findById.mockResolvedValue({
            id: 15,
            user_id: 7,
            title: 'Khai thác rừng trái phép',
            status: 'new',
        });
        feedbackRepository.updateStatus.mockResolvedValue({
            id: 15,
            user_id: 7,
            title: 'Khai thác rừng trái phép',
            status: 'in_progress',
            media_urls: [],
        });

        await feedbackService.updateStatus(
            { id: 1, role: 'system_admin' },
            15,
            { toStatus: 'in_progress', note: 'Đã tiếp nhận' },
            { lang: 'vi' }
        );

        expect(notificationService.sendToUser).toHaveBeenCalledWith(
            7,
            expect.objectContaining({
                channel: 'feedback',
                type: 'feedback_status_changed',
                data: expect.objectContaining({ feedbackId: 15, path: '/feedback/mine' }),
            }),
            { lang: 'vi' }
        );
    });

    test('new comment notifies moderators and approval notifies the author', async () => {
        newsRepository.findBySlug.mockResolvedValue({
            id: 3,
            title: 'Tin bảo vệ rừng',
            slug: 'tin-bao-ve-rung',
        });
        commentRepository.create.mockResolvedValue({
            id: 21,
            newsId: 3,
            userId: 7,
            userName: 'Người dân Kon Tum',
            content: 'Nội dung bình luận',
            isApproved: false,
        });

        await commentService.createComment(
            { id: 7, role: 'citizen' },
            'tin-bao-ve-rung',
            { content: 'Nội dung bình luận' },
            { lang: 'vi' }
        );

        expect(notificationService.broadcastToRole).toHaveBeenCalledWith(
            'system_admin',
            expect.objectContaining({
                channel: 'comment',
                type: 'comment_created',
                data: expect.objectContaining({ commentId: 21, path: '/news-comments' }),
            }),
            { lang: 'vi' }
        );

        commentRepository.findById.mockResolvedValue({
            id: 21,
            newsId: 3,
            newsTitle: 'Tin bảo vệ rừng',
            newsSlug: 'tin-bao-ve-rung',
            userId: 7,
            isApproved: false,
        });
        commentRepository.updateApproval.mockResolvedValue({ id: 21, isApproved: true });

        await commentService.approveComment(
            { id: 1, role: 'system_admin' },
            21,
            { isApproved: true },
            { lang: 'vi' }
        );

        expect(notificationService.sendToUser).toHaveBeenCalledWith(
            7,
            expect.objectContaining({
                channel: 'comment',
                type: 'comment_approved',
                data: expect.objectContaining({
                    commentId: 21,
                    path: '/news/tin-bao-ve-rung',
                }),
            }),
            { lang: 'vi' }
        );
    });

    test('publishing a new article notifies citizens with its client path', async () => {
        newsRepository.translationSlugExists.mockResolvedValue(false);
        newsRepository.createMeta.mockResolvedValue({
            id: 30,
            status: 'published',
            category: 'general',
            cover_url: null,
            published_at: new Date(),
            created_at: new Date(),
        });
        newsRepository.createTranslation.mockResolvedValue({
            lang: 'vi',
            title: 'Cập nhật bảo vệ rừng',
            slug: 'cap-nhat-bao-ve-rung',
            summary: 'Tóm tắt',
        });

        await newsService.createNews(
            {
                id: 1,
                role: 'system_admin',
                permissions: { news: { create: true } },
            },
            {
                lang: 'vi',
                status: 'published',
                category: 'general',
                title: 'Cập nhật bảo vệ rừng',
                summary: 'Tóm tắt',
                content: '<p>Nội dung</p>',
            },
            null,
            { lang: 'vi' }
        );

        expect(notificationService.broadcastToRole).toHaveBeenCalledWith(
            'citizen',
            expect.objectContaining({
                channel: 'news',
                type: 'news_published',
                data: expect.objectContaining({
                    newsId: 30,
                    path: '/news/cap-nhat-bao-ve-rung',
                }),
            }),
            { lang: 'vi' }
        );
    });
});
