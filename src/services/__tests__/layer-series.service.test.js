'use strict';

jest.mock('../../configs/database', () => ({
    pool: { connect: jest.fn() },
    query: jest.fn(),
    getClient: jest.fn(),
}));
jest.mock('../../repositories/layer-series.repository');

const repo = require('../../repositories/layer-series.repository');
const service = require('../layer-series.service');

describe('Layer Series Service - Legend Aggregation', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('aggregates and deduplicates legends across multiple raster time steps', async () => {
        repo.findGroupByCode.mockResolvedValue({
            code: 'lop_phu',
            name_vi: 'Lớp phủ',
            name_en: 'Land Cover',
            geoserver_layer: 'kt:lop_phu',
            geoserver_style: 'raster_lop_phu',
            is_active: true,
            is_public: true,
        });

        // 3 child layers with overlapping/duplicate legend items
        repo.listSourceLayers.mockResolvedValue([
            {
                id: 1,
                code: 'lop_phu_1991',
                data_year: 1991,
                geoserver_layer: 'kt:lop_phu_1991',
                sort_order: 0,
                legend_config: {
                    type: 'custom',
                    entries: [
                        { label: 'Mặt nước', color: '#0086FF', value: 1 },
                        { label: 'Dân cư đô thị', color: '#FF9393', value: 2 },
                    ],
                },
            },
            {
                id: 2,
                code: 'lop_phu_2014',
                data_year: 2014,
                geoserver_layer: 'kt:lop_phu_2014',
                sort_order: 1,
                legend_config: JSON.stringify({
                    type: 'custom',
                    entries: [
                        { label: 'Mặt nước', color: '#0086FF' }, // duplicate
                        { label: 'Rừng tự nhiên', color: '#006000', value: 3 },
                    ],
                }),
            },
            {
                id: 3,
                code: 'lop_phu_2023',
                data_year: 2023,
                geoserver_layer: 'kt:lop_phu_2023',
                sort_order: 2,
                legend_config: null, // no legend config
            },
        ]);

        const result = await service.getTimeline('lop_phu', null, 'vi');

        expect(result.group.code).toBe('lop_phu');
        expect(result.steps).toHaveLength(3);
        expect(result.legend).toBeDefined();
        expect(result.legend.type).toBe('custom');
        expect(result.legend.entries).toHaveLength(3);
        expect(result.legend.entries).toEqual([
            { label: 'Mặt nước', color: '#0086FF', value: 1 },
            { label: 'Dân cư đô thị', color: '#FF9393', value: 2 },
            { label: 'Rừng tự nhiên', color: '#006000', value: 3 },
        ]);
        expect(result.group.legend).toEqual(result.legend);
    });

    it('returns null legend when no child layer has legend_config', async () => {
        repo.findGroupByCode.mockResolvedValue({
            code: 'nhiet_do',
            name_vi: 'Nhiệt độ',
            is_active: true,
            is_public: true,
        });

        repo.listSourceLayers.mockResolvedValue([
            {
                id: 10,
                code: 'nhiet_do_2020',
                data_year: 2020,
                geoserver_layer: 'kt:nhiet_do_2020',
                legend_config: null,
            },
        ]);

        const result = await service.getTimeline('nhiet_do', null, 'vi');
        expect(result.legend).toBeNull();
        expect(result.group.legend).toBeNull();
    });
});
