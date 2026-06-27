'use strict';

/**
 * Worker thread — tính thống kê band GeoTIFF.
 * Chạy trong thread riêng để không block event loop chính.
 * Nhận: { bufferData: ArrayBuffer }
 * Trả: { stats: Array } hoặc { error: string }
 */

const { workerData, parentPort } = require('worker_threads');

(async () => {
    try {
        const { fromArrayBuffer } = await import('geotiff');

        const tiff      = await fromArrayBuffer(workerData.bufferData);
        const image     = await tiff.getImage();
        const bandCount = image.getSamplesPerPixel();
        const stats     = [];

        for (let b = 1; b <= bandCount; b++) {
            try {
                const rasters = await image.readRasters({ samples: [b - 1] });
                const data    = rasters[0];

                let min = Infinity, max = -Infinity, sum = 0, sumSq = 0;
                let validCount = 0;
                const total = data.length;

                for (let i = 0; i < total; i++) {
                    const v = data[i];
                    if (v === null || v === undefined || isNaN(v) || !isFinite(v)) { continue; }
                    if (min > v) { min = v; }
                    if (max < v) { max = v; }
                    sum   += v;
                    sumSq += v * v;
                    validCount++;
                }

                if (validCount === 0) {
                    stats.push({ band_index: b, min: null, max: null, mean: null, std: null, valid_pixels: 0, total_pixels: total });
                    continue;
                }

                const mean = sum / validCount;
                const std  = Math.sqrt(Math.abs(sumSq / validCount - mean * mean));

                stats.push({
                    band_index:   b,
                    min:          Math.round(min  * 10000) / 10000,
                    max:          Math.round(max  * 10000) / 10000,
                    mean:         Math.round(mean * 10000) / 10000,
                    std:          Math.round(std  * 10000) / 10000,
                    valid_pixels: validCount,
                    total_pixels: total,
                });
            } catch (bandErr) {
                console.warn(`[calcStats.thread] Band ${b} error:`, bandErr.message);
            }
        }

        parentPort.postMessage({ stats });
    } catch (err) {
        parentPort.postMessage({ error: err.message });
    }
})();
