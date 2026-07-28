'use strict';

/**
 * Hàng đợi GEE dùng chung cho toàn bộ runtime.
 *
 * Mọi graph Earth Engine nặng (fire-risk, forest-classification và raster
 * export theo huyện) phải đi qua queue này. PM2 hiện chạy một singleton worker
 * dưới PostgreSQL advisory lock, nên concurrency=1 trong process kết hợp với
 * lock đó bảo đảm không materialize hai graph GEE cùng lúc.
 */

const CONCURRENCY = 1;

let accepting = true;
let active = null;
let sequence = 0;
const pending = [];
const keyedPromises = new Map();
const idleWaiters = [];

const resolveIdleWaiters = () => {
    if (active || pending.length > 0) return;
    while (idleWaiters.length > 0) {
        idleWaiters.shift()();
    }
};

const sortPending = () => {
    pending.sort((a, b) => {
        if (a.priority !== b.priority) return b.priority - a.priority;
        return a.sequence - b.sequence;
    });
};

const scheduleDrain = () => {
    setImmediate(drain);
};

async function drain() {
    if (active || pending.length === 0) return;

    const entry = pending.shift();
    active = entry;
    const startedAt = Date.now();
    console.info(
        `[GEE-QUEUE] START key=${entry.key || '-'} label="${entry.label}" `
        + `waiting=${pending.length} concurrency=${CONCURRENCY}`,
    );

    try {
        const result = await entry.run();
        entry.resolve(result);
        console.info(
            `[GEE-QUEUE] DONE key=${entry.key || '-'} label="${entry.label}" `
            + `elapsed=${Date.now() - startedAt}ms`,
        );
    } catch (error) {
        entry.reject(error);
        console.error(
            `[GEE-QUEUE] FAILED key=${entry.key || '-'} label="${entry.label}" `
            + `elapsed=${Date.now() - startedAt}ms — ${error.message}`,
        );
    } finally {
        if (entry.key && keyedPromises.get(entry.key) === entry.promise) {
            keyedPromises.delete(entry.key);
        }
        active = null;
        resolveIdleWaiters();
        scheduleDrain();
    }
}

function enqueue({
    key = null,
    label,
    priority = 0,
    run,
}) {
    if (typeof run !== 'function') {
        return Promise.reject(new TypeError('GEE queue task requires run().'));
    }
    if (!accepting) {
        return Promise.reject(new Error('GEE queue is stopping; task was not accepted.'));
    }

    const normalizedKey = key ? String(key) : null;
    if (normalizedKey && keyedPromises.has(normalizedKey)) {
        console.warn(`[GEE-QUEUE] DEDUPE key=${normalizedKey}`);
        return keyedPromises.get(normalizedKey);
    }

    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    const entry = {
        key: normalizedKey,
        label: String(label || normalizedKey || 'GEE task'),
        priority: Number(priority) || 0,
        sequence: sequence++,
        run,
        resolve,
        reject,
        promise,
    };

    pending.push(entry);
    sortPending();
    if (normalizedKey) keyedPromises.set(normalizedKey, promise);
    console.info(
        `[GEE-QUEUE] QUEUED key=${normalizedKey || '-'} label="${entry.label}" `
        + `priority=${entry.priority} waiting=${pending.length}`,
    );
    scheduleDrain();
    return promise;
}

function start() {
    accepting = true;
    console.info(`[GEE-QUEUE] STARTED concurrency=${CONCURRENCY}`);
    scheduleDrain();
}

function stop() {
    accepting = false;
    console.info(
        `[GEE-QUEUE] STOPPING active=${active?.key || 'none'} waiting=${pending.length}`,
    );
}

function getState() {
    return {
        concurrency: CONCURRENCY,
        accepting,
        active: active
            ? { key: active.key, label: active.label, priority: active.priority }
            : null,
        pending: pending.map((entry) => ({
            key: entry.key,
            label: entry.label,
            priority: entry.priority,
        })),
    };
}

function onIdle() {
    if (!active && pending.length === 0) return Promise.resolve();
    return new Promise((resolve) => {
        idleWaiters.push(resolve);
    });
}

module.exports = {
    enqueue,
    start,
    stop,
    getState,
    onIdle,
};
