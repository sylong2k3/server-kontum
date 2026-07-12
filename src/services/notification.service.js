const notificationRepository = require('../repositories/notification.repository');
const pushProvider = require('../utils/pushProvider.util');
const ws = require('../realtime/websocket.server');
const { Api400Error, Api404Error } = require('../core/error.response');
const { t } = require('../utils/i18n.util');

const WS_EVENT = 'notification';
const TOPIC_ALL = 'all';
const roleTopic = (roleCode) => `role_${roleCode}`;

// ════════════════════════════════════════════════════════════════════════════
//  PHÁT THÔNG BÁO (persist → realtime → push)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Gửi thông báo cá nhân tới 1 người dùng.
 * Luồng: lưu DB → đẩy WebSocket (nếu online) → push FCM (mọi thiết bị đã đăng ký).
 */
const sendToUser = async (userId, { type, title, body, data = {}, channel = 'system', expiresAt = null }, context = {}) => {
    if (!userId || !type || !title) {
        throw new Api400Error(t('notification_send_user_required', context.lang));
    }

    const notification = await notificationRepository.create({
        userId,
        audience: 'user',
        channel,
        type,
        title,
        body,
        data,
        expiresAt,
    });

    // Realtime cho thiết bị đang mở app
    _safe(() => ws.notifyUser(userId, WS_EVENT, _toClientPayload(notification)));

    // Push cho thiết bị nền/đóng app
    _safe(async () => {
        const tokens = await notificationRepository.getActiveTokensByUser(userId);
        await _pushAndPrune(tokens, notification);
    });

    return notification;
};

/**
 * Gửi thông báo broadcast tới toàn bộ người dùng.
 */
const broadcastToAll = async ({ type, title, body, data = {}, channel = 'system', expiresAt = null }, context = {}) => {
    if (!type || !title) {
        throw new Api400Error(t('notification_send_all_required', context.lang));
    }

    const notification = await notificationRepository.create({
        userId: null,
        audience: 'all',
        channel,
        type,
        title,
        body,
        data,
        expiresAt,
    });

    _safe(() => ws.broadcast(WS_EVENT, _toClientPayload(notification)));
    _safe(() => pushProvider.sendToTopic(TOPIC_ALL, _toPushPayload(notification)));

    return notification;
};

/**
 * Gửi thông báo broadcast tới toàn bộ người dùng thuộc 1 vai trò.
 */
const broadcastToRole = async (roleCode, { type, title, body, data = {}, channel = 'system', expiresAt = null }, context = {}) => {
    if (!roleCode || !type || !title) {
        throw new Api400Error(t('notification_send_role_required', context.lang));
    }

    const notification = await notificationRepository.create({
        userId: null,
        audience: 'role',
        audienceRole: roleCode,
        channel,
        type,
        title,
        body,
        data,
        expiresAt,
    });

    _safe(() => ws.notifyChannel(roleTopic(roleCode), WS_EVENT, _toClientPayload(notification)));
    _safe(() => pushProvider.sendToTopic(roleTopic(roleCode), _toPushPayload(notification)));

    return notification;
};

// ════════════════════════════════════════════════════════════════════════════
//  TRUY VẤN PHÍA NGƯỜI DÙNG
// ════════════════════════════════════════════════════════════════════════════

const listNotifications = async (actor, {
    page = 1,
    limit = 20,
    onlyUnread = false,
    isRead,
    channel,
    type,
    audience,
    sortBy = 'created_at',
    sortOrder = 'DESC',
}) => {
    const offset = (page - 1) * limit;
    const filter = { channel, type, audience, isRead: onlyUnread ? false : isRead, sortBy, sortOrder };

    const { items, total } = await notificationRepository.listForUser({
        userId: actor.id,
        roleCode: actor.role,
        limit,
        offset,
        filter,
    });

    return { items: items.map(_toClientPayload), total };
};

