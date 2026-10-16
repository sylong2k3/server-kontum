'use strict';
const express = require('express');
const request = require('supertest');
const { Api400Error } = require('../../core/error.response');
const { errorHandler } = require('../error-handler');

let log;
beforeEach(() => { log = jest.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { jest.restoreAllMocks(); });

const makeApp = (error) => {
    const app = express();
    app.post('/api/v1/map/layers', (_req, _res, next) => next(error));
    app.use(errorHandler);
    return app;
};

test('logs coordinate diagnostics once without request secrets or adding them to the response', async () => {
    const error = new Api400Error('Invalid GeoTIFF georeference', ['INVALID_GEOTIFF_GEOREFERENCE']);
    error.geotiffDiagnostics = {
        stage: 'validate_georeference', width: 4959, height: 7016, epsgCode: null,
        reasons: ['MISSING_OR_INVALID_EPSG', 'MISSING_OR_INVALID_GEOREFERENCE_TRANSFORM'],
    };
    const response = await request(makeApp(error)).post('/api/v1/map/layers?token=secret-query')
        .set('Authorization', 'Bearer secret-token').send({ raster_file: 'private-file-path' });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
        success: false, message: error.message, errors: ['INVALID_GEOTIFF_GEOREFERENCE'],
    });
    expect(response.body).not.toHaveProperty('geotiffDiagnostics');
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('[ERROR]', {
        event: 'GEOTIFF_GEOREFERENCE_REJECTED', method: 'POST', url: '/api/v1/map/layers',
        status: 400, message: error.message, errors: error.errors, geotiff: error.geotiffDiagnostics,
    });
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/secret-query|secret-token|private-file-path/);
});

test('unrelated operational errors keep existing response and logging behavior', async () => {
    const error = new Api400Error('Invalid data', ['OTHER_ERROR']);
    const response = await request(makeApp(error)).post('/api/v1/map/layers');
    expect(response.status).toBe(400);
    expect(response.body.errors).toEqual(['OTHER_ERROR']);
    expect(log).not.toHaveBeenCalled();
});
