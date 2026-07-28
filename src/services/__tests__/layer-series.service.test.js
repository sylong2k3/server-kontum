'use strict';

jest.mock('../../configs/database', () => ({
    pool: { connect: jest.fn() },
    query: jest.fn(),
}));
jest.mock('../../repositories/layer-series.repository');
jest.mock('../../utils/geoserver.client', () => ({
    harvestGeoTiff: jest.fn(),
    publishTimeMosaic: jest.fn(),
    truncateGwcLayer: jest.fn(),
}));
jest.mock('../../configs/geoserver', () => ({
    geoserverConfig: {
        url: 'https://geo.example/geoserver',
        workspace: 'kontum',
    },
}));

const repo = require('../../repositories/layer-series.repository');
const service = require('../layer-series.service');

const GROUP = {
    id: 1,
    code: 'lop_phu',
    name_vi: 'Lớp phủ',
    name_en: 'Land cover',
    geoserver_store: 'lop_phu',
    geoserver_layer: 'kontum:lop_phu',
    geoserver_style: 'lop_phu_style',
    is_active: true,
    is_public: true,
};

const granule = (id, yearFrom, yearTo, time) => ({
    id,
    year_from: yearFrom,
    year_to: yearTo,
    time_value: time,
    label: yearFrom === yearTo ? String(yearFrom) : `${yearFrom}–${yearTo}`,
});

describe('layer-series.service timeline', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        delete process.env.GEOSERVER_PUBLIC_URL;
        repo.findGroupByCode.mockResolvedValue(GROUP);
    });

    test('trả mốc tăng dần, mặc định mốc cuối và tile URL Mapbox có TIME', async () => {
        repo.listGranules.mockResolvedValue([
            granule(1, 1991, 1991, '1991-04-02'),
            granule(2, 2014, 2014, '2014-04-26'),
            granule(3, 2023, 2023, '2023-05-05'),
        ]);

        const result = await service.getTimeline('lop_phu', null, 'vi');

        expect(result.mode).toBe('discrete');
        expect(result.snap).toBe('nearest');
        expect(result.default_index).toBe(2);
        expect(result.min_year).toBe(1991);
        expect(result.max_year).toBe(2023);
        expect(result.steps.map((step) => step.year_to)).toEqual([1991, 2014, 2023]);
        expect(result.steps[0].tile_url).toContain('time=1991-04-02');
        expect(result.steps[0].tile_url).toContain('bbox={bbox-epsg-3857}');
        expect(result.steps[0].tile_url).toContain('layers=kontum%3Alop_phu');
    });

    test('timeline rỗng trả default_index và biên năm null', async () => {
        repo.listGranules.mockResolvedValue([]);
        const result = await service.getTimeline('lop_phu', null, 'vi');
        expect(result).toMatchObject({ default_index: null, min_year: null, max_year: null, steps: [] });
    });

    test('TIME đại diện ổn định và khác nhau cho các khoảng cùng year_to', () => {
        const first = service.buildTimeValue(1991, 2023);
        const second = service.buildTimeValue(2014, 2023);
        expect(first).toMatch(/^2023-/);
        expect(second).toMatch(/^2023-/);
        expect(first).not.toBe(second);
    });
});
