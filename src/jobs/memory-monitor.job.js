'use strict';

const os = require('os');

const MB = 1024 * 1024;
const SAMPLE_INTERVAL_MS = Math.max(
    10_000,
    Number.parseInt(process.env.PROCESS_MEMORY_MONITOR_INTERVAL_MS, 10) || 60_000,
);
const SUMMARY_INTERVAL_MS = Math.max(
    SAMPLE_INTERVAL_MS,
    Number.parseInt(process.env.PROCESS_MEMORY_LOG_INTERVAL_MS, 10) || 15 * 60_000,
);
const WARNING_COOLDOWN_MS = Math.max(
    SUMMARY_INTERVAL_MS,
    Number.parseInt(process.env.PROCESS_MEMORY_WARNING_COOLDOWN_MS, 10) || 15 * 60_000,
);
const WARN_RSS_MB = Math.max(
    256,
    Number.parseInt(process.env.PROCESS_MEMORY_WARN_RSS_MB, 10) || 1024,
);
const CRITICAL_RSS_MB = Math.max(
    WARN_RSS_MB + 128,
    Number.parseInt(process.env.PROCESS_MEMORY_CRITICAL_RSS_MB, 10) || 1536,
);

let timer = null;
let peakRssBytes = 0;
let peakHeapUsedBytes = 0;
let lastSummaryAt = 0;
let lastWarningAt = 0;
let lastWarningLevel = null;

const toMb = (bytes) => (Number(bytes || 0) / MB).toFixed(0);

const readMemory = () => {
    const memory = process.memoryUsage();
    peakRssBytes = Math.max(peakRssBytes, memory.rss);
    peakHeapUsedBytes = Math.max(peakHeapUsedBytes, memory.heapUsed);
    return memory;
};

const sample = ({ forceSummary = false } = {}) => {
    const now = Date.now();
    const memory = readMemory();
    const rssMb = memory.rss / MB;
    const warningLevel = rssMb >= CRITICAL_RSS_MB
        ? 'CRITICAL'
        : rssMb >= WARN_RSS_MB ? 'WARN' : null;

    if (warningLevel) {
        const shouldLog =
            warningLevel !== lastWarningLevel ||
            now - lastWarningAt >= WARNING_COOLDOWN_MS;
        if (shouldLog) {
            console.warn(
                `[MEMORY] ${warningLevel} rss=${toMb(memory.rss)}MB ` +
                `heap=${toMb(memory.heapUsed)}/${toMb(memory.heapTotal)}MB ` +
                `external=${toMb(memory.external)}MB arrayBuffers=${toMb(memory.arrayBuffers)}MB ` +
                `system=${Math.round((memory.rss / os.totalmem()) * 100)}%`,
            );
            lastWarningAt = now;
        }
    } else {
        lastWarningLevel = null;
    }
    if (warningLevel) lastWarningLevel = warningLevel;

    if (forceSummary || now - lastSummaryAt >= SUMMARY_INTERVAL_MS) {
        console.info(
            `[MEMORY] SUMMARY rss=${toMb(memory.rss)}MB heap=${toMb(memory.heapUsed)}MB ` +
            `external=${toMb(memory.external)}MB peakRss=${toMb(peakRssBytes)}MB ` +
            `peakHeap=${toMb(peakHeapUsedBytes)}MB`,
        );
        lastSummaryAt = now;
    }

    return {
        ...memory,
        peakRss: peakRssBytes,
        peakHeapUsed: peakHeapUsedBytes,
    };
};

const start = () => {
    if (timer) return;
    const initial = readMemory();
    lastSummaryAt = Date.now();
    console.info(
        `[MEMORY] STARTED sample=${Math.round(SAMPLE_INTERVAL_MS / 1000)}s ` +
        `summary=${Math.round(SUMMARY_INTERVAL_MS / 60_000)}m ` +
        `warnRss=${WARN_RSS_MB}MB criticalRss=${CRITICAL_RSS_MB}MB ` +
        `initialRss=${toMb(initial.rss)}MB`,
    );
    timer = setInterval(() => sample(), SAMPLE_INTERVAL_MS);
    timer.unref?.();
};

const stop = () => {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
    sample({ forceSummary: true });
    console.info('[MEMORY] STOPPED');
};

module.exports = {
    start,
    stop,
    sample,
};
