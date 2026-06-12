const cron = require('node-cron');
const notificationRepository = require('../repositories/notification.repository');

// Mặc định: 03:30 mỗi ngày (giờ thấp điểm).
const CLEANUP_CRON = process.env.NOTIFICATION_CLEANUP_CRON || '30 3 * * *';
const RETENTION_DAYS = parseInt(process.env.NOTIFICATION_RETENTION_DAYS, 10) || 90;
const STALE_TOKEN_DAYS = parseInt(process.env.DEVICE_TOKEN_STALE_DAYS, 10) || 60;

let task = null;

const runCleanup = async () => {
    try {
        const result = await notificationRepository.cleanupExpired({
            retentionDays: RETENTION_DAYS,
            staleTokenDays: STALE_TOKEN_DAYS,
        });
        console.log(
            `[NOTIFICATION CLEANUP] expired=${result.expiredDeleted} ` +
            `old=${result.oldDeleted} staleTokens=${result.staleTokenDeleted}`
        );
    } catch (err) {
        console.error('[NOTIFICATION CLEANUP] Failed:', err.message);
    }
};

const start = () => {
    if (task) {return;}
    if (!cron.validate(CLEANUP_CRON)) {
        console.warn(`[NOTIFICATION CLEANUP] Invalid cron expression "${CLEANUP_CRON}" — job not started`);
        return;
    }
    task = cron.schedule(CLEANUP_CRON, runCleanup);
    console.log(`  ✓ Notification cleanup job scheduled (${CLEANUP_CRON})`);
};

const stop = () => {
    if (task) {
        task.stop();
        task = null;
    }
};

module.exports = { start, stop, runCleanup };
