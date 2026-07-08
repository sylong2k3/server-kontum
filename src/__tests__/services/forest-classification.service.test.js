'use strict';

/**
 * Tests for forest-classification.service.js
 *
 * All EE, DB, and GEE export calls are mocked.
 */

// ── EE mock ───────────────────────────────────────────────────────────────────

const makeImgChain = () => {
    const img = {};
    const methods = [
        'select','multiply','add','clamp','toFloat','copyProperties','updateMask','rename',
        'clip','addBands','unmask','mask','reduce','toByte','toInt16','normalizedDifference',
        'median','expression','where','byte','gt','gte','lt','lte','and','or','not',
        'subtract','bitwiseAnd','neq','eq','abs',
    ];
    methods.forEach((m) => { img[m] = jest.fn(() => img); });
    img.evaluate = jest.fn();
    img.geometry  = jest.fn(() => ({ type: 'Geometry' }));
    return img;
};

const makeCollection = () => ({
    filterBounds: jest.fn().mockReturnThis(),
    filterDate:   jest.fn().mockReturnThis(),
    filter:       jest.fn().mockReturnThis(),
    map:          jest.fn().mockReturnThis(),
    merge:        jest.fn().mockReturnThis(),
    sort:         jest.fn().mockReturnThis(),
    select:       jest.fn(() => makeImgChain()),  // returns image chain (not collection)
    median:       jest.fn(() => makeImgChain()),
    mean:         jest.fn(() => makeImgChain()),
    mode:         jest.fn(() => makeImgChain()),
    mosaic:       jest.fn(() => makeImgChain()),
    size:         jest.fn(() => ({ gt: jest.fn(() => 'cond'), evaluate: jest.fn((cb) => cb(3, null)) })),
});

const mockEe = {
    initialize: jest.fn(),
    FeatureCollection: jest.fn((id) => typeof id === 'string'
        ? { filter: jest.fn().mockReturnThis(), geometry: jest.fn(() => ({ type: 'Geom' })) }
        : { mosaic: jest.fn(() => makeImgChain()), size: jest.fn() }),
    Filter: { eq: jest.fn(), lt: jest.fn(), lte: jest.fn(), gte: jest.fn() },
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
        sum:  jest.fn(() => ({ group: jest.fn().mockReturnThis() })),
        mean: jest.fn(() => ({ combine: jest.fn().mockReturnThis() })),
        min:  jest.fn(() => ({ unmask: jest.fn().mockReturnThis() })),
    },
    Algorithms: { If: jest.fn((cond, a, b) => a) },
    Classifier: {
        smileRandomForest: jest.fn(() => ({
            train: jest.fn(() => ({ explain: jest.fn(() => ({ evaluate: jest.fn((cb) => cb({ outOfBagErrorEstimate: 0.05 }, null)) })) })),
        })),
    },
    Date: { fromYMD: jest.fn(() => ({ advance: jest.fn().mockReturnThis() })) },
    Terrain: {
        slope:  jest.fn(() => makeImgChain()),
        aspect: jest.fn(() => makeImgChain()),
    },
    batch: {
        Export: {
            image: {
                toCloudStorage: jest.fn(() => ({
                    start:  jest.fn(),
                    status: jest.fn(() => ({ evaluate: jest.fn((cb) => cb({ name: 'task_fc_01' }, null)) })),
                })),
            },
        },
    },
    data: { getMapId: jest.fn((p, cb) => cb({ mapid: 'maps/fc', token: 'tok' }, null)) },
};

jest.mock('../../configs/gge', () => ({
    ee: mockEe,
    initializeEarthEngine: jest.fn().mockResolvedValue(undefined),
}));

// ── Config mock ───────────────────────────────────────────────────────────────

jest.mock('../../configs/forest-classification', () => ({
    BASE_START_MONTH:        1,
    BASE_END_MONTH:          12,
    DRY_START_MONTH:         1,
    DRY_END_MONTH:           4,
    WET_START_MONTH:         8,
    WET_END_MONTH:           11,
    RF_TREES:                200,
    RF_VARIABLES_PER_SPLIT:  6,
    RF_MIN_LEAF_POPULATION:  5,
    RF_BAG_FRACTION:         0.5,
    SAMPLES_PER_CLASS:       500,
    SAMPLE_SCALE_M:          30,
    AREA_STATS_SCALE_M:      100,
    EXPORT_SCALE_M:          10,
    ALERT_CHANGE_PCT:        2.0,
    MINIO_BUCKET:            'forest-classification',
    GCS_BUCKET:              'my-gcs-bucket',
    GCS_KEY_FILE:            '/creds.json',
    isGcsConfigured:         jest.fn(() => false),
    CLASSES:                 Array.from({ length: 11 }, (_, i) => ({
        id: i, name: `Class ${i}`, color: '#000000',
    })),
    CLASS_IDS: { WATER: 9 },
}));

