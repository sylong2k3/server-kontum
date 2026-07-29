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
const MAX_PENDING = Math.max(
    1,
    Math.min(50, Number.parseInt(process.env.GEE_QUEUE_MAX_PENDING, 10) || 6),
);
const RECENT_COMPLETION_RETENTION_MS = Math.max(
    60 * 1000,
    Number.parseInt(process.env.GEE_QUEUE_RECENT_RETENTION_MS, 10)
        || 60 * 60 * 1000,
);
const MANUAL_TASK_COOLDOWN_MS = Math.max(
    0,
    Number.parseInt(process.env.GEE_MANUAL_COOLDOWN_MS, 10)
        || 10 * 60 * 1000,
);
const { Api429Error, BusinessLogicError } = require('../core/error.response');
const { StatusCodes } = require('../core/http-status-code');

let accepting = true;
let active = null;
let sequence = 0;
const pending = [];
const keyedPromises = new Map();
const recentCompletions = new Map();
const idleWaiters = [];

const pruneRecentCompletions = () => {
    const cutoff = Date.now() - RECENT_COMPLETION_RETENTION_MS;
    for (const [key, value] of recentCompletions) {
        if (value.finishedAt < cutoff) recentCompletions.delete(key);
    }
};

const preflight = ({ key = null, cooldownMs = 0 } = {}) => {
    const normalizedKey = key ? String(key) : null;
    if (normalizedKey && keyedPromises.has(normalizedKey)) {
        return { deduplicated: true };
    }
    if (!accepting) {
        throw new BusinessLogicError(
            'Hệ thống xử lý đang tạm dừng; yêu cầu chưa được tiếp nhận.',
            ['PROCESSING_QUEUE_STOPPING'],
            StatusCodes.SERVICE_UNAVAILABLE,
        );
    }

    pruneRecentCompletions();
    const cooldown = Math.max(0, Number(cooldownMs) || 0);
    const recent = normalizedKey ? recentCompletions.get(normalizedKey) : null;
    if (recent && cooldown > 0) {
        const retryAfterMs = cooldown - (Date.now() - recent.finishedAt);
        if (retryAfterMs > 0) {
            const error = new Api429Error(
                'Yêu cầu này vừa hoàn tất. Vui lòng chờ trước khi gửi lại.',
                ['PROCESSING_REQUEST_COOLDOWN'],
            );
            error.retryAfterMs = retryAfterMs;
            throw error;
        }
    }

    if (pending.length >= MAX_PENDING) {
        throw new BusinessLogicError(
            'Hàng chờ xử lý đang đầy. Vui lòng thử lại sau.',
            ['PROCESSING_QUEUE_FULL'],
            StatusCodes.SERVICE_UNAVAILABLE,
        );
    }
    return { deduplicated: false };
};

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
    entry.startedAt = new Date(startedAt).toISOString();
    console.info(
        `[GEE-QUEUE] START key=${entry.key || '-'} label="${entry.label}" `
        + `waiting=${pending.length} concurrency=${CONCURRENCY}`,
    );

    try {
        const result = await entry.run();
        if (entry.key) {
            recentCompletions.set(entry.key, {
                finishedAt: Date.now(),
            });
            pruneRecentCompletions();
        }
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
    cooldownMs = 0,
    run,
}) {
    if (typeof run !== 'function') {
        return Promise.reject(new TypeError('GEE queue task requires run().'));
    }
    const normalizedKey = key ? String(key) : null;
    const admission = preflight({ key: normalizedKey, cooldownMs });
    if (admission.deduplicated) {
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
        enqueuedAt: new Date().toISOString(),
        startedAt: null,
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
        maxPending: MAX_PENDING,
        capacityRemaining: Math.max(0, MAX_PENDING - pending.length),
        accepting,
        active: active
            ? {
                key: active.key,
                label: active.label,
                priority: active.priority,
                enqueuedAt: active.enqueuedAt,
                startedAt: active.startedAt,
            }
            : null,
        pending: pending.map((entry) => ({
            key: entry.key,
            label: entry.label,
            priority: entry.priority,
            enqueuedAt: entry.enqueuedAt,
        })),
    };
}

function onIdle() {
    if (!active && pending.length === 0) return Promise.resolve();
    return new Promise((resolve) => {
        idleWaiters.push(resolve);
    });
}

const hasTask = (key) => keyedPromises.has(String(key || ''));

module.exports = {
    enqueue,
    preflight,
    hasTask,
    start,
    stop,
    getState,
    onIdle,
    MANUAL_TASK_COOLDOWN_MS,
};
