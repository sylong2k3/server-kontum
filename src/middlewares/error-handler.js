/**
 * Error Handler Middleware
 *
 * Xử lý tất cả errors trong Express pipeline:
 * 1. notFoundHandler — Route không tồn tại → 404
 * 2. errorHandler — Xử lý BaseError (operational) + unexpected errors
 */

const { BaseError } = require('../core/error.response');
const { t } = require('../utils/i18n');

/**
 * 404 Not Found Handler
 * Mount SAU tất cả routes — bắt request không match route nào
 */
const notFoundHandler = (req, res, next) => {
    const error = new Error(`Route ${req.method} ${req.originalUrl} not found`);
    error.status = 404;
    next(error);
};

/**
 * Global Error Handler
 * Mount CUỐI CÙNG trong middleware chain
 *
 * Phân biệt:
 * - BaseError (operational): lỗi business logic, trả message rõ ràng
 * - Unexpected Error: lỗi hệ thống, log chi tiết nhưng trả message chung
 */
const errorHandler = (err, req, res, next) => {
    // Nếu response đã gửi rồi thì delegate cho Express default handler
    if (res.headersSent) {
        return next(err);
    }

    // ── Operational Error (BaseError subclass) ──────────────────────────
    if (err instanceof BaseError) {
        return res.status(err.status).json({
            success: false,
            message: err.message,
            errors: err.errors || [],
            ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
        });
    }

    // ── Joi Validation Error ────────────────────────────────────────────
    if (err.isJoi) {
        const messages = err.details.map((d) => d.message);
        return res.status(400).json({
            success: false,
            message: t('invalid_data', req.lang),
            errors: messages,
        });
    }

    // ── JWT Errors ──────────────────────────────────────────────────────
    if (err.name === 'JsonWebTokenError') {
        return res.status(401).json({
            success: false,
            message: t('invalid_token', req.lang),
            errors: ['INVALID_TOKEN'],
        });
    }

    if (err.name === 'TokenExpiredError') {
        return res.status(401).json({
            success: false,
            message: t('token_expired', req.lang),
            errors: ['TOKEN_EXPIRED'],
        });
    }

    // ── CORS Error ──────────────────────────────────────────────────────
    if (err.message && err.message.includes('CORS')) {
        return res.status(403).json({
            success: false,
            message: err.message,
            errors: ['CORS_ERROR'],
        });
    }

    // ── Unexpected Error ────────────────────────────────────────────────
    const statusCode = err.status || err.statusCode || 500;
    console.error('[ERROR]', {
        method: req.method,
        url: req.originalUrl,
        status: statusCode,
        message: err.message,
        stack: err.stack,
    });

    return res.status(statusCode).json({
        success: false,
        message: process.env.NODE_ENV === 'production'
            ? 'Internal Server Error'
            : err.message || 'Internal Server Error',
        errors: ['INTERNAL_ERROR'],
        ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
    });
};

module.exports = {
    notFoundHandler,
    errorHandler,
};
