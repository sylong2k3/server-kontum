const { Router } = require('express');
const asyncHandler = require('../helpers/async-handler');
const notificationController = require('../controllers/notification.controller');
const { verifyToken, requirePermission, enforcePasswordChange } = require('../middlewares/auth.middleware');
const { validate } = require('../middlewares/validate.middleware');
const {
    listNotificationsSchema,
    notificationIdParamsSchema,
    registerDeviceSchema,
    unregisterDeviceSchema,
    sendNotificationSchema,
} = require('../validators/notification.validator');

const router = Router();

router.use(verifyToken);
router.use(enforcePasswordChange);

// ── Đăng ký thiết bị nhận push (FCM) ────────────────────────────────────────
// Phải khai báo trước '/:id' bên dưới, nếu không '/devices' sẽ bị route đó
// nuốt mất (Express match theo thứ tự khai báo).
router.post('/devices', validate(registerDeviceSchema), asyncHandler(notificationController.registerDevice));
router.delete('/devices', validate(unregisterDeviceSchema), asyncHandler(notificationController.unregisterDevice));

// ── Thông báo của chính người dùng ──────────────────────────────────────────
router.get('/', validate(listNotificationsSchema, 'query'), asyncHandler(notificationController.listNotifications));
router.get('/unread-count', asyncHandler(notificationController.getUnreadCount));
router.patch('/read-all', asyncHandler(notificationController.markAllAsRead));
router.patch('/:id/read', validate(notificationIdParamsSchema, 'params'), asyncHandler(notificationController.markAsRead));
router.delete('/:id', validate(notificationIdParamsSchema, 'params'), asyncHandler(notificationController.deleteNotification));

// ── Gửi thông báo thủ công (chỉ admin / cơ quan quản lý) ────────────────────
router.post(
    '/send',
    requirePermission('notifications', 'send'),
    validate(sendNotificationSchema),
    asyncHandler(notificationController.sendNotification)
);

module.exports = router;