const getUnreadCount = async (actor) => {
    const count = await notificationRepository.countUnread({
        userId: actor.id,
        roleCode: actor.role,
    });
    return { unread: count };
};

const markAsRead = async (actor, notificationId, context = {}) => {
    const visible = await notificationRepository.isVisibleToUser({
        notificationId,
        userId: actor.id,
        roleCode: actor.role,
    });
    if (!visible) {
        throw new Api404Error(t('notification_not_found', context.lang));
    }

    await notificationRepository.markRead({ notificationId, userId: actor.id });
    return { message: t('notification_marked_read', context.lang) };
};

const markAllAsRead = async (actor, context = {}) => {
    const count = await notificationRepository.markAllRead({
        userId: actor.id,
        roleCode: actor.role,
    });
    return { message: t('notifications_all_read', context.lang), count };
};

const deleteNotification = async (actor, notificationId, context = {}) => {
    const deleted = await notificationRepository.deleteForUser({
        notificationId,
        userId: actor.id,
        roleCode: actor.role,
    });
    if (!deleted) {
        throw new Api404Error(t('notification_not_found', context.lang));
    }
    return { message: t('notification_deleted', context.lang) };
};

// ════════════════════════════════════════════════════════════════════════════
//  ĐĂNG KÝ THIẾT BỊ (FCM device token)
// ════════════════════════════════════════════════════════════════════════════

const registerDevice = async (actor, { token, platform, deviceInfo = {} }, context = {}) => {
    const record = await notificationRepository.upsertDeviceToken({
        userId: actor.id,
        token,
        platform,
        deviceInfo,
    });

    // Đăng ký token vào các topic broadcast (best-effort, không chặn response).
    _safe(async () => {
        await pushProvider.subscribeToTopic(token, TOPIC_ALL);
        if (actor.role) {
            await pushProvider.subscribeToTopic(token, roleTopic(actor.role));
        }
    });

    return {
        message: t('device_registered', context.lang),
        device: { id: record.id, platform: record.platform },
    };
};

const unregisterDevice = async (actor, { token }, context = {}) => {
    await notificationRepository.removeDeviceToken({ userId: actor.id, token });

    _safe(async () => {
        await pushProvider.unsubscribeFromTopic(token, TOPIC_ALL);
        if (actor.role) {
            await pushProvider.unsubscribeFromTopic(token, roleTopic(actor.role));
        }
    });

    return { message: t('device_unregistered', context.lang) };
};

// ════════════════════════════════════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════════════════════════════════════

const _toClientPayload = (n) => ({
    id: n.id,
    channel: n.channel,
    type: n.type,
    title: n.title,
    body: n.body,
    data: n.data || {},
    isRead: n.is_read === true,
    readAt: n.read_at || null,
    createdAt: n.created_at,
});

const _toPushPayload = (n) => ({
    title: n.title,
    body: n.body,
    data: {
        notificationId: n.id,
        channel: n.channel,
        type: n.type,
        ...(n.data || {}),
    },
});

// Gửi push tới tokens và dọn token chết.
const _pushAndPrune = async (tokens, notification) => {
    if (!tokens || tokens.length === 0) {return;}
    const result = await pushProvider.sendToTokens(tokens, _toPushPayload(notification));
    if (result.invalidTokens.length > 0) {
        await notificationRepository.deleteTokens(result.invalidTokens);
    }
};

// Chạy tác vụ phụ (realtime/push) mà không làm hỏng luồng chính nếu lỗi.
const _safe = (fn) => {
    try {
        const result = fn();
        if (result && typeof result.catch === 'function') {
            result.catch((err) => console.error('[NOTIFICATION] dispatch error:', err.message));
        }
    } catch (err) {
        console.error('[NOTIFICATION] dispatch error:', err.message);
    }
};

module.exports = {
    sendToUser,
    broadcastToAll,
    broadcastToRole,
    listNotifications,
    getUnreadCount,
    markAsRead,
    markAllAsRead,
    deleteNotification,
    registerDevice,
    unregisterDevice,
};
