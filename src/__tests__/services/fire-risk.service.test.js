'use strict';

/**
 * Tests for fire-risk.service.js
 *
 * All EE, DB, and GEE export calls are mocked.
 */

// ── EE mock ───────────────────────────────────────────────────────────────────

const makeImgChain = () => {
    const img = {};
    const methods = [
        'select','multiply','add','subtract','clamp','toFloat','copyProperties','updateMask',
        'rename','clip','addBands','unmask','mask','toByte','toInt16','normalizedDifference',
        'median','mean','expression','where','byte','gt','gte','lt','lte','and','or','not',
        'bitwiseAnd','neq','eq','abs','reduceRegion','reduceRegions',
    ];
    methods.forEach((m) => { img[m] = jest.fn(() => img); });
    img.evaluate = jest.fn((cb) => cb({}, null));
    img.geometry  = jest.fn(() => ({ type: 'Geometry' }));
    return img;
};

const makeCollection = () => ({
    filterBounds: jest.fn().mockReturnThis(),
    filterDate:   jest.fn().mockReturnThis(),
    filter:       jest.fn().mockReturnThis(),
    map:          jest.fn().mockReturnThis(),
    merge:        jest.fn().mockReturnThis(),
    select:       jest.fn().mockReturnThis(),
    median:       jest.fn(() => makeImgChain()),
    mean:         jest.fn(() => makeImgChain()),
    sum:          jest.fn(() => makeImgChain()),
    size:         jest.fn(() => ({ gt: jest.fn(() => 'cond') })),
    toList:       jest.fn(() => ({ evaluate: jest.fn((cb) => cb([], null)) })),
    sort:         jest.fn().mockReturnThis(),
});

const mockEe = {
    initialize: jest.fn(),
    FeatureCollection: jest.fn(() => ({
        filter: jest.fn().mockReturnThis(),
        geometry: jest.fn(() => ({ type: 'Geom' })),
        map: jest.fn().mockReturnThis(),
        first: jest.fn(() => makeImgChain()),
    })),
    Feature: jest.fn((geom, props) => ({ type: 'Feature', geom, props })),
    Filter: {
        eq:    jest.fn(),
        lte:   jest.fn(),
        gte:   jest.fn(),
        lt:    jest.fn(),
        gt:    jest.fn(),
        date:  jest.fn(),
        calendarRange: jest.fn(),
    },
    Image: Object.assign(
        jest.fn(() => makeImgChain()),
        {
            cat:       jest.fn(() => makeImgChain()),
            constant:  jest.fn(() => makeImgChain()),
            pixelArea: jest.fn(() => makeImgChain()),
        },
    ),
    ImageCollection: jest.fn(() => makeCollection()),
    Reducer: {
        sum:     jest.fn(() => ({
            group:   jest.fn().mockReturnThis(),
            combine: jest.fn().mockReturnThis(),
        })),
        mean:    jest.fn(() => ({ combine: jest.fn().mockReturnThis() })),
        min:     jest.fn(() => ({ unmask: jest.fn().mockReturnThis() })),
        max:     jest.fn(() => ({ unmask: jest.fn().mockReturnThis() })),
        minMax:  jest.fn().mockReturnThis(),
        count:   jest.fn(() => ({ combine: jest.fn().mockReturnThis() })),
        toList:  jest.fn(() => makeImgChain()),
    },
    Algorithms: { If: jest.fn((cond, a, b) => a) },
    Date: Object.assign(
        jest.fn(() => ({ advance: jest.fn().mockReturnThis(), getRelative: jest.fn().mockReturnThis() })),
        {
            fromYMD: jest.fn(() => ({ advance: jest.fn().mockReturnThis() })),
            parse:   jest.fn(() => ({ advance: jest.fn().mockReturnThis() })),
        },
    ),
    Terrain: {
        slope:  jest.fn(() => makeImgChain()),
        aspect: jest.fn(() => makeImgChain()),
    },
    List:   jest.fn((arr) => ({
        map: jest.fn().mockReturnThis(),
        evaluate: jest.fn((cb) => cb(arr, null)),
    })),
    Number: jest.fn((n) => ({ evaluate: jest.fn((cb) => cb(n, null)) })),
    batch: {
        Export: {
            image: {
                toCloudStorage: jest.fn(() => ({
                    start:  jest.fn(),
                    status: jest.fn(() => ({ evaluate: jest.fn((cb) => cb({ name: 'task_fr_01' }, null)) })),
                })),
            },
        },
    },
    data: { getMapId: jest.fn((p, cb) => cb({ mapid: 'maps/fr', token: 'tok' }, null)) },
};

