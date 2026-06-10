/**
 * Auth Routes — Định tuyến tất cả endpoints xác thực
 *
 * Public routes (không cần token):
 *   POST /register      — Đăng ký
 *   POST /login         — Đăng nhập
 *   POST /refresh       — Gia hạn token
 *   GET  /google        — Redirect Google OAuth
 *   GET  /google/callback — Google callback
 *
 * Protected routes (cần access token):
 *   POST /logout            — Đăng xuất
 *   POST /change-password   — Đổi mật khẩu
 *   GET  /me                — Thông tin user hiện tại
 */

const { Router } = require('express');
const passport = require('passport');
const asyncHandler = require('../helpers/async-handler');
const authController = require('../controllers/auth.controller');
const { verifyToken } = require('../middlewares/auth.middleware');
const { validate } = require('../middlewares/validate.middleware');
const {
    registerSchema,
    loginSchema,
    refreshSchema,
    changePasswordSchema,
    logoutSchema,
} = require('../validators/auth.validator');

const router = Router();

// ═══════════════════════════════════════════════════════════════════════════
//  PUBLIC ROUTES (không cần xác thực)
// ═══════════════════════════════════════════════════════════════════════════

// Đăng ký tài khoản mới
router.post('/register',
    validate(registerSchema),
    asyncHandler(authController.register)
);

// Đăng nhập
router.post('/login',
    validate(loginSchema),
    asyncHandler(authController.login)
);

// Gia hạn access token
router.post('/refresh',
    validate(refreshSchema),
    asyncHandler(authController.refreshToken)
);

// ═══════════════════════════════════════════════════════════════════════════
//  GOOGLE OAUTH ROUTES
// ═══════════════════════════════════════════════════════════════════════════

// Redirect đến Google consent screen
router.get('/google',
    passport.authenticate('google', {
        scope: ['profile', 'email'],
        session: false,
    })
);

// Google callback → tạo/login user → redirect về frontend
router.get('/google/callback',
    passport.authenticate('google', {
        session: false,
        failureRedirect: `${process.env.APP_URL || 'http://localhost:3000'}/auth/login?error=google_auth_failed`,
    }),
    asyncHandler(authController.googleCallback)
);

// ═══════════════════════════════════════════════════════════════════════════
//  PROTECTED ROUTES (cần access token)
// ═══════════════════════════════════════════════════════════════════════════

// Đăng xuất
router.post('/logout',
    verifyToken,
    validate(logoutSchema),
    asyncHandler(authController.logout)
);

// Đổi mật khẩu
router.post('/change-password',
    verifyToken,
    validate(changePasswordSchema),
    asyncHandler(authController.changePassword)
);

// Lấy thông tin user hiện tại
router.get('/me',
    verifyToken,
    asyncHandler(authController.getMe)
);

module.exports = router;
