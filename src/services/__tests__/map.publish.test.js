'use strict';
jest.mock('../../configs/database', () => ({ pool: { connect: jest.fn() } }));
jest.mock('../../repositories/map-layer.repository', () => ({ findByCode: jest.fn(), physicalTableExists: jest.fn(), markPublished: jest.fn(), insertEditHistory: jest.fn() }));
jest.mock('../../utils/geoserver.client', () => ({ publishRasterLayer: jest.fn(), publishVectorLayer: jest.fn() }));
jest.mock('../../configs/geoserver', () => ({ geoserverConfig: { datastore: 'test' } }));
const db = require('../../configs/database');
const repo = require('../../repositories/map-layer.repository');
const geoserver = require('../../utils/geoserver.client');
const { publishLayer } = require('../map.service');
const base = { id: 1, code: 'raster_test', geometry_type: 'RASTER', is_active: true, table_name: 'raster_test' };
beforeEach(() => jest.resetAllMocks());
test.each([null, undefined, '', '  '])('missing raster source %s returns an actionable 400 before GeoServer', async source_url => {
    repo.findByCode.mockResolvedValue({ ...base, source_url });
    await expect(publishLayer(base.code, { id: 1 }, 'vi')).rejects.toMatchObject({
        status: 400, errors: ['RASTER_SOURCE_REQUIRED'], message: expect.stringContaining('GeoTIFF'),
    });
    expect(geoserver.publishRasterLayer).not.toHaveBeenCalled();
    expect(db.pool.connect).not.toHaveBeenCalled();
});
test('a configured raster continues through existing publishing flow', async () => {
    const layer = { ...base, source_url: 'file:data/forest.tif' };
    repo.findByCode.mockResolvedValue(layer);
    geoserver.publishRasterLayer.mockResolvedValue('kt:raster_test');
    repo.markPublished.mockResolvedValue(layer);
    const client = { query: jest.fn(), release: jest.fn() };
    db.pool.connect.mockResolvedValue(client);
    await expect(publishLayer(base.code, { id: 1 }, 'vi')).resolves.toEqual(layer);
    expect(geoserver.publishRasterLayer).toHaveBeenCalledWith(layer);
    expect(client.query).toHaveBeenCalledWith('COMMIT');
});