jest.mock('../../configs/gge', () => ({
    ee: mockEe,
    initializeEarthEngine: jest.fn().mockResolvedValue(undefined),
}));

// ── Config mock ───────────────────────────────────────────────────────────────

jest.mock('../../configs/fire-risk', () => ({
    FEATURE_WINDOW_DAYS:  45,
    S2_FALLBACK_DAYS:     180,
    NESTEROV_LOOKBACK_DAYS: 30,
    NESTEROV_P_BREAKS:    [100, 300, 1000, 4000],
    RISK_SCORE_BREAKS:    [0.25, 0.45, 0.65, 0.80],
    EXPORT_SCALE_M:       30,
    MINIO_BUCKET:         'fire-risk',
    GCS_BUCKET:           'my-gcs-bucket',
    GCS_KEY_FILE:         '/creds.json',
    isGcsConfigured:      jest.fn(() => false),
    ALERT_LEVEL:          4,
}));

// ── Repository mock ───────────────────────────────────────────────────────────

const mockRepo = {
    upsertSnapshot:    jest.fn(),
    updateStatus:      jest.fn(),
    replaceFeatures:   jest.fn(),
    getLatestCompleted: jest.fn(),
    getLatest:         jest.fn(),
    getFeatures:       jest.fn(),
    listCompleted:     jest.fn(),
    listExporting:     jest.fn(),
};

jest.mock('../../repositories/fire-risk.repository', () => mockRepo);

// ── GEE export helper mock ────────────────────────────────────────────────────

const mockPollGeeTask     = jest.fn();
const mockPublishRasterToMinio = jest.fn();
jest.mock('../../utils/gee-export.helper', () => ({
    pollGeeTask:          mockPollGeeTask,
    publishRasterToMinio: mockPublishRasterToMinio,
}));

// ── Geoserver mock ────────────────────────────────────────────────────────────

jest.mock('../../utils/geoserver.client', () => ({
    harvestGeoTiff: jest.fn().mockResolvedValue(undefined),
}));

// ── Error/status mocks ────────────────────────────────────────────────────────

jest.mock('../../core/error.response', () => ({
    BusinessLogicError: class BusinessLogicError extends Error {
        constructor(msg, codes, status) { super(msg); this.codes = codes; this.status = status; }
    },
}));
jest.mock('../../core/http-status-code', () => ({
    StatusCodes: { BAD_REQUEST: 400, SERVICE_UNAVAILABLE: 503 },
}));

const svc = require('../../services/fire-risk.service');

// ── getLatest ─────────────────────────────────────────────────────────────────

