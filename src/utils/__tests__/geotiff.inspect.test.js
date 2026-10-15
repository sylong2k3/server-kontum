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
