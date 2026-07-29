'use strict';

/**
 * Điều phối export raster theo huyện ở nền.
 *
 * Payload chứa graph GEE đã dựng trong analysis nhưng request/API không chờ
 * download. Tác vụ export vẫn đi qua queue GEE chung với priority thấp hơn
 * analysis, nhờ đó fire-risk và forest-classification không chạy chồng nhau.
 */

const geeQueue = require('../queues/gee-task.queue');

let started = false;

const startWorker = () => {
    if (started) return;
    started = true;
    console.info('[DISTRICT-RASTER-WORKER] STARTED concurrency=1 via GEE queue');
};

const stopWorker = () => {
    if (!started) return;
    started = false;
    console.info('[DISTRICT-RASTER-WORKER] STOPPED');
};

const enqueue = ({
    kind,
    snapshotId,
    label,
    run,
}) => {
    if (!started) {
        return Promise.reject(new Error('District raster export worker is not started.'));
    }
    return geeQueue.enqueue({
        key: `district-raster:${kind}:${snapshotId}`,
        label: label || `${kind} district raster export snapshot=${snapshotId}`,
        priority: -10,
        run,
    });
};

module.exports = {
    startWorker,
    stopWorker,
    enqueue,
};
