'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { Worker } = require('worker_threads');
const workerPath = path.resolve(__dirname, '../calcStats.thread.js');
const cases = [
    ['zero', [0, 0, 0, 0], 0, 0, 0, 4],
    ['constant', [7, 7, 7, 7], 7, 7, 7, 4],
    ['negative', [-2, -2, -2, -2], -2, -2, -2, 4],
    ['masked-constant', [5, 'NaN', 'Infinity', 5], 5, 5, 5, 2],
    ['invalid', ['NaN', 'Infinity', '-Infinity', 'NaN'], null, null, null, 0],
    ['varying', [0, 10, 20, 30], 0, 30, 15, 4],
    ['negative-index', [-1, 0, 0.5, 1], -1, 1, 0.125, 4],
    ['decimal-constant', [0.3, 0.3, 'NaN', 0.3], 0.3, 0.3, 0.3, 3],
];
let fixtureDir;
beforeAll(() => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'geoai-stats-test-'));
    // Use Node's ESM loader for the installed TIFF writer, not Jest's VM.
    const generator = `
        const fs = require('fs'); const path = require('path');
        import('geotiff').then(({ writeArrayBuffer }) => {
            const fixtures = ${JSON.stringify(cases)};
            for (const [name, values] of fixtures) {
                const buffer = writeArrayBuffer(new Float64Array(values.map(Number)), {
                    width: 2, height: 2, GeographicTypeGeoKey: 4326,
                    ModelPixelScale: [1, 1, 0], ModelTiepoint: [0, 0, 0, 107, 15, 0],
                });
                fs.writeFileSync(path.join(process.argv[1], name + '.tif'), Buffer.from(buffer));
            }
        }).catch(error => { console.error(error); process.exitCode = 1; });
    `;
    const generated = spawnSync(process.execPath, ['-e', generator, fixtureDir], {
        cwd: path.resolve(__dirname, '../../..'), encoding: 'utf8', timeout: 15000,
    });
    if (generated.error || generated.status !== 0) throw generated.error || new Error(generated.stderr);
});
afterAll(() => {
    if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
});
function runWorker(filePath) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(workerPath, { workerData: { filePath } });
        const timeout = setTimeout(() => {
            worker.terminate(); reject(new Error('Local statistics worker timeout'));
        }, 10000);
        worker.once('message', message => { clearTimeout(timeout); resolve(message); });
        worker.once('error', error => { clearTimeout(timeout); reject(error); });
        worker.once('exit', code => {
            clearTimeout(timeout);
            if (code !== 0) reject(new Error(`Worker exited with code ${code}`));
        });
    });
}
describe('GeoTIFF statistics worker histogram equivalence', () => {
    test.each(cases)('%s retains statistics and histogram counts', async (name, values, min, max, mean, count) => {
        const result = await runWorker(path.join(fixtureDir, `${name}.tif`));
        expect(result.error).toBeUndefined();
        expect(result.stats).toHaveLength(1);
        const band = result.stats[0];
        expect(band).toMatchObject({ band_index: 1, min, max, mean, valid_pixels: count, total_pixels: values.length });
        if (count === 0) {
            expect(band.std).toBeNull(); expect(band.histogram).toBeUndefined();
        } else if (min === max) {
            expect(band.std).toBe(0);
            expect(band.histogram).toEqual({ buckets: [min], counts: [count] });
        } else {
            expect(band.histogram.buckets).toHaveLength(64);
            expect(band.histogram.counts.reduce((sum, n) => sum + n, 0)).toBe(count);
        }
    });
    test('missing file remains an error rather than successful empty statistics', async () => {
        const result = await runWorker(path.join(fixtureDir, 'absent.tif'));
        expect(typeof result.error).toBe('string'); expect(result.stats).toBeUndefined();
    });
});
