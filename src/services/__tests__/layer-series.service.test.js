'use strict';

jest.mock('../../repositories/layer-series.repository');
jest.mock('../../configs/geoserver', () => ({
    geoserverConfig: { url: 'https://geo.example/geoserver', workspace: 'kontum' },
}));

const repo = require('../../repositories/layer-series.repository');
const service = require('../layer-series.service');

const layer = (id, code, year, group = 'lop_phu') => ({
    id,
    code,
    name_vi: code,
    geoserver_layer: `kontum:${code}`,
    default_style: {},
    data_year: year,
    layer_group: group,
});

describe('layer-series.service — timeline từ WMS layer rời', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        delete process.env.GEOSERVER_PUBLIC_URL;
    });

    test('trả layer theo năm, tile URL không dùng TIME/ImageMosaic', async () => {
        repo.listSourceLayers.mockResolvedValue([
            layer(1, 'lop_phu_1991', 1991),
            layer(2, 'lop_phu_2014', 2014),
            layer(3, 'lop_phu_2023', 2023),
        ]);

        const result = await service.getTimeline('lop_phu', null, 'vi');

        expect(result).toMatchObject({ mode: 'discrete', default_index: 2, min_year: 1991, max_year: 2023 });
        expect(result.steps.map((step) => step.label)).toEqual(['1991', '2014', '2023']);
        expect(result.steps[0].geoserver_layer).toBe('kontum:lop_phu_1991');
        expect(result.steps[0].tile_url).toContain('layers=kontum%3Alop_phu_1991');
        expect(result.steps[0].tile_url).toContain('bbox={bbox-epsg-3857}');
        expect(result.steps[0].tile_url).not.toContain('time=');
    });

    test('đọc đúng khoảng năm từ code layer biến động', () => {
        expect(service.periodOf(layer(1, 'biendonglopphu_1991_2023', 2023)))
            .toEqual({ yearFrom: 1991, yearTo: 2023 });
    });

    test('timeline rỗng trả biên null', async () => {
        repo.listSourceLayers.mockResolvedValue([]);
        await expect(service.getTimeline('lop_phu', null, 'vi')).resolves.toMatchObject({
            default_index: null, min_year: null, max_year: null, steps: [],
        });
    });

    test('alias bien_dong_nhiet_do được dùng cho dien_bien_nhiet_do', async () => {
        repo.listSourceLayers.mockResolvedValue([]);
        await service.getTimeline('dien_bien_nhiet_do', null, 'vi');
        expect(repo.listSourceLayers).toHaveBeenCalledWith({
            sourceGroups: ['dien_bien_nhiet_do', 'bien_dong_nhiet_do'],
            includePrivate: false,
        });
    });
});