// ── Repository mock ───────────────────────────────────────────────────────────

const mockRepo = {
    upsertSnapshot:      jest.fn(),
    updateStatus:        jest.fn(),
    upsertDistrictAreas: jest.fn(),
    getById:             jest.fn(),
    getLatestCompleted:  jest.fn(),
    getLatest:           jest.fn(),
    getByYearMonth:      jest.fn(),
    getDistrictAreas:    jest.fn(),
    listCompleted:       jest.fn(),
    listAll:             jest.fn(),
    listExporting:       jest.fn(),
};

jest.mock('../../repositories/forest-classification.repository', () => mockRepo);

// ── GEE export helper mock ────────────────────────────────────────────────────

jest.mock('../../utils/gee-export.helper', () => ({
    pollGeeTask:          jest.fn(),
    publishRasterToMinio: jest.fn(),
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

const svc = require('../../services/forest-classification.service');

// ── getLatest ─────────────────────────────────────────────────────────────────

describe('getLatest', () => {
    const fakeSnapshot = { id: 1, year: 2024, month: 5, status: 'completed',
        province_summary: { 4: 100000 } };

    test('returns snapshot + districtAreas when completed snapshot exists', async () => {
        mockRepo.getLatestCompleted.mockResolvedValue(fakeSnapshot);
        mockRepo.getDistrictAreas.mockResolvedValue([]);
        const result = await svc.getLatest();
        expect(result.snapshot).toEqual(fakeSnapshot);
        expect(result.stale).toBe(false);
        expect(result.computing).toBe(false);
    });

    test('returns stale=true when no completed snapshot but a pending one exists', async () => {
        mockRepo.getLatestCompleted.mockResolvedValue(null);
        mockRepo.getLatest.mockResolvedValue({ id: 2, status: 'computing' });
        const result = await svc.getLatest();
        expect(result.stale).toBe(true);
        expect(result.computing).toBe(true);
    });

    test('throws BusinessLogicError when no snapshot at all', async () => {
        mockRepo.getLatestCompleted.mockResolvedValue(null);
        mockRepo.getLatest.mockResolvedValue(null);
        await expect(svc.getLatest()).rejects.toThrow('Chưa có dữ liệu phân loại rừng');
    });
});

// ── getHistory ────────────────────────────────────────────────────────────────

describe('getHistory', () => {
    test('delegates to repo with page/limit', async () => {
        mockRepo.listCompleted.mockResolvedValue([]);
        await svc.getHistory({ page: 2, limit: 12 });
        expect(mockRepo.listCompleted).toHaveBeenCalledWith({ page: 2, limit: 12 });
    });

    test('uses default pagination (page 1, limit 24)', async () => {
        mockRepo.listCompleted.mockResolvedValue([]);
        await svc.getHistory();
        expect(mockRepo.listCompleted).toHaveBeenCalledWith({ page: 1, limit: 24 });
    });
});

// ── refresh ───────────────────────────────────────────────────────────────────

describe('refresh', () => {
    // refresh() delegates to runAnalysis(year, month). Because runAnalysis uses
    // internal function references (not module.exports), we can't spy on it
    // directly. Instead, verify that the correct year/month reach upsertSnapshot.

    test('passes year/month to upsertSnapshot', async () => {
        mockRepo.upsertSnapshot.mockResolvedValue({ id: 10, year: 2024, month: 6, status: 'computing' });
        mockRepo.updateStatus.mockResolvedValue({ id: 10, status: 'failed' });
        // Deep GEE pipeline will throw — we don't care, just verify the entry point
        await svc.refresh({ year: 2024, month: 6 }).catch(() => {});
        expect(mockRepo.upsertSnapshot).toHaveBeenCalledWith(
            expect.objectContaining({ year: 2024, month: 6 }),
        );
    });

    test('defaults to current UTC month when no args provided', async () => {
        const now = new Date();
        mockRepo.upsertSnapshot.mockResolvedValue({
            id: 11, year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, status: 'computing',
        });
        mockRepo.updateStatus.mockResolvedValue({ id: 11, status: 'failed' });
        await svc.refresh().catch(() => {});
        expect(mockRepo.upsertSnapshot).toHaveBeenCalledWith(
            expect.objectContaining({ year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 }),
        );
    });
});

// ── pollExports ───────────────────────────────────────────────────────────────

describe('pollExports', () => {
    const { pollGeeTask, publishRasterToMinio } = require('../../utils/gee-export.helper');

    beforeEach(() => jest.clearAllMocks());

    test('does nothing when no exporting snapshots', async () => {
        mockRepo.listExporting.mockResolvedValue([]);
        await svc.pollExports();
        expect(pollGeeTask).not.toHaveBeenCalled();
    });

    test('marks snapshot as published when GEE task COMPLETED', async () => {
        const snap = { id: 5, year: 2024, month: 5, gee_task_id: 'task_fc_05' };
        mockRepo.listExporting.mockResolvedValue([snap]);
        pollGeeTask.mockResolvedValue('COMPLETED');
        publishRasterToMinio.mockResolvedValue({ minioKey: 'forest_classification/kontum_forest_202405.tif' });
        mockRepo.updateStatus.mockResolvedValue({ ...snap, status: 'published' });

        await svc.pollExports();

        expect(mockRepo.updateStatus).toHaveBeenCalledWith(
            5, 'published', expect.objectContaining({ published_at: expect.any(Date) }),
        );
    });

    test('marks snapshot as failed when GEE task FAILED', async () => {
        mockRepo.listExporting.mockResolvedValue([{ id: 6, year: 2024, month: 6, gee_task_id: 'task_fail' }]);
        pollGeeTask.mockResolvedValue('FAILED');
        mockRepo.updateStatus.mockResolvedValue({ id: 6, status: 'failed' });

        await svc.pollExports();

        expect(mockRepo.updateStatus).toHaveBeenCalledWith(
            6, 'failed', expect.objectContaining({ error_message: expect.stringContaining('FAILED') }),
        );
    });

    test('continues when one snapshot throws', async () => {
        mockRepo.listExporting.mockResolvedValue([
            { id: 7, year: 2024, month: 7, gee_task_id: 'bad' },
            { id: 8, year: 2024, month: 8, gee_task_id: 'good' },
        ]);
        pollGeeTask
            .mockRejectedValueOnce(new Error('network error'))
            .mockResolvedValueOnce('FAILED');
        mockRepo.updateStatus.mockResolvedValue({ id: 8, status: 'failed' });

        await expect(svc.pollExports()).resolves.not.toThrow();
        expect(mockRepo.updateStatus).toHaveBeenCalledTimes(1);
    });
});

// ── queryForPeriod ────────────────────────────────────────────────────────────

describe('queryForPeriod', () => {
    const completedSnap = {
        id: 20, year: 2024, month: 3, status: 'completed',
        trigger: 'cron', province_summary: { 4: 80000 },
    };

    beforeEach(() => jest.clearAllMocks());

    test('returns cached result when completed snapshot exists', async () => {
        mockRepo.getByYearMonth.mockResolvedValue(completedSnap);
        mockRepo.getDistrictAreas.mockResolvedValue([{ districtCode: 'KT01', classes: [] }]);

        const result = await svc.queryForPeriod(2024, 3);
        expect(result.cached).toBe(true);
        expect(result.computing).toBe(false);
        expect(result.snapshot).toEqual(completedSnap);
        expect(mockRepo.getDistrictAreas).toHaveBeenCalledWith(20);
    });

    test('returns cached result when snapshot is published', async () => {
        mockRepo.getByYearMonth.mockResolvedValue({ ...completedSnap, status: 'published' });
        mockRepo.getDistrictAreas.mockResolvedValue([]);

        const result = await svc.queryForPeriod(2024, 3);
        expect(result.cached).toBe(true);
    });

    test('returns computing=true when snapshot is already computing', async () => {
        mockRepo.getByYearMonth.mockResolvedValue({ ...completedSnap, status: 'computing' });

        const result = await svc.queryForPeriod(2024, 3);
        expect(result.computing).toBe(true);
        expect(result.cached).toBe(false);
        expect(result.districtAreas).toHaveLength(0);
    });

    test('returns computing=true when snapshot is exporting', async () => {
        mockRepo.getByYearMonth.mockResolvedValue({ ...completedSnap, status: 'exporting' });

        const result = await svc.queryForPeriod(2024, 3);
        expect(result.computing).toBe(true);
    });

    test('triggers background run and returns computing=true when no snapshot found', async () => {
        mockRepo.getByYearMonth
            .mockResolvedValueOnce(null)     // first call: no existing snapshot
            .mockResolvedValueOnce(          // second call: after fire-and-forget started
                { id: 21, year: 2024, month: 3, status: 'computing' });
        mockRepo.upsertSnapshot.mockResolvedValue({ id: 21, year: 2024, month: 3, status: 'computing' });
        mockRepo.updateStatus.mockResolvedValue({ id: 21, status: 'failed' }); // runAnalysis will fail

        const result = await svc.queryForPeriod(2024, 3, 99);
        expect(result.computing).toBe(true);
        expect(result.cached).toBe(false);
        // upsertSnapshot should be called by the fire-and-forget runAnalysis
        // Allow one tick for the fire-and-forget to start
        await new Promise((r) => setImmediate(r));
        expect(mockRepo.upsertSnapshot).toHaveBeenCalledWith(
            expect.objectContaining({ year: 2024, month: 3, trigger: 'user', requested_by: 99 }),
        );
    });

    test('re-triggers when existing snapshot is failed', async () => {
        mockRepo.getByYearMonth
            .mockResolvedValueOnce({ ...completedSnap, status: 'failed' })
            .mockResolvedValueOnce({ id: 22, year: 2024, month: 3, status: 'computing' });
        mockRepo.upsertSnapshot.mockResolvedValue({ id: 22, year: 2024, month: 3, status: 'computing' });
        mockRepo.updateStatus.mockResolvedValue({ id: 22, status: 'failed' });

        const result = await svc.queryForPeriod(2024, 3);
        expect(result.computing).toBe(true);
        await new Promise((r) => setImmediate(r));
        expect(mockRepo.upsertSnapshot).toHaveBeenCalled();
    });
});

// ── getLogs ───────────────────────────────────────────────────────────────────

describe('getLogs', () => {
    beforeEach(() => jest.clearAllMocks());

    test('delegates to repo.listAll with page/limit/status', async () => {
        mockRepo.listAll.mockResolvedValue({ items: [], total: 0 });
        await svc.getLogs({ page: 2, limit: 10, status: 'failed' });
        expect(mockRepo.listAll).toHaveBeenCalledWith({ page: 2, limit: 10, status: 'failed' });
    });

    test('uses defaults when no args provided', async () => {
        mockRepo.listAll.mockResolvedValue({ items: [], total: 0 });
        await svc.getLogs();
        expect(mockRepo.listAll).toHaveBeenCalledWith({ page: 1, limit: 24, status: null });
    });

    test('returns items and total from repo', async () => {
        const items = [
            { id: 1, year: 2024, month: 1, status: 'completed', trigger: 'cron', duration_ms: 180000 },
            { id: 2, year: 2024, month: 2, status: 'failed',    trigger: 'user', duration_ms: null },
        ];
        mockRepo.listAll.mockResolvedValue({ items, total: 2 });
        const result = await svc.getLogs();
        expect(result.items).toHaveLength(2);
        expect(result.total).toBe(2);
    });
});

// ── getSnapshotById ───────────────────────────────────────────────────────────

describe('getSnapshotById', () => {
    beforeEach(() => jest.clearAllMocks());

    test('returns null when snapshot not found', async () => {
        mockRepo.getById.mockResolvedValue(null);
        const result = await svc.getSnapshotById(9999);
        expect(result).toBeNull();
    });

    test('includes districtAreas when snapshot is completed', async () => {
        const snap = { id: 30, year: 2024, month: 4, status: 'completed' };
        mockRepo.getById.mockResolvedValue(snap);
        mockRepo.getDistrictAreas.mockResolvedValue([{ districtCode: 'KT01', classes: [] }]);

        const result = await svc.getSnapshotById(30);
        expect(result.snapshot).toEqual(snap);
        expect(result.districtAreas).toHaveLength(1);
        expect(mockRepo.getDistrictAreas).toHaveBeenCalledWith(30);
    });

    test('returns empty districtAreas when snapshot is computing', async () => {
        mockRepo.getById.mockResolvedValue({ id: 31, year: 2024, month: 5, status: 'computing' });

        const result = await svc.getSnapshotById(31);
        expect(result.districtAreas).toHaveLength(0);
        expect(mockRepo.getDistrictAreas).not.toHaveBeenCalled();
    });

    test('returns empty districtAreas when snapshot is failed', async () => {
        mockRepo.getById.mockResolvedValue({
            id: 32, year: 2024, month: 6, status: 'failed', error_message: 'GEE timeout',
        });

        const result = await svc.getSnapshotById(32);
        expect(result.districtAreas).toHaveLength(0);
    });

    test('includes districtAreas when snapshot is published', async () => {
        const snap = { id: 33, year: 2024, month: 7, status: 'published' };
        mockRepo.getById.mockResolvedValue(snap);
        mockRepo.getDistrictAreas.mockResolvedValue([]);

        const result = await svc.getSnapshotById(33);
        expect(mockRepo.getDistrictAreas).toHaveBeenCalledWith(33);
    });
});

// ── refresh trigger ───────────────────────────────────────────────────────────

describe('refresh trigger', () => {
    test('passes trigger=manual to upsertSnapshot', async () => {
        mockRepo.upsertSnapshot.mockResolvedValue({ id: 40, year: 2024, month: 8, status: 'computing' });
        mockRepo.updateStatus.mockResolvedValue({ id: 40, status: 'failed' });
        await svc.refresh({ year: 2024, month: 8 }).catch(() => {});
        expect(mockRepo.upsertSnapshot).toHaveBeenCalledWith(
            expect.objectContaining({ trigger: 'manual' }),
        );
    });
});
