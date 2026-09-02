'use strict';

/**
 * Worker thread — tính thống kê band GeoTIFF.
 * Chạy trong thread riêng để không block event loop chính.
 * Nhận: { filePath: string } — đọc trực tiếp từ đĩa (geotiff.fromFile đọc theo
 * range/lazy, không cần nạp nguyên file vào RAM) để an toàn với file vài GB.
 * Trả: { stats: Array } hoặc { error: string }
 */

const { workerData, parentPort } = require('worker_threads');

(async () => {
    try {
        const { fromFile } = await import('geotiff');

        const tiff      = await fromFile(workerData.filePath);
        const image     = await tiff.getImage();
        const bandCount = image.getSamplesPerPixel();
        const stats     = [];
        const HISTOGRAM_BIN_COUNT = 64;

        const round4 = (value) => Math.round(value * 10000) / 10000;

        const buildHistogram = (data, min, max) => {
            if (!Number.isFinite(min) || !Number.isFinite(max)) { return { buckets: [], counts: [] }; }
            if (min === max) {
                let count = 0;
                for (let i = 0; i < data.length; i++) {
                    const v = data[i];
                    if (v !== null && v !== undefined && !Number.isNaN(v) && Number.isFinite(v)) { count++; }
                }
                return { buckets: [round4(min)], counts: [count] };
            }

            const counts = Array(HISTOGRAM_BIN_COUNT).fill(0);
            const step   = (max - min) / HISTOGRAM_BIN_COUNT;

            for (let i = 0; i < data.length; i++) {
                const v = data[i];
                if (v === null || v === undefined || Number.isNaN(v) || !Number.isFinite(v)) { continue; }
                const idx = Math.min(HISTOGRAM_BIN_COUNT - 1, Math.floor((v - min) / step));
                counts[idx]++;
            }

            return {
                buckets: Array.from({ length: HISTOGRAM_BIN_COUNT }, (_, i) => round4(min + step * i)),
                counts,
            };
        };

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

                const mean      = sum / validCount;
                const std       = Math.sqrt(Math.abs(sumSq / validCount - mean * mean));
                const histogram = buildHistogram(data, min, max);

                stats.push({
                    band_index:   b,
                    min:          round4(min),
                    max:          round4(max),
                    mean:         round4(mean),
                    std:          round4(std),
                    valid_pixels: validCount,
                    total_pixels: total,
                    histogram,
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
