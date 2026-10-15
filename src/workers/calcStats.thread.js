'use strict';

/**
 * Worker thread — tính thống kê band GeoTIFF.
 * Chạy trong thread riêng để không block event loop chính.
 * Nhận: { filePath: string } — đọc trực tiếp từ đĩa (geotiff.fromFile đọc theo
 * range/lazy, không cần nạp nguyên file vào RAM) để an toàn với file vài GB.
 * Trả: { stats: Array } hoặc { error: string }
 */

const { workerData, parentPort } = require('worker_threads');
const { rasterValidity } = require('../utils/raster-validity.util');

(async () => {
    try {
        const { fromFile } = await import('geotiff');

        const tiff      = await fromFile(workerData.filePath);
        const image     = await tiff.getImage();
        const bandCount = image.getSamplesPerPixel();
        const validityForBand = await rasterValidity(tiff, image, workerData.filePath);
        const stats     = [];
        const HISTOGRAM_BIN_COUNT = 64;

        const round4 = (value) => Math.round(value * 10000) / 10000;

        const buildHistogram = (data, min, max, validCount, isValid) => {
            if (!Number.isFinite(min) || !Number.isFinite(max)) { return { buckets: [], counts: [] }; }
            if (min === max) {
                // readRasters returns numeric typed arrays; the first pass already counted metadata-valid pixels.
                return { buckets: [round4(min)], counts: [validCount] };
            }

            const counts = Array(HISTOGRAM_BIN_COUNT).fill(0);
            const step   = (max - min) / HISTOGRAM_BIN_COUNT;

            for (let i = 0; i < data.length; i++) {
                const v = data[i];
                if (!isValid(v, i)) { continue; }
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
                const isValid = validityForBand(b - 1);

                let min = Infinity, max = -Infinity, sum = 0, sumSq = 0;
                let validCount = 0;
                const total = data.length;

                for (let i = 0; i < total; i++) {
                    const v = data[i];
                    if (!isValid(v, i)) { continue; }
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
                const histogram = buildHistogram(data, min, max, validCount, isValid);

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
                bandErr.code = bandErr.code || 'RASTER_STATISTICS_FAILED';
                throw bandErr;
            }
        }

        parentPort.postMessage({ stats });
    } catch (err) {
        parentPort.postMessage({ error: err.message, code: err.code || 'RASTER_STATISTICS_FAILED' });
    }
})();
