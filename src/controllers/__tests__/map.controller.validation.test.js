'use strict';

jest.mock('../../services/map.service', () => ({ createLayer: jest.fn(), updateLayer: jest.fn() }));
jest.mock('../../services/geo-import.service', () => ({ enqueueImport: jest.fn() }));
jest.mock('../../utils/geoserver.client', () => ({}));

const express = require('express');
const request = require('supertest');
const fs = require('fs');
const controller = require('../map.controller');
const mapService = require('../../services/map.service');
const geoImportService = require('../../services/geo-import.service');
const asyncHandler = require('../../helpers/async-handler');
const { errorHandler } = require('../../middlewares/error-handler');

const payload = {
    code: 'bien_dong_lop_phu_kon_tum_1991-2023_tesst',
    name_vi: 'Biến động lớp phủ Kon Tum 1991-2023 tesst',
    table_name: 'bien_dong_lop_phu_kon_tum_1991-2023_tesst',
    schema_name: 'gis', category: 'other', layer_kind: 'overlay', layer_group: null,
    geometry_type: 'RASTER', epsg_code: 4326, is_active: true,
    is_public: false, is_editable: true, default_style: null, legend_config: null,
};

const app = express();
app.use(express.json());
app.use((req, res, next) => { req.lang = 'vi'; next(); });
app.post('/api/v1/map/layers', asyncHandler(controller.createLayer));
app.post('/api/v1/map/layers/import-file', (req, res, next) => {
    req.geoFile = { path: 'test-only.geojson' };
    next();
}, asyncHandler(controller.importGeoFile));
app.patch('/api/v1/map/layers/:code', asyncHandler(controller.updateLayer));
app.use(errorHandler);

describe('map controller validation in production', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    beforeEach(() => {
        process.env.NODE_ENV = 'production';
        jest.clearAllMocks();
        jest.spyOn(fs, 'unlinkSync').mockImplementation(() => {});
    });
    afterEach(() => jest.restoreAllMocks());
    afterAll(() => {
        if (originalNodeEnv === undefined) { delete process.env.NODE_ENV; }
        else { process.env.NODE_ENV = originalNodeEnv; }
    });

    test('returns the invalid table_name detail instead of INTERNAL_ERROR', async () => {
        const response = await request(app).post('/api/v1/map/layers?lang=vi').send(payload);
        expect(response.status).toBe(400);
        expect(response.body).toEqual({
            success: false,
            message: 'Dữ liệu không hợp lệ',
            errors: [expect.stringContaining('"table_name"')],
        });
        expect(mapService.createLayer).not.toHaveBeenCalled();
    });

    test('accepts a hyphenated code with an underscore-only table_name', async () => {
        const corrected = { ...payload, table_name: payload.table_name.replace(/-/g, '_') };
        mapService.createLayer.mockResolvedValue({ id: 1, ...corrected });
        const response = await request(app).post('/api/v1/map/layers?lang=vi').send(corrected);
        expect(response.status).toBe(201);
        expect(mapService.createLayer).toHaveBeenCalledWith(
            expect.objectContaining(corrected), undefined, 'vi'
        );
    });

    test('parses shared form metadata and multipart booleans before enqueueing', async () => {
        geoImportService.enqueueImport.mockResolvedValue({ job_id: '7', code: 'forest-2026', status: 'pending', sync: false });
        const response = await request(app).post('/api/v1/map/layers/import-file').send({
            code: 'forest-2026', table_name: 'forest_2026', source_format: 'geojson', new_layer: 'true',
            is_active: 'false', default_style: '{"fillColor":"#008800"}', legend_config: 'null',
        });
        expect(response.status).toBe(202);
        expect(response.body.data.job_id).toBe('7');
        expect(geoImportService.enqueueImport).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({
            new_layer: true, is_active: false, default_style: { fillColor: '#008800' }, legend_config: null,
        }) }));
    });

    test('rejects malformed JSON metadata before creating any job', async () => {
        const response = await request(app).post('/api/v1/map/layers/import-file').send({
            code: 'forest', source_format: 'geojson', default_style: '{',
        });
        expect(response.status).toBe(400);
        expect(response.body.errors).toEqual(['default_style: invalid JSON']);
        expect(geoImportService.enqueueImport).not.toHaveBeenCalled();
        expect(fs.unlinkSync).toHaveBeenCalledWith('test-only.geojson');
    });

    test('also preserves update validation errors without exposing a production stack', async () => {
        const response = await request(app).patch('/api/v1/map/layers/test').send({ table_name: 'bad-table' });
        expect(response.status).toBe(400);
        expect(response.body.errors).toEqual([expect.stringContaining('"table_name"')]);
        expect(response.body.message).toBe('Dữ liệu không hợp lệ');
        expect(response.body.stack).toBeUndefined();
        expect(mapService.updateLayer).not.toHaveBeenCalled();
    });
});
