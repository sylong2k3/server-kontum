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

const adminRouter = Router();
adminRouter.get(
    '/',
    verifyToken,
    enforcePasswordChange,
    requirePermission('users', 'read'),
    validate(listUsersSchema, 'query'),
    asyncHandler(userController.listUsers)
);

adminRouter.post(
    '/',
    verifyToken,
    enforcePasswordChange,
    requirePermission('users', 'create'),
    validate(createUserSchema),
    asyncHandler(userController.createUser)
);

// GET /admin/users/:id — chi tiết user
adminRouter.get(
    '/:id',
    verifyToken,
    enforcePasswordChange,
    requirePermission('users', 'read'),
    validate(userIdParamsSchema, 'params'),
    asyncHandler(userController.getUserById)
);

// PATCH /admin/users/:id/role — đổi role
adminRouter.patch(
    '/:id/role',
    verifyToken,
    enforcePasswordChange,
    requirePermission('users', 'change_role'),
    validate(userIdParamsSchema, 'params'),
    validate(updateRoleSchema),
    asyncHandler(userController.changeUserRole)
);

// PATCH /admin/users/:id/active — khóa/mở khóa user
adminRouter.patch(
    '/:id/active',
    verifyToken,
    enforcePasswordChange,
    requirePermission('users', 'change_status'),
    validate(userIdParamsSchema, 'params'),
    validate(setActiveSchema),
    asyncHandler(userController.setUserActive)
);

// POST /admin/users/:id/reset-password — reset mật khẩu
adminRouter.post(
    '/:id/reset-password',
    verifyToken,
    enforcePasswordChange,
    requirePermission('users', 'reset_password'),
    validate(userIdParamsSchema, 'params'),
    validate(resetPasswordAdminSchema),
    asyncHandler(userController.resetUserPassword)
);

// DELETE /admin/users/:id — xoá user
adminRouter.delete(
    '/:id',
    verifyToken,
    enforcePasswordChange,
    requirePermission('users', 'delete'),
    validate(userIdParamsSchema, 'params'),
    asyncHandler(userController.deleteUser)
);

module.exports = {
    adminRouter,
};
