'use strict';

/**
 * Chạy một analysis GEE trong child process riêng.
 *
 * Queue concurrency=1 nằm ở process API. Child giữ toàn bộ Earth Engine graph,
 * thực hiện cả analysis và district-raster background phase, rồi thoát để hệ
 * điều hành thu hồi dứt điểm heap/native buffers. PM2 vì thế không còn tính
 * graph GEE vào RSS của process HTTP chính.
 */

const path = require('path');
const { fork } = require('child_process');

const CHILD_PATH = path.resolve(__dirname, 'geeAnalysis.child.js');
const CHILD_MAX_RSS_MB = Math.max(
    512,
    Number.parseInt(process.env.GEE_CHILD_MAX_RSS_MB, 10) || 2048,
);
const CHILD_MAX_OLD_SPACE_MB = Math.max(
    256,
    Math.min(
        CHILD_MAX_RSS_MB - 128,
        Number.parseInt(process.env.GEE_CHILD_MAX_OLD_SPACE_MB, 10) || 1536,
    ),
);
const CHILD_TIMEOUT_MS = Math.max(
    5 * 60 * 1000,
    Number.parseInt(process.env.GEE_CHILD_TIMEOUT_MS, 10) || 30 * 60 * 1000,
);
const MEMORY_LIMIT_SAMPLES = 2;
const KILL_GRACE_MS = 5000;

const run = ({ kind, payload }) => new Promise((resolve, reject) => {
    const execArgv = process.execArgv
        .filter((arg) =>
            !arg.startsWith('--inspect')
            && !arg.startsWith('--max-old-space-size'))
        .concat(`--max-old-space-size=${CHILD_MAX_OLD_SPACE_MB}`);
    const child = fork(CHILD_PATH, [], {
        cwd: path.resolve(__dirname, '../..'),
        env: {
            ...process.env,
            GEE_ANALYSIS_CHILD: 'true',
        },
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        windowsHide: true,
        execArgv,
    });

    let response = null;
    let spawnError = null;
    let watchdogError = null;
    let settled = false;
    let overMemorySamples = 0;
    let forceKillTimer = null;

    const clearWatchdogs = () => {
        clearTimeout(timeoutTimer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
    };

    const terminate = (error) => {
        if (watchdogError) return;
        watchdogError = error;
        console.error(
            `[GEE-CHILD] terminating kind=${kind} pid=${child.pid || '-'}: ${error.message}`,
        );
        child.kill('SIGTERM');
        forceKillTimer = setTimeout(() => {
            if (child.exitCode == null && child.signalCode == null) {
                console.error(
                    `[GEE-CHILD] force kill kind=${kind} pid=${child.pid || '-'}`,
                );
                child.kill('SIGKILL');
            }
        }, KILL_GRACE_MS);
        forceKillTimer.unref();
    };

    const timeoutTimer = setTimeout(() => {
        const error = new Error(
            `GEE child exceeded timeout ${Math.round(CHILD_TIMEOUT_MS / 60000)} minutes.`,
        );
        error.code = 'GEE_CHILD_TIMEOUT';
        terminate(error);
    }, CHILD_TIMEOUT_MS);
    timeoutTimer.unref();

    child.on('message', (message) => {
        if (message?.type === 'memory') {
            const rssBytes = Number(message.rss) || 0;
            const rssMb = rssBytes / (1024 * 1024);
            overMemorySamples = rssMb > CHILD_MAX_RSS_MB
                ? overMemorySamples + 1
                : 0;
            if (overMemorySamples >= MEMORY_LIMIT_SAMPLES) {
                const error = new Error(
                    `GEE child RSS ${rssMb.toFixed(0)}MB exceeded `
                    + `${CHILD_MAX_RSS_MB}MB limit.`,
                );
                error.code = 'GEE_CHILD_MEMORY_LIMIT';
                terminate(error);
            }
            return;
        }
        if (message?.type === 'result' || message?.type === 'error') {
            response = message;
        }
    });
    child.once('error', (error) => {
        spawnError = error;
        if (!watchdogError && !settled) {
            settled = true;
            clearWatchdogs();
            reject(error);
        }
    });
    child.once('exit', (code, signal) => {
        clearWatchdogs();
        if (settled) return;
        settled = true;
        if (watchdogError) {
            reject(watchdogError);
            return;
        }
        if (spawnError) {
            reject(spawnError);
            return;
        }
        if (response?.type === 'result' && code === 0) {
            resolve(response.result);
            return;
        }
        const detail = response?.error
            || `GEE child exited code=${code ?? 'null'} signal=${signal || 'none'}`;
        const error = new Error(detail);
        if (response?.stack) error.stack = response.stack;
        reject(error);
    });

    console.info(
        `[GEE-CHILD] spawned kind=${kind} pid=${child.pid || '-'} `
        + `heapLimit=${CHILD_MAX_OLD_SPACE_MB}MB rssLimit=${CHILD_MAX_RSS_MB}MB `
        + `timeout=${Math.round(CHILD_TIMEOUT_MS / 60000)}m`,
    );
    child.send({ kind, payload }, (error) => {
        if (!error) return;
        error.code = error.code || 'GEE_CHILD_IPC_SEND_FAILED';
        terminate(error);
    });
});

module.exports = {
    run,
};
