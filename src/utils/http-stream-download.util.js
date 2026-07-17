'use strict';

/**
 * Stream download 1 URL xuống file đĩa với:
 *   - AbortController timeout tổng thể
 *   - Chặn cứng khi vượt maxBytes (không đợi hết stream)
 *   - Trả kích thước thật đọc được
 *
 * Dùng cho GEE download URL (zip vài chục MB) — KHÔNG dùng `response.buffer()`
 * vì sẽ nạp nguyên file vào RAM.
 */

const fs = require('fs');
const { pipeline } = require('stream/promises');
const { Readable, Transform } = require('stream');

const DEBUG = process.env.RASTER_INGEST_DEBUG === 'true'
    || process.env.NODE_ENV === 'development';

const dbg = (msg) => { if (DEBUG) console.debug(`[HTTP-STREAM] ${msg}`); };

// Bỏ query string khi log để không lộ GEE access token.
const safeHost = (url) => {
    try { return new URL(url).host; } catch { return '(invalid-url)'; }
};

class DownloadError extends Error {
    constructor(message, code, cause) {
        super(message);
        this.name  = 'DownloadError';
        this.code  = code;
        this.cause = cause;
    }
}

/**
 * @param {string} url
 * @param {string} destPath
 * @param {object} opts
 * @param {number} opts.timeoutMs
 * @param {number} opts.maxBytes
 * @param {object} [opts.headers]
 */
async function downloadToFile(url, destPath, { timeoutMs, maxBytes, headers = {} }) {
    const t0 = Date.now();
    const host = safeHost(url);
    dbg(`fetch host=${host} dest=${destPath} timeout=${timeoutMs}ms maxBytes=${maxBytes}`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let bytesRead = 0;
    // Log progress mỗi ~10 MB để trace file lớn — không log per-chunk (spam).
    let nextProgressLog = 10 * 1024 * 1024;

    try {
        const res = await fetch(url, { signal: controller.signal, headers });
        dbg(`response status=${res.status} elapsed=${Date.now() - t0}ms`);

        if (!res.ok) {
            throw new DownloadError(
                `HTTP ${res.status} khi tải ${url.slice(0, 120)}…`,
                res.status >= 500 ? 'UPSTREAM_5XX' : 'UPSTREAM_4XX',
            );
        }

        // Content-Length check trước khi stream: nếu server báo trước và quá lớn
        // thì tránh mở file / mở connection.
        const declared = Number(res.headers.get('content-length') || 0);
        if (declared > 0) dbg(`content-length declared=${declared} bytes`);
        if (declared > 0 && declared > maxBytes) {
            throw new DownloadError(
                `File quá lớn: ${declared} bytes > giới hạn ${maxBytes}`,
                'FILE_TOO_LARGE',
            );
        }

        const meter = new Transform({
            transform(chunk, _enc, cb) {
                bytesRead += chunk.length;
                if (bytesRead > maxBytes) {
                    cb(new DownloadError(
                        `File quá lớn: ${bytesRead} bytes > giới hạn ${maxBytes}`,
                        'FILE_TOO_LARGE',
                    ));
                    return;
                }
                if (DEBUG && bytesRead >= nextProgressLog) {
                    console.debug(`[HTTP-STREAM] progress ${(bytesRead / 1048576).toFixed(1)}MB (${Date.now() - t0}ms)`);
                    nextProgressLog += 10 * 1024 * 1024;
                }
                cb(null, chunk);
            },
        });

        // res.body ở Node 18+ là ReadableStream (WHATWG) — Readable.fromWeb() adapt.
        const src = res.body && typeof res.body.getReader === 'function'
            ? Readable.fromWeb(res.body)
            : res.body;

        await pipeline(src, meter, fs.createWriteStream(destPath));

        const contentType = res.headers.get('content-type') || 'application/octet-stream';
        dbg(`done bytes=${bytesRead} contentType=${contentType} elapsed=${Date.now() - t0}ms`);

        return { bytes: bytesRead, contentType };
    } catch (err) {
        // Dọn dest nếu ghi được 1 phần
        fs.promises.unlink(destPath).catch(() => {});
        if (err.name === 'AbortError') {
            dbg(`TIMEOUT after ${timeoutMs}ms host=${host}`);
            throw new DownloadError(`Timeout ${timeoutMs}ms khi tải URL`, 'TIMEOUT', err);
        }
        if (err instanceof DownloadError) {
            dbg(`FAIL ${err.code} host=${host} bytesRead=${bytesRead}: ${err.message}`);
            throw err;
        }
        dbg(`STREAM ERROR host=${host} bytesRead=${bytesRead}: ${err.message}`);
        throw new DownloadError(err.message, 'STREAM_ERROR', err);
    } finally {
        clearTimeout(timer);
    }
}

module.exports = { downloadToFile, DownloadError };
