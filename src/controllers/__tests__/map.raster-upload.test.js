'use strict';
jest.mock('../../services/map.service', () => ({ createLayer: jest.fn(), createRasterLayer: jest.fn() }));
jest.mock('../../services/geo-import.service', () => ({}));
jest.mock('../../utils/geoserver.client', () => ({}));
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const request = require('supertest');
const controller = require('../map.controller');
const service = require('../../services/map.service');
const { uploadLayerRaster } = require('../../middlewares/uploadRaster.middleware');
const asyncHandler = require('../../helpers/async-handler');
const { errorHandler } = require('../../middlewares/error-handler');
const { Api400Error } = require('../../core/error.response');
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.lang = 'vi'; req.user = { id: 7 }; next(); });
app.post('/layers', uploadLayerRaster, asyncHandler(controller.createLayer));
app.use(errorHandler);
let directory;
const previous = process.env.GEO_UPLOAD_TEMP_DIR;
beforeEach(() => {
    jest.clearAllMocks();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'raster-http-test-'));
    process.env.GEO_UPLOAD_TEMP_DIR = directory;
    service.createRasterLayer.mockResolvedValue({ id: 1, source_url: 'file:///data/test.tif', geometry_type: 'RASTER' });
});
afterEach(() => {
    expect(fs.readdirSync(directory)).toEqual([]);
    fs.rmSync(directory, { recursive: true, force: true });
    if (previous === undefined) delete process.env.GEO_UPLOAD_TEMP_DIR;
    else process.env.GEO_UPLOAD_TEMP_DIR = previous;
});
const upload = () => request(app).post('/layers').field('code', 'forest-2026').field('table_name', 'forest_2026')
    .field('name_vi', 'Rừng Kon Tum').field('geometry_type', 'RASTER').field('is_public', 'false');
test('multipart bytes and parsed metadata reach the raster service; temp file is removed', async () => {
    const bytes = Buffer.from([0x49, 0x49, 0x2a, 0, 0, 0, 0, 0]);
    service.createRasterLayer.mockImplementation(async (payload, file) => {
        expect(fs.readFileSync(file.path)).toEqual(bytes);
        expect(payload.default_style).toEqual({ rasterOpacity: 0.6 });
        expect(payload.is_public).toBe(false);
        return { id: 1, ...payload, source_url: 'file:///data/test.tif' };
    });
    const response = await upload().field('default_style', '{"rasterOpacity":0.6}').field('legend_config', 'null').attach('raster_file', bytes, 'test.tif');
    expect(response.status).toBe(201);
    expect(response.body.data.source_url).toBe('file:///data/test.tif');
    expect(service.createLayer).not.toHaveBeenCalled();
});
test('cleans temporary upload when metadata is rejected', async () => {
    const response = await upload().field('default_style', '{').attach('raster_file', Buffer.from('TIFF'), 'test.tif');
    expect(response.status).toBe(400);
    expect(service.createRasterLayer).not.toHaveBeenCalled();
});
test('cleans temporary upload on service failure', async () => {
    service.createRasterLayer.mockRejectedValue(new Api400Error('Invalid GeoTIFF', ['NOT_GEOTIFF']));
    const response = await upload().attach('raster_file', Buffer.from('TIFF'), 'test.tif');
    expect(response.status).toBe(400);
});
test('requires raster_file for multipart and rejects wrong extension', async () => {
    expect((await upload()).status).toBe(400);
    expect((await upload().attach('raster_file', Buffer.from('x'), 'test.geojson')).status).toBe(400);
    expect(service.createRasterLayer).not.toHaveBeenCalled();
});
test('JSON metadata creation stays backward compatible', async () => {
    service.createLayer.mockResolvedValue({ id: 2 });
    const response = await request(app).post('/layers').send({ code: 'raster', name_vi: 'Raster', table_name: 'raster', geometry_type: 'RASTER' });
    expect(response.status).toBe(201);
    expect(service.createLayer).toHaveBeenCalled();
    expect(service.createRasterLayer).not.toHaveBeenCalled();
});
