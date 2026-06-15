const notificationService = require('../services/notification.service');
const { OK, CREATED, OK_LIST } = require('../core/success.response');
const { t } = require('../utils/i18n.util');

const buildActor = (req) => ({
    id: req.user.id,
    role: req.user.role,
    lang: req.lang,
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
});

const listNotifications = async (req, res) => {
    const { page, limit, onlyUnread, isRead, channel, type, audience, sortBy, sortOrder } = req.query;
    const filter = { page, limit, onlyUnread, isRead, channel, type, audience, sortBy, sortOrder };
    const { items, total } = await notificationService.listNotifications(buildActor(req), filter);
    OK_LIST(res, t('get_list_success', req.lang), items, {
        page, limit, total, totalPages: Math.ceil(total / limit),
    });
};

const getUnreadCount = async (req, res) => {
    const result = await notificationService.getUnreadCount(buildActor(req));
    OK(res, t('get_success', req.lang), result);
};

const markAsRead = async (req, res) => {
    const result = await notificationService.markAsRead(buildActor(req), Number(req.params.id), { lang: req.lang });
    OK(res, result.message, {});
};

const markAllAsRead = async (req, res) => {
    const result = await notificationService.markAllAsRead(buildActor(req), { lang: req.lang });
    OK(res, result.message, { count: result.count });
};

const deleteNotification = async (req, res) => {
    const result = await notificationService.deleteNotification(buildActor(req), Number(req.params.id), { lang: req.lang });
    OK(res, result.message, {});
};

const registerDevice = async (req, res) => {
    const result = await notificationService.registerDevice(buildActor(req), req.body, { lang: req.lang });
    CREATED(res, result.message, result.device);
};

const unregisterDevice = async (req, res) => {
    const result = await notificationService.unregisterDevice(buildActor(req), req.body, { lang: req.lang });
    OK(res, result.message, {});
};

// Admin: gửi thông báo thủ công
const sendNotification = async (req, res) => {
    const { target, userId, roleCode, ...payload } = req.body;

    let notification;
    if (target === 'user') {
        notification = await notificationService.sendToUser(userId, payload);
    } else if (target === 'role') {
        notification = await notificationService.broadcastToRole(roleCode, payload);
    } else {
        notification = await notificationService.broadcastToAll(payload);
    }

    CREATED(res, t('notification_sent', req.lang), { id: notification.id });
};

module.exports = {
    listNotifications,
    getUnreadCount,
    markAsRead,
    markAllAsRead,
    deleteNotification,
    registerDevice,
    unregisterDevice,
    sendNotification,
};