describe('getLatest', () => {
    const fakeSnapshot = {
        id: 1, analysis_date: new Date('2024-07-01'), status: 'completed',
        province_summary: { 1: 5000, 2: 20000 },
    };

    beforeEach(() => jest.clearAllMocks());

    test('returns snapshot + features when completed snapshot exists', async () => {
        mockRepo.getLatestCompleted.mockResolvedValue(fakeSnapshot);
        mockRepo.getFeatures.mockResolvedValue([]);
        const result = await svc.getLatest();
        expect(result.snapshot).toEqual(fakeSnapshot);
        expect(result.stale).toBe(false);
        expect(result.computing).toBe(false);
    });

    test('filters features by minRiskLevel parameter', async () => {
        mockRepo.getLatestCompleted.mockResolvedValue(fakeSnapshot);
        mockRepo.getFeatures.mockResolvedValue([]);
        await svc.getLatest({ minRiskLevel: 3 });
        expect(mockRepo.getFeatures).toHaveBeenCalledWith(1, { minLevel: 3 });
    });

    test('returns stale=true when only pending snapshot exists', async () => {
        mockRepo.getLatestCompleted.mockResolvedValue(null);
        mockRepo.getLatest.mockResolvedValue({ id: 2, status: 'computing' });
        const result = await svc.getLatest();
        expect(result.stale).toBe(true);
        expect(result.computing).toBe(true);
    });

    test('throws when no snapshot at all', async () => {
        mockRepo.getLatestCompleted.mockResolvedValue(null);
        mockRepo.getLatest.mockResolvedValue(null);
        await expect(svc.getLatest()).rejects.toThrow('Chưa có dữ liệu cảnh báo cháy rừng');
    });
});

// ── getMap ────────────────────────────────────────────────────────────────────

describe('getMap', () => {
    beforeEach(() => jest.clearAllMocks());

    test('returns empty FeatureCollection when no snapshot', async () => {
        mockRepo.getLatestCompleted.mockResolvedValue(null);
        const result = await svc.getMap();
        expect(result.type).toBe('FeatureCollection');
        expect(result.features).toHaveLength(0);
        expect(result.snapshotDate).toBeNull();
    });

    test('maps rows to GeoJSON features', async () => {
        mockRepo.getLatestCompleted.mockResolvedValue({
            id: 1, analysis_date: new Date('2024-07-01'), geoserver_layer: 'ws:fire_risk',
        });
        mockRepo.getFeatures.mockResolvedValue([
            { id: 10, risk_level: 5, district_code: 'KT001', district_name: 'Đắk Tô',
              area_ha: 1200.5, p_nesterov_mean: 500, ndvi_mean: 0.3, geometry: null, properties: {} },
        ]);
        const result = await svc.getMap({ minRiskLevel: 4 });
        expect(result.features).toHaveLength(1);
        expect(result.features[0].properties.riskLevel).toBe(5);
        expect(result.features[0].properties.districtName).toBe('Đắk Tô');
        expect(result.geoserverLayer).toBe('ws:fire_risk');
    });

    test('defaults minRiskLevel to 4', async () => {
        mockRepo.getLatestCompleted.mockResolvedValue({ id: 1, analysis_date: new Date(), geoserver_layer: null });
        mockRepo.getFeatures.mockResolvedValue([]);
        await svc.getMap();
        expect(mockRepo.getFeatures).toHaveBeenCalledWith(1, { minLevel: 4 });
    });
});

// ── getHistory ────────────────────────────────────────────────────────────────

describe('getHistory', () => {
    test('delegates to repo with default pagination', async () => {
        mockRepo.listCompleted.mockResolvedValue([]);
        await svc.getHistory();
        expect(mockRepo.listCompleted).toHaveBeenCalledWith({ page: 1, limit: 30 });
    });

    test('passes custom pagination params', async () => {
        mockRepo.listCompleted.mockResolvedValue([]);
        await svc.getHistory({ page: 3, limit: 10 });
        expect(mockRepo.listCompleted).toHaveBeenCalledWith({ page: 3, limit: 10 });
    });
});

// ── refresh ───────────────────────────────────────────────────────────────────

