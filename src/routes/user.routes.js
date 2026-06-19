const { Router } = require('express');
const asyncHandler = require('../helpers/async-handler');
const userController = require('../controllers/user.controller');
const { verifyToken, requirePermission, enforcePasswordChange } = require('../middlewares/auth.middleware');
const { validate } = require('../middlewares/validate.middleware');
const {
    createUserSchema,
    updateRoleSchema,
    setActiveSchema,
    resetPasswordAdminSchema,
    listUsersSchema,
    userIdParamsSchema,
} = require('../validators/user.validator');

const router = Router();

// ─── Admin endpoints — phải đặt TRƯỚC /:id để tránh conflict ─────────────────

// GET /users/admin — danh sách users
router.get(
    '/admin',
    verifyToken,
    enforcePasswordChange,
    requirePermission('users', 'read'),
    validate(listUsersSchema, 'query'),
    asyncHandler(userController.listUsers)
);

// POST /users/admin — tạo user mới
router.post(
    '/admin',
    verifyToken,
    enforcePasswordChange,
    requirePermission('users', 'create'),
    validate(createUserSchema),
    asyncHandler(userController.createUser)
);

// GET /users/admin/:id — chi tiết user
router.get(
    '/admin/:id',
    verifyToken,
    enforcePasswordChange,
    requirePermission('users', 'read'),
    validate(userIdParamsSchema, 'params'),
    asyncHandler(userController.getUserById)
);

// PATCH /users/admin/:id/role — đổi role
router.patch(
    '/admin/:id/role',
    verifyToken,
    enforcePasswordChange,
    requirePermission('users', 'change_role'),
    validate(userIdParamsSchema, 'params'),
    validate(updateRoleSchema),
    asyncHandler(userController.changeUserRole)
);

// PATCH /users/admin/:id/active — khóa/mở khóa user
router.patch(
    '/admin/:id/active',
    verifyToken,
    enforcePasswordChange,
    requirePermission('users', 'change_status'),
    validate(userIdParamsSchema, 'params'),
    validate(setActiveSchema),
    asyncHandler(userController.setUserActive)
);

// POST /users/admin/:id/reset-password — reset mật khẩu
router.post(
    '/admin/:id/reset-password',
    verifyToken,
    enforcePasswordChange,
    requirePermission('users', 'reset_password'),
    validate(userIdParamsSchema, 'params'),
    validate(resetPasswordAdminSchema),
    asyncHandler(userController.resetUserPassword)
);

// DELETE /users/admin/:id — xoá user
router.delete(
    '/admin/:id',
    verifyToken,
    enforcePasswordChange,
    requirePermission('users', 'delete'),
    validate(userIdParamsSchema, 'params'),
    asyncHandler(userController.deleteUser)
);

module.exports = router;
