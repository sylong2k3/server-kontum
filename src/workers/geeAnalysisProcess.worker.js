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

const run = ({ kind, payload }) => new Promise((resolve, reject) => {
    const child = fork(CHILD_PATH, [], {
        cwd: path.resolve(__dirname, '../..'),
        env: {
            ...process.env,
            GEE_ANALYSIS_CHILD: 'true',
        },
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        windowsHide: true,
    });

    let response = null;
    let spawnError = null;

    child.on('message', (message) => {
        if (message?.type === 'result' || message?.type === 'error') {
            response = message;
        }
    });
    child.once('error', (error) => {
        spawnError = error;
    });
    child.once('exit', (code, signal) => {
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

    child.send({ kind, payload });
});

module.exports = {
    run,
};
