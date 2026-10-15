'use strict';

jest.mock('uuid', () => ({ v4: () => 'mock-uuid-1234' }));
jest.mock('../../repositories/remote-sensing.repository');
jest.mock('../../repositories/map-layer.repository', () => ({}));
jest.mock('../minio.service', () => ({}));
jest.mock('../../utils/geoserver.client', () => ({}));

const repo = require('../../repositories/remote-sensing.repository');
const svc  = require('../remote-sensing.service');
const { Api404Error, Api403Error, Api409Error } = require('../../core/error.response');

describe('Remote Sensing getStatistics lifecycle & gating', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('non-existent image throws Api404Error', async () => {
        repo.findImageById.mockResolvedValue(null);

        await expect(svc.getStatistics(999, { id: 1 }, 'vi'))
            .rejects.toThrow(Api404Error);
    });

    test('private image without authenticated user throws Api403Error', async () => {
        repo.findImageById.mockResolvedValue({
            id: 1,
            is_public: false,
            status: 'completed',
        });

        await expect(svc.getStatistics(1, null, 'vi'))
            .rejects.toThrow(Api403Error);
    });

    test('failed image throws Api409Error and never returns partial statistics', async () => {
        repo.findImageById.mockResolvedValue({
            id: 2,
            is_public: true,
            status: 'failed',
        });
        repo.findStatsByImageId.mockResolvedValue([
            { band_index: 1, min: 0, max: 100, mean: 50, std: 10 }
        ]);

        await expect(svc.getStatistics(2, null, 'vi'))
            .rejects.toThrow(Api409Error);
        expect(repo.findStatsByImageId).not.toHaveBeenCalled();
    });

    test('pending or processing image throws Api409Error rather than premature empty statistics', async () => {
        repo.findImageById.mockResolvedValue({
            id: 3,
            is_public: true,
            status: 'processing',
        });

        await expect(svc.getStatistics(3, null, 'vi'))
            .rejects.toThrow(Api409Error);
        expect(repo.findStatsByImageId).not.toHaveBeenCalled();
    });

    test('completed image returns full statistics and chart histograms', async () => {
        repo.findImageById.mockResolvedValue({
            id: 4,
            name: 'Landsat_KonTum_2025.tif',
            image_type: 'rgb',
            is_public: true,
            status: 'completed',
        });
        repo.findStatsByImageId.mockResolvedValue([
            {
                band_index: 1,
                band_name: 'Red',
                min_value: 0,
                max_value: 255,
                mean_value: 120.5,
                std_value: 30.2,
                histogram: { buckets: [0, 128, 255], counts: [10, 50, 20] }
            }
        ]);

        const result = await svc.getStatistics(4, null, 'vi');
        expect(result.image).toEqual({
            id: 4,
            name: 'Landsat_KonTum_2025.tif',
            imageType: 'rgb',
        });
        expect(result.statistics).toHaveLength(1);
        expect(result.charts.histograms).toHaveLength(1);
        expect(result.charts.histograms[0]).toMatchObject({
            bandIndex: 1,
            bandName: 'Red',
            values: [10, 50, 20],
        });
    });
});
