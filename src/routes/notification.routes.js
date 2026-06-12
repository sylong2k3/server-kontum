const { Router } = require('express');
const asyncHandler = require('../helpers/async-handler');
const notificationController = require('../controllers/notification.controller');
const { verifyToken, requireRole, enforcePasswordChange } = require('../middlewares/auth.middleware');
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

// ── Thông báo của chính người dùng ──────────────────────────────────────────
router.get('/', validate(listNotificationsSchema, 'query'), asyncHandler(notificationController.listNotifications));
router.get('/unread-count', asyncHandler(notificationController.getUnreadCount));
router.patch('/read-all', asyncHandler(notificationController.markAllAsRead));
router.patch('/:id/read', validate(notificationIdParamsSchema, 'params'), asyncHandler(notificationController.markAsRead));
router.delete('/:id', validate(notificationIdParamsSchema, 'params'), asyncHandler(notificationController.deleteNotification));

// ── Đăng ký thiết bị nhận push (FCM) ────────────────────────────────────────
router.post('/devices', validate(registerDeviceSchema), asyncHandler(notificationController.registerDevice));
router.delete('/devices', validate(unregisterDeviceSchema), asyncHandler(notificationController.unregisterDevice));

// ── Gửi thông báo thủ công (chỉ admin / cơ quan quản lý) ────────────────────
router.post(
    '/send',
    requireRole('system_admin', 'so_nnmt'),
    validate(sendNotificationSchema),
    asyncHandler(notificationController.sendNotification)
);

module.exports = router;
