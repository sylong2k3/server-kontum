const cron = require('node-cron');
const tokenRepository = require('../repositories/token.repository');

const CLEANUP_CRON = process.env.TOKEN_CLEANUP_CRON || '0 * * * *';

let task = null;

const runCleanup = async () => {
    try {
        const result = await tokenRepository.cleanupExpired();
        console.log(
            `[TOKEN CLEANUP] refresh=${result.refreshDeleted} blacklist=${result.blacklistDeleted} ` +
            `reset=${result.resetDeleted} oauthCode=${result.oauthCodeDeleted}`
        );
    } catch (err) {
        console.error('[TOKEN CLEANUP] Failed:', err.message);
    }
};

const start = () => {
    if (task) {return;}
    if (!cron.validate(CLEANUP_CRON)) {
        console.warn(`[TOKEN CLEANUP] Invalid cron expression "${CLEANUP_CRON}" — job not started`);
        return;
    }
    task = cron.schedule(CLEANUP_CRON, runCleanup);
    console.log(`  ✓ Token cleanup job scheduled (${CLEANUP_CRON})`);
};

const stop = () => {
    if (task) {
        task.stop();
        task = null;
    }
};

module.exports = { start, stop, runCleanup };
