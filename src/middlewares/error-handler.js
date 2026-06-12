const { BaseError } = require('../core/error.response');
const { t } = require('../utils/i18n');
const multer = require('multer');

const notFoundHandler = (req, res, next) => {
    const error = new Error(`Route ${req.method} ${req.originalUrl} not found`);
    error.status = 404;
    next(error);
};

const errorHandler = (err, req, res, next) => {
    if (res.headersSent) return next(err);

    if (err instanceof BaseError) {
        return res.status(err.status).json({
            success: false,
            message: err.message,
            errors: err.errors || [],
            ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
        });
    }

    if (err instanceof multer.MulterError) {
        let message;
        switch (err.code) {
            case 'LIMIT_FILE_SIZE':
                message = t('upload_file_too_large', req.lang);
                break;
            case 'LIMIT_FILE_COUNT':
            case 'LIMIT_UNEXPECTED_FILE':
                message = t('upload_too_many_files', req.lang);
                break;
            default:
                message = t('upload_failed', req.lang);
        }
        return res.status(400).json({
            success: false,
            message,
            errors: [err.code, err.field].filter(Boolean),
        });
    }

    if (err.isJoi) {
        const messages = err.details.map((d) => d.message);
        return res.status(400).json({
            success: false,
            message: t('invalid_data', req.lang),
            errors: messages,
        });
    }

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

    if (err.message && err.message.includes('CORS')) {
        return res.status(403).json({
            success: false,
            message: err.message,
            errors: ['CORS_ERROR'],
        });
    }

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
