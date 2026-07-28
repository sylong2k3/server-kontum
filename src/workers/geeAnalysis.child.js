'use strict';

process.env.TZ = process.env.TZ || 'Asia/Ho_Chi_Minh';
process.env.DOTENV_CONFIG_QUIET = process.env.DOTENV_CONFIG_QUIET || 'true';
require('dotenv').config({ quiet: true });

const db = require('../configs/database');
const geeQueue = require('../queues/gee-task.queue');
const districtRasterWorker = require('./districtRasterExport.worker');

let received = false;

const sendAndExit = (message, code) => {
    if (typeof process.send !== 'function') {
        process.exit(code);
        return;
    }
    process.send(message, () => process.exit(code));
};

process.once('message', async ({ kind, payload } = {}) => {
    if (received) return;
    received = true;
    geeQueue.start();
    districtRasterWorker.startWorker();

    try {
        let result;
        if (kind === 'fire-risk') {
            const service = require('../services/fire-risk.service');
            result = await service.runAnalysis(payload.analysisDate, payload.options || {});
        } else if (kind === 'forest-classification') {
            const service = require('../services/forest-classification.service');
            result = await service.runAnalysis(
                payload.year,
                payload.month,
                payload.options || {},
            );
        } else {
            throw new Error(`Unsupported GEE child job kind: ${kind || '(empty)'}`);
        }

        // executeAnalysis hoàn tất snapshot trước khi export huyện và enqueue
        // export với priority thấp. Chờ queue child rỗng để worker hoàn thành,
        // trong khi caller/API đã có thể đọc snapshot completed từ DB.
        await geeQueue.onIdle();
        districtRasterWorker.stopWorker();
        geeQueue.stop();
        await db.pool.end();
        sendAndExit({ type: 'result', result }, 0);
    } catch (error) {
        try {
            await geeQueue.onIdle();
            await db.pool.end();
        } catch (cleanupError) {
            console.warn(`[GEE-CHILD] cleanup failed: ${cleanupError.message}`);
        }
        sendAndExit({
            type:  'error',
            error: error.message,
            stack: error.stack,
        }, 1);
    }
});

process.on('disconnect', () => {
    console.warn('[GEE-CHILD] Parent IPC disconnected; terminating worker.');
    process.exit(1);
});