describe('refresh', () => {
    // refresh() delegates to runAnalysis(date, opts). We verify the date reaches
    // upsertSnapshot since internal function refs can't be spied on in CommonJS.

    test('passes todayUtc() to upsertSnapshot when no date provided', async () => {
        const today = svc.todayUtc();
        mockRepo.upsertSnapshot.mockResolvedValue({ id: 1, analysis_date: new Date(today), status: 'computing' });
        mockRepo.updateStatus.mockResolvedValue({ id: 1, status: 'failed' });
        await svc.refresh({ submitExport: false }).catch(() => {});
        expect(mockRepo.upsertSnapshot).toHaveBeenCalledWith(
            expect.objectContaining({ analysis_date: today }),
        );
    });

    test('passes provided date to upsertSnapshot', async () => {
        mockRepo.upsertSnapshot.mockResolvedValue({ id: 2, analysis_date: new Date('2024-07-01'), status: 'computing' });
        mockRepo.updateStatus.mockResolvedValue({ id: 2, status: 'failed' });
        await svc.refresh({ analysisDate: '2024-07-01', submitExport: false }).catch(() => {});
        expect(mockRepo.upsertSnapshot).toHaveBeenCalledWith(
            expect.objectContaining({ analysis_date: '2024-07-01' }),
        );
    });
});

// ── pollExports ───────────────────────────────────────────────────────────────

describe('pollExports', () => {
    beforeEach(() => jest.clearAllMocks());

    test('does nothing when no exporting snapshots', async () => {
        mockRepo.listExporting.mockResolvedValue([]);
        await svc.pollExports();
        expect(mockPollGeeTask).not.toHaveBeenCalled();
    });

    test('marks snapshot as published when GEE task COMPLETED', async () => {
        // isGcsConfigured must return true so publishRaster proceeds
        const cfg = require('../../configs/fire-risk');
        cfg.isGcsConfigured.mockReturnValueOnce(true);

        const snap = {
            id: 3,
            analysis_date: new Date('2024-07-01'),
            gee_task_id: 'task_fr_01',
            geoserver_layer: null,
            status: 'exporting',
        };
        mockRepo.listExporting.mockResolvedValue([snap]);
        mockPollGeeTask.mockResolvedValue('COMPLETED');
        mockPublishRasterToMinio.mockResolvedValue({ minioKey: 'fire_risk/kontum.tif', geoserver_layer: 'ws:fr' });
        mockRepo.updateStatus.mockResolvedValue({ ...snap, status: 'published' });

        await svc.pollExports();

        expect(mockRepo.updateStatus).toHaveBeenCalledWith(
            3, 'published', expect.objectContaining({ published_at: expect.any(Date) }),
        );
    });

    test('marks snapshot as failed on GEE FAILED', async () => {
        mockRepo.listExporting.mockResolvedValue([{
            id: 4, analysis_date: new Date(), gee_task_id: 'task_bad', status: 'exporting',
        }]);
        mockPollGeeTask.mockResolvedValue('FAILED');
        mockRepo.updateStatus.mockResolvedValue({ id: 4, status: 'failed' });

        await svc.pollExports();

        expect(mockRepo.updateStatus).toHaveBeenCalledWith(
            4, 'failed', expect.objectContaining({ error_message: expect.stringContaining('FAILED') }),
        );
    });

    test('continues when one snapshot throws', async () => {
        mockRepo.listExporting.mockResolvedValue([
            { id: 5, analysis_date: new Date(), gee_task_id: 'bad', status: 'exporting' },
            { id: 6, analysis_date: new Date(), gee_task_id: 'good', status: 'exporting' },
        ]);
        mockPollGeeTask
            .mockRejectedValueOnce(new Error('timeout'))
            .mockResolvedValueOnce('CANCELLED');
        mockRepo.updateStatus.mockResolvedValue({ id: 6, status: 'failed' });

        await expect(svc.pollExports()).resolves.not.toThrow();
        expect(mockRepo.updateStatus).toHaveBeenCalledTimes(1);
    });
});

// ── todayUtc / fmtDate (re-exported from gee-satellite.util) ─────────────────

describe('re-exported date helpers', () => {
    test('todayUtc returns YYYY-MM-DD', () => {
        expect(svc.todayUtc()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    test('fmtDate formats a date string', () => {
        expect(svc.fmtDate('2024-08-15')).toBe('2024-08-15');
    });
});
