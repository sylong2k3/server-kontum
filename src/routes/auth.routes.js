const { Router } = require('express');
const passport = require('passport');
const rateLimit = require('express-rate-limit');
const asyncHandler = require('../helpers/async-handler');
const authController = require('../controllers/auth.controller');
const { verifyToken } = require('../middlewares/auth.middleware');
const { validate } = require('../middlewares/validate.middleware');
const {
    registerSchema,
    loginSchema,
    refreshSchema,
    changePasswordSchema,
    setPasswordSchema,
    logoutSchema,
    googleMobileSchema,
    forgotPasswordSchema,
    resetPasswordSchema,
    oauthExchangeSchema,
    verifyEmailSchema,
    resendVerificationSchema,
    updateProfileSchema,
} = require('../validators/auth.validator');

const router = Router();

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: parseInt(process.env.AUTH_RATE_LIMIT, 10) || 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        message: 'Quá nhiều yêu cầu. Vui lòng thử lại sau ít phút.',
        errors: ['TOO_MANY_REQUESTS'],
    },
});

const passwordResetLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: parseInt(process.env.RESET_RATE_LIMIT, 10) || 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        message: 'Quá nhiều yêu cầu. Vui lòng thử lại sau ít phút.',
        errors: ['TOO_MANY_REQUESTS'],
    },
});

router.post('/register', authLimiter, validate(registerSchema), asyncHandler(authController.register));
router.post('/login', authLimiter, validate(loginSchema), asyncHandler(authController.login));
router.post('/refresh', validate(refreshSchema), asyncHandler(authController.refreshToken));
router.post('/forgot-password', passwordResetLimiter, validate(forgotPasswordSchema), asyncHandler(authController.forgotPassword));
router.post('/reset-password', passwordResetLimiter, validate(resetPasswordSchema), asyncHandler(authController.resetPassword));
router.post('/verify-email', authLimiter, validate(verifyEmailSchema), asyncHandler(authController.verifyEmail));
router.post('/resend-verification', passwordResetLimiter, validate(resendVerificationSchema), asyncHandler(authController.resendVerification));

router.get('/google', passport.authenticate('google', { scope: ['profile', 'email'], session: false }));
router.get('/google/callback',
    passport.authenticate('google', {
        session: false,
        failureRedirect: `${process.env.FRONTEND_URL || process.env.APP_URL || 'http://localhost:3000'}/auth/login?error=google_auth_failed`,
    }),
    asyncHandler(authController.googleCallback)
);
router.post('/google/mobile', authLimiter, validate(googleMobileSchema), asyncHandler(authController.googleMobileLogin));
router.post('/oauth/exchange', authLimiter, validate(oauthExchangeSchema), asyncHandler(authController.oauthExchange));

router.post('/logout', verifyToken, validate(logoutSchema), asyncHandler(authController.logout));
router.post('/change-password', verifyToken, validate(changePasswordSchema), asyncHandler(authController.changePassword));
router.post('/set-password', verifyToken, validate(setPasswordSchema), asyncHandler(authController.setPassword));
router.get('/me', verifyToken, asyncHandler(authController.getMe));
router.patch('/me', verifyToken, validate(updateProfileSchema), asyncHandler(authController.updateMe));

module.exports = router;
