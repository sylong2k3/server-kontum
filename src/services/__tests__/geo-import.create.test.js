'use strict';
jest.mock('../../configs/database', () => ({ pool: { connect: jest.fn() } }));
jest.mock('../../utils/ogr.util', () => ({}));
jest.mock('../../utils/geoserver.client', () => ({}));
jest.mock('../../configs/geoserver', () => ({ geoserverConfig: {} }));
jest.mock('fs', () => ({ unlinkSync: jest.fn() }));
jest.mock('../../repositories/map-layer.repository', () => ({
    findByCode: jest.fn(), physicalTableExists: jest.fn(), findByTableName: jest.fn(),
    createLayer: jest.fn(), upsertLayerByCode: jest.fn(), createImportJob: jest.fn(),
}));
const db = require('../../configs/database');
const repo = require('../../repositories/map-layer.repository');
const fs = require('fs');
const { enqueueImport } = require('../geo-import.service');
const { geoImportPayload } = require('../../validators/geo-import.validator');
const client = { query: jest.fn(), release: jest.fn() };
const file = { path: 'test-only.geojson', originalname: 'forest.geojson', size: Number.MAX_SAFE_INTEGER };
const makePayload = (extra = {}) => geoImportPayload.validate({ code: 'forest-2026', table_name: 'forest_2026', source_format: 'geojson', ...extra }).value;
beforeEach(() => {
    jest.resetAllMocks();
    db.pool.connect.mockResolvedValue(client);
    repo.findByCode.mockResolvedValue(null);
    repo.findByTableName.mockResolvedValue(null);
    repo.physicalTableExists.mockResolvedValue(false);
    repo.createLayer.mockResolvedValue({ id: 11 });
    repo.upsertLayerByCode.mockResolvedValue({ id: 12 });
    repo.createImportJob.mockResolvedValue({ id: 7 });
});
test('new-layer import inserts once and preserves shared form metadata', async () => {
    const payload = makePayload({ new_layer: true, is_active: false, auto_publish: false,
        default_style: { fillColor: '#008800' }, legend_config: { entries: [{ label: 'Forest', color: '#008800' }] } });
    const result = await enqueueImport({ file, payload, user: { id: 3 }, lang: 'vi' });
    expect(repo.createLayer).toHaveBeenCalledWith(client, expect.objectContaining({
        code: 'forest-2026', table_name: 'forest_2026', is_active: false,
        default_style: payload.default_style, legend_config: payload.legend_config, userId: 3,
    }));
    expect(repo.upsertLayerByCode).not.toHaveBeenCalled();
    expect(repo.findByTableName).toHaveBeenCalledWith('forest_2026', client);
    expect(client.query).toHaveBeenCalledWith('COMMIT');
    expect(result).toEqual({ job_id: 7, code: 'forest-2026', status: 'pending', sync: false });
});
test.each(['code', 'physical', 'registry'])('rejects existing %s without overwriting or scheduling work', async conflict => {
    if (conflict === 'code') repo.findByCode.mockResolvedValue({ id: 1 });
    if (conflict === 'physical') repo.physicalTableExists.mockResolvedValue(true);
    if (conflict === 'registry') repo.findByTableName.mockResolvedValue({ id: 1 });
    await expect(enqueueImport({ file, payload: makePayload({ new_layer: true }), lang: 'vi' })).rejects.toMatchObject({ status: 409, isOperational: true });
    expect(repo.createLayer).not.toHaveBeenCalled();
    expect(repo.upsertLayerByCode).not.toHaveBeenCalled();
    expect(repo.createImportJob).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(fs.unlinkSync).toHaveBeenCalledWith(file.path);
    expect(client.release).toHaveBeenCalled();
});
test('legacy import retains upsert behavior by default', async () => {
    await enqueueImport({ file, payload: makePayload(), lang: 'vi' });
    expect(repo.upsertLayerByCode).toHaveBeenCalled();
    expect(repo.createLayer).not.toHaveBeenCalled();
    expect(repo.findByCode).not.toHaveBeenCalled();
});
test('rolls back a failed job registration', async () => {
    repo.createImportJob.mockRejectedValue(new Error('unavailable'));
    await expect(enqueueImport({ file, payload: makePayload({ new_layer: true }), lang: 'vi' })).rejects.toThrow('unavailable');
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.query).not.toHaveBeenCalledWith('COMMIT');
    expect(client.release).toHaveBeenCalled();
});
