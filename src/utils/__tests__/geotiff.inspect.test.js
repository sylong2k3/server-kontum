'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
test('real GeoTIFF reader preserves projected EPSG and rejects missing georeferencing', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'geotiff-inspect-'));
    try {
        const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
            import { writeArrayBuffer } from 'geotiff';
            import fs from 'node:fs';
            import path from 'node:path';
            import { createRequire } from 'node:module';
            const require = createRequire(import.meta.url);
            const { inspectGeoTiffFile } = require('./src/utils/geotiff.util');
            const dir = process.argv[1];
            const valid = path.join(dir, 'valid.tif');
            fs.writeFileSync(valid, Buffer.from(writeArrayBuffer([1,2,3,4], { width:2, height:2, GTModelTypeGeoKey:1, ProjectedCSTypeGeoKey:32648, ModelPixelScale:[10,10,0], ModelTiepoint:[0,0,0,500000,1500000,0] })));
            const metadata = await inspectGeoTiffFile(valid);
            const invalid = path.join(dir, 'invalid.tif');
            fs.writeFileSync(invalid, Buffer.from(writeArrayBuffer([1,2,3,4], { width:2, height:2, GeographicTypeGeoKey:32767 })));
            let rejected = false;
            try { await inspectGeoTiffFile(invalid); } catch (e) { rejected = e.status === 400; }
            console.log(JSON.stringify({ metadata, rejected }));
        `, directory], { cwd: path.resolve(__dirname, '../../..'), encoding: 'utf8' });
        expect(JSON.parse(output.trim())).toEqual({ metadata: { epsgCode: 32648 }, rejected: true });
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('real reader reports safe, distinct coordinate diagnostics', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'geotiff-diagnostics-'));
    try {
        const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
            import { writeArrayBuffer } from 'geotiff';
            import fs from 'node:fs';
            import path from 'node:path';
            import { createRequire } from 'node:module';
            const require = createRequire(import.meta.url);
            const { inspectGeoTiffFile } = require('./src/utils/geotiff.util');
            const dir = process.argv[1];
            const cases = [
                { name: 'no-epsg', remove: [34735] },
                { name: 'no-transform', remove: [33550, 33922] },
                { name: 'no-georeference', remove: [34735, 33550, 33922] },
                { name: 'custom-crs', epsg: 32767 },
                { name: 'invalid-bounds', scale: [0, 10, 0] },
                { name: 'corrupt', corrupt: true },
            ];
            const results = [];
            for (const item of cases) {
                const bytes = Buffer.from(writeArrayBuffer([1, 2, 3, 4], {
                    width: 2, height: 2, GTModelTypeGeoKey: 1,
                    ProjectedCSTypeGeoKey: item.epsg || 32648,
                    ModelPixelScale: item.scale || [10, 10, 0],
                    ModelTiepoint: [0, 0, 0, 500000, 1500000, 0],
                }));
                const little = bytes[0] === 0x49;
                const u16 = (at) => little ? bytes.readUInt16LE(at) : bytes.readUInt16BE(at);
                const offset = little ? bytes.readUInt32LE(4) : bytes.readUInt32BE(4);
                const count = u16(offset);
                for (let n = 0; n < count; n++) {
                    const at = offset + 2 + n * 12;
                    if (item.remove?.includes(u16(at))) {
                        if (little) bytes.writeUInt16LE(65000 + n, at);
                        else bytes.writeUInt16BE(65000 + n, at);
                    }
                }
                const file = path.join(dir, item.name + '.tif');
                fs.writeFileSync(file, item.corrupt ? Buffer.from('not a TIFF') : bytes);
                try { await inspectGeoTiffFile(file); results.push({ name: item.name, accepted: true }); }
                catch (error) {
                    results.push({ name: item.name, status: error.status, errors: error.errors, diagnostics: error.geotiffDiagnostics });
                }
            }
            console.log(JSON.stringify(results));
        `, directory], { cwd: path.resolve(__dirname, '../../..'), encoding: 'utf8' });
        const results = JSON.parse(output.trim());
        expect(results.map((result) => result.diagnostics.reasons)).toEqual([
            ['MISSING_OR_INVALID_EPSG'],
            ['MISSING_OR_INVALID_GEOREFERENCE_TRANSFORM'],
            ['MISSING_OR_INVALID_EPSG', 'MISSING_OR_INVALID_GEOREFERENCE_TRANSFORM'],
            ['USER_DEFINED_CRS_WITHOUT_EPSG'],
            ['INVALID_GEOREFERENCE_BOUNDS'],
            ['GEOTIFF_METADATA_READ_FAILED'],
        ]);
        for (const result of results) {
            expect(result.status).toBe(400);
            expect(result.errors).toEqual(['INVALID_GEOTIFF_GEOREFERENCE']);
        }
        expect(output).not.toContain(directory);
        expect(results[0].diagnostics).toMatchObject({ width: 2, height: 2, epsgCode: null });
        expect(results[1].diagnostics.epsgCode).toBe(32648);
        expect(results[5].diagnostics.stage).toBe('read_metadata');
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
