'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fileURLToPath } = require('url');
jest.mock('../../configs/database', () => ({ pool: { connect: jest.fn() } }));
jest.mock('../../repositories/map-layer.repository', () => ({ findByCode: jest.fn(), createLayer: jest.fn(), insertEditHistory: jest.fn() }));
jest.mock('../../utils/geoserver.client', () => ({ publishRasterLayer: jest.fn() }));
jest.mock('../../utils/geotiff.util', () => ({ ...jest.requireActual('../../utils/geotiff.util'), inspectGeoTiffFile: jest.fn() }));
const db = require('../../configs/database');
const repo = require('../../repositories/map-layer.repository');
const geoserver = require('../../utils/geoserver.client');
const { inspectGeoTiffFile } = require('../../utils/geotiff.util');
const service = require('../map.service');
let directory, input, client;
const originalDirectory = process.env.GEOSERVER_DATA_DIR;
const payload = { code: 'forest-2026', table_name: 'forest_2026', geometry_type: 'RASTER', epsg_code: 4326, is_public: false };
beforeEach(() => {
    jest.clearAllMocks();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kontum-raster-test-'));
    input = path.join(directory, 'upload.tif');
    fs.writeFileSync(input, Buffer.from([0x49, 0x49, 0x2a, 0, 0, 0, 0, 0]));
    process.env.GEOSERVER_DATA_DIR = path.join(directory, 'persistent');
    client = { query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() };
    db.pool.connect.mockResolvedValue(client);
    repo.findByCode.mockResolvedValue(null);
    repo.createLayer.mockImplementation(async (_client, data) => ({ id: 1, ...data }));
    inspectGeoTiffFile.mockResolvedValue({ epsgCode: 32648 });
});
afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
    if (originalDirectory === undefined) delete process.env.GEOSERVER_DATA_DIR;
    else process.env.GEOSERVER_DATA_DIR = originalDirectory;
});
test('persists bytes, assigns source and native CRS, without publication', async () => {
    const result = await service.createRasterLayer({ ...payload, source_url: '/untrusted', geoserver_layer: 'fake' }, { path: input }, { id: 7 }, 'vi');
    expect(result.epsg_code).toBe(32648);
    expect(result.is_editable).toBe(false);
    expect(result.geoserver_layer).toBeNull();
    expect(fs.readFileSync(fileURLToPath(result.source_url))).toEqual(fs.readFileSync(input));
    expect(inspectGeoTiffFile).toHaveBeenCalledWith(input, 'vi');
    expect(client.query).toHaveBeenCalledWith('COMMIT');
    expect(geoserver.publishRasterLayer).not.toHaveBeenCalled();
});
test('removes only its newly persisted file on duplicate code', async () => {
    fs.mkdirSync(process.env.GEOSERVER_DATA_DIR);
    const existing = path.join(process.env.GEOSERVER_DATA_DIR, 'existing.tif');
    fs.writeFileSync(existing, 'user-data');
    repo.findByCode.mockResolvedValue({ id: 9 });
    await expect(service.createRasterLayer(payload, { path: input }, { id: 7 }, 'vi')).rejects.toMatchObject({ status: 409 });
    expect(fs.readdirSync(process.env.GEOSERVER_DATA_DIR)).toEqual(['existing.tif']);
    expect(fs.readFileSync(existing, 'utf8')).toBe('user-data');
    expect(repo.createLayer).not.toHaveBeenCalled();
});
test('cleans its persistent file when the database fails', async () => {
    repo.createLayer.mockRejectedValue(new Error('db unavailable'));
    await expect(service.createRasterLayer(payload, { path: input }, {}, 'vi')).rejects.toThrow('db unavailable');
    expect(fs.readdirSync(process.env.GEOSERVER_DATA_DIR)).toEqual([]);
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
});
test('rejects missing storage configuration before DB creation', async () => {
    delete process.env.GEOSERVER_DATA_DIR;
    await expect(service.createRasterLayer(payload, { path: input }, {}, 'vi')).rejects.toMatchObject({ status: 400 });
    expect(db.pool.connect).not.toHaveBeenCalled();
});
test('rejects a disguised TIFF before DB creation', async () => {
    fs.writeFileSync(input, 'not a TIFF');
    await expect(service.createRasterLayer(payload, { path: input }, {}, 'vi')).rejects.toMatchObject({ status: 400 });
    expect(inspectGeoTiffFile).not.toHaveBeenCalled();
    expect(db.pool.connect).not.toHaveBeenCalled();
});
test('rejects missing georeferencing without persisting a source', async () => {
    inspectGeoTiffFile.mockRejectedValue(new Error('invalid georeferencing'));
    await expect(service.createRasterLayer(payload, { path: input }, {}, 'vi')).rejects.toThrow('invalid georeferencing');
    expect(fs.existsSync(process.env.GEOSERVER_DATA_DIR)).toBe(false);
    expect(db.pool.connect).not.toHaveBeenCalled();
});
