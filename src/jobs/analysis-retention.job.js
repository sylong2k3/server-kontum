'use strict';

const cron = require('node-cron');
const cfg = require('../configs/analysis-retention');
const service = require('../services/analysis-retention.service');

let task = null;
let running = false;

const runCleanup = async () => {
    if (running) {
        console.warn('[ANALYSIS-RETENTION] bỏ qua vì lần dọn trước chưa kết thúc');
        return;
    }
    running = true;
    const startedAt = Date.now();
    try {
        const result = await service.runCleanup();
        const deleted = result.fire.deleted + result.forest.deleted;
        const failed = result.fire.failed + result.forest.failed;
        if (deleted > 0 || failed > 0) {
            console.info(
                `[ANALYSIS-RETENTION] DONE fire=${result.fire.deleted}/${result.fire.scanned} ` +
                `forest=${result.forest.deleted}/${result.forest.scanned} ` +
                `artifacts=${result.fire.artifacts + result.forest.artifacts} ` +
                `failed=${failed} elapsed=${Date.now() - startedAt}ms`,
            );
        }
    } catch (error) {
        console.error(`[ANALYSIS-RETENTION] ERROR: ${error.message}`);
    } finally {
        running = false;
    }
};

const start = () => {
    if (!cfg.ENABLED) {
        console.info('[ANALYSIS-RETENTION] DISABLED');
        return;
    }
    if (task) return;
    if (!cron.validate(cfg.CRON)) {
        console.warn(`[ANALYSIS-RETENTION] cron không hợp lệ: "${cfg.CRON}"`);
        return;
    }
    task = cron.schedule(cfg.CRON, runCleanup, { timezone: cfg.TIMEZONE });
    console.info(
        `[ANALYSIS-RETENTION] STARTED cron="${cfg.CRON}" timezone=${cfg.TIMEZONE} ` +
        `fire=${cfg.FIRE_RISK_DAYS}d forest=${cfg.FOREST_CLASSIFICATION_MONTHS}m ` +
        `batch=${cfg.BATCH_SIZE}`,
    );
};

const stop = () => {
    if (!task) return;
    task.stop();
    task = null;
    console.info('[ANALYSIS-RETENTION] STOPPED');
};

module.exports = {
    start,
    stop,
    runCleanup,
};
