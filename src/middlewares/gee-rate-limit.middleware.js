'use strict';

const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');

const keyByUserOrIp = (req) => (
    req.user?.id
        ? `user:${req.user.id}`
        : `ip:${ipKeyGenerator(req.ip)}`
);

const buildLimiter = ({
    windowMs,
    max,
    message,
    code,
}) => rateLimit({
    windowMs,
    max,
    keyGenerator: keyByUserOrIp,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res, next, options) => {
        res.status(options.statusCode).json({
            success: false,
            message,
            errors: [code],
        });
    },
});

/**
 * Chỉ áp dụng cho POST thực sự khởi chạy pipeline, sau middleware auth.
 * Hai route fire/forest dùng chung store nên một user không thể lách giới hạn
 * bằng cách xen kẽ hai module.
 */
const geeManualTriggerLimiter = buildLimiter({
    windowMs: Number.parseInt(process.env.GEE_TRIGGER_RATE_WINDOW_MS, 10)
        || 15 * 60 * 1000,
    max: Number.parseInt(process.env.GEE_TRIGGER_RATE_MAX, 10) || 6,
    message: 'Bạn đã gửi quá nhiều yêu cầu phân tích. Vui lòng thử lại sau.',
    code: 'GEE_TRIGGER_RATE_LIMITED',
});

/**
 * Query kỳ rừng là public/cache-first nhưng cache miss có thể tạo graph GEE.
 * Giới hạn riêng cao hơn refresh admin, vẫn đủ chặn quét hàng loạt tháng.
 */
const geeQueryLimiter = buildLimiter({
    windowMs: Number.parseInt(process.env.GEE_QUERY_RATE_WINDOW_MS, 10)
        || 15 * 60 * 1000,
    max: Number.parseInt(process.env.GEE_QUERY_RATE_MAX, 10) || 12,
    message: 'Bạn đã truy vấn quá nhiều kỳ phân loại. Vui lòng thử lại sau.',
    code: 'GEE_QUERY_RATE_LIMITED',
});

module.exports = {
    geeManualTriggerLimiter,
    geeQueryLimiter,
};
