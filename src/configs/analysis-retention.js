'use strict';

const ENABLED = process.env.ANALYSIS_RETENTION_ENABLED !== 'false';
const CRON = process.env.ANALYSIS_RETENTION_CRON || '45 3 * * *';
const TIMEZONE = process.env.ANALYSIS_RETENTION_TZ || 'Asia/Ho_Chi_Minh';

// Cảnh báo cháy có dữ liệu hằng ngày nên giữ 90 ngày. Phân loại rừng theo tháng
// cần chuỗi so sánh dài hơn, mặc định giữ 36 tháng.
const FIRE_RISK_DAYS = Math.max(
    30,
    Number.parseInt(process.env.FIRE_RISK_RETENTION_DAYS, 10) || 90,
);
const FOREST_CLASSIFICATION_MONTHS = Math.max(
    12,
    Number.parseInt(process.env.FOREST_CLASSIFICATION_RETENTION_MONTHS, 10) || 36,
);
const BATCH_SIZE = Math.max(
    1,
    Math.min(
        100,
        Number.parseInt(process.env.ANALYSIS_RETENTION_BATCH_SIZE, 10) || 20,
    ),
);

module.exports = {
    ENABLED,
    CRON,
    TIMEZONE,
    FIRE_RISK_DAYS,
    FOREST_CLASSIFICATION_MONTHS,
    BATCH_SIZE,
};
