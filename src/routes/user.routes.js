const { Router } = require('express');
const asyncHandler = require('../helpers/async-handler');
const userController = require('../controllers/user.controller');
const { verifyToken, requireRole } = require('../middlewares/auth.middleware');
const { validate } = require('../middlewares/validate.middleware');
const {
    createUserSchema,
    updateRoleSchema,
    setActiveSchema,
    resetPasswordAdminSchema,
    updateProfileSchema,
    listUsersSchema,
} = require('../validators/user.validator');

const router = Router();

router.use(verifyToken);

router.get('/me/profile', asyncHandler(userController.getOwnProfile));
router.patch('/me/profile', validate(updateProfileSchema), asyncHandler(userController.updateOwnProfile));

router.get('/', requireRole('system_admin', 'so_nnmt'), validate(listUsersSchema, 'query'), asyncHandler(userController.listUsers));
router.post('/', requireRole('system_admin', 'so_nnmt'), validate(createUserSchema), asyncHandler(userController.createUser));
router.get('/:id', requireRole('system_admin', 'so_nnmt'), asyncHandler(userController.getUserById));
router.patch('/:id/role', requireRole('system_admin'), validate(updateRoleSchema), asyncHandler(userController.changeUserRole));
router.patch('/:id/active', requireRole('system_admin', 'so_nnmt'), validate(setActiveSchema), asyncHandler(userController.setUserActive));
router.post('/:id/reset-password', requireRole('system_admin', 'so_nnmt'), validate(resetPasswordAdminSchema), asyncHandler(userController.resetUserPassword));
router.delete('/:id', requireRole('system_admin', 'so_nnmt'), asyncHandler(userController.deleteUser));

module.exports = router;
