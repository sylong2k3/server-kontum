'use strict';

/**
 * Tests for satellite.service.js
 *
 * Mocks: GEE SDK, satellite repository, geoserver client.
 * No real DB or network calls.
 */

// ── EE mock ───────────────────────────────────────────────────────────────────

const makeImgChain = () => {
    const img = {};
    const chainable = [
        'select', 'multiply', 'add', 'clamp', 'toFloat', 'copyProperties', 'updateMask',
        'rename', 'clip', 'addBands', 'unmask', 'mask', 'reduce', 'toByte', 'toInt16',
        'normalizedDifference', 'median', 'mean', 'subtract', 'abs', 'expression',
        'where', 'byte', 'selfMask', 'divide', 'reduceRegion', 'reduceRegions',
    ];
    chainable.forEach((m) => { img[m] = jest.fn(() => img); });
    img.and = img.not = img.gt = img.gte = img.lt = img.lte = img.neq = img.eq =
        img.bitwiseAnd = img.or = () => img;
    img.evaluate = jest.fn((cb) => cb({ groups: [] }, null));
    // reduceRegion returns an evaluatable object
    img.reduceRegion = jest.fn(() => ({ evaluate: jest.fn((cb) => cb({ groups: [] }, null)) }));
    return img;
};

const fakeMapId = { mapid: 'maps/testmap', token: 'tok123' };
const fakeTileUrl = 'https://earthengine.googleapis.com/map/maps/testmap/{z}/{x}/{y}?token=tok123';

const makeCollectionMock = () => {
    const col = {};
    const chainable = ['filterBounds', 'filterDate', 'filter', 'map', 'merge', 'sort'];
    chainable.forEach((m) => { col[m] = jest.fn(() => col); });
    col.select = jest.fn(() => col);
    col.median = jest.fn(() => makeImgChain());
    col.mean   = jest.fn(() => makeImgChain());
    col.size   = jest.fn(() => ({ evaluate: jest.fn((cb) => cb(5, null)) }));
    return col;
};

// pixelArea() returns an image chain with divide that also chains
const makePixelAreaChain = () => {
    const img = makeImgChain();
    img.divide    = jest.fn(() => img);
    img.addBands  = jest.fn(() => img);
    img.reduceRegion = jest.fn(() => ({ evaluate: jest.fn((cb) => cb({ groups: [] }, null)) }));
    return img;
};

const mockEe = {
    initialize:   jest.fn(),
    Geometry:     Object.assign(jest.fn((g) => g), {
        BBox: jest.fn((a,b,c,d) => ({ type:'BBox', coords:[a,b,c,d] })),
    }),
    FeatureCollection: jest.fn(() => ({
        filter: jest.fn().mockReturnThis(),
        geometry: jest.fn(() => ({ type: 'FeatureCollectionGeometry' })),
    })),
    Filter: { eq: jest.fn(), lte: jest.fn(), lt: jest.fn() },
    Image:  Object.assign(jest.fn(() => makeImgChain()), {
        cat:       jest.fn(() => makeImgChain()),
        constant:  jest.fn(() => makeImgChain()),
        pixelArea: jest.fn(() => makePixelAreaChain()),
    }),
    ImageCollection: jest.fn(() => makeCollectionMock()),
    Reducer: {
        sum:    jest.fn(() => ({ group: jest.fn().mockReturnThis() })),
        mean:   jest.fn(() => ({ combine: jest.fn().mockReturnThis() })),
        min:    jest.fn(() => ({ unmask: jest.fn().mockReturnThis() })),
        minMax: jest.fn().mockReturnValue({ combine: jest.fn().mockReturnThis() }),
    },
    data: {
        getMapId: jest.fn((params, cb) => cb(fakeMapId, null)),
    },
    batch: {
        Export: {
            image: {
                toCloudStorage: jest.fn(() => ({
                    start: jest.fn(),
                    status: jest.fn(() => ({ evaluate: jest.fn((cb) => cb({ name: 'task_001' }, null)) })),
                })),
            },
        },
    },
};

jest.mock('../../configs/gge', () => ({
    ee: mockEe,
    initializeEarthEngine: jest.fn().mockResolvedValue(undefined),
}));

// ── Repository mock ───────────────────────────────────────────────────────────

const mockRepo = {
    getByHash:     jest.fn(),
    getById:       jest.fn(),
    upsert:        jest.fn(),
    updatePublish: jest.fn(),
    listExporting: jest.fn(),
};

jest.mock('../../repositories/satellite.repository', () => mockRepo);

// ── GeoServer client mock ─────────────────────────────────────────────────────

jest.mock('../../utils/geoserver.client', () => ({
    publishRasterLayer: jest.fn().mockResolvedValue('workspace:sat_store'),
}));

// ── GEE export helper mock ────────────────────────────────────────────────────

jest.mock('../../utils/gee-export.helper', () => ({
    pollGeeTask:         jest.fn(),
    publishRasterToMinio: jest.fn(),
}));

// ── Error/status mocks ────────────────────────────────────────────────────────

jest.mock('../../core/error.response', () => ({
    BusinessLogicError: class BusinessLogicError extends Error {
        constructor(msg, codes, status) {
            super(msg);
            this.codes  = codes;
            this.status = status;
        }
    },
}));
jest.mock('../../core/http-status-code', () => ({ StatusCodes: { BAD_REQUEST: 400 } }));

// ── Test helpers ──────────────────────────────────────────────────────────────

// Set GCS env before module load (GCS_BUCKET is captured as a module-level const).
process.env.GEE_GCS_BUCKET = 'my-gcs-bucket';
process.env.APP_URL = 'https://api.example.com';

const svc = require('../../services/satellite.service');

const BASE_PARAMS = {
    startDate: '2024-01-01',
    endDate:   '2024-03-31',
};

function makeSavedRow(overrides = {}) {
    return {
        id:              1,
        image_type:      'rgb',
        collection:      null,
        start_date:      '2024-01-01',
        end_date:        '2024-03-31',
        start_date2:     null,
        end_date2:       null,
        geometry:        null,
        tile_url:        fakeTileUrl,
        map_id:          'maps/testmap',
        stats:           { imageCount: 5 },
        legend:          null,
        metadata:        {},
        geoserver_layer: null,
        status:          'ready',
        ...overrides,
    };
}

// ── processRequest — cache miss ───────────────────────────────────────────────

describe('processRequest (cache miss)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockRepo.getByHash.mockResolvedValue(null);
        mockRepo.upsert.mockResolvedValue(makeSavedRow());
    });

    test('rgb — returns resultId and proxy tileUrl', async () => {
        const result = await svc.getRgb(BASE_PARAMS);
        expect(result.resultId).toBe(1);
        expect(result.tileUrl).toContain('/api/v1/satellite/tiles/1/');
        expect(result.cached).toBe(false);
    });

    test('ndvi — includes vegetationHa in stats', async () => {
        mockRepo.upsert.mockResolvedValue(makeSavedRow({
            image_type: 'ndvi',
            stats: { imageCount: 5, vegetationHa: 300000, ndviThreshUsed: 0.3 },
        }));
        const result = await svc.getNdvi(BASE_PARAMS);
        expect(result.stats).toBeDefined();
    });

    test('heat-map — returns result without crashing', async () => {
        mockRepo.upsert.mockResolvedValue(makeSavedRow({ image_type: 'heatmap' }));
        const result = await svc.getHeatmap(BASE_PARAMS);
        expect(result.resultId).toBeDefined();
    });

    test('classified — returns areaByClass with 7 entries', async () => {
        const areaByClass = svc.CLASSIFIED_CLASSES.map((c) => ({
            classId: c.id, name: c.name, color: c.color, areaHa: 1000,
        }));
        mockRepo.upsert.mockResolvedValue(makeSavedRow({
            image_type: 'classified',
            stats: { imageCount: 5, areaByClass },
        }));
        const result = await svc.getClassified(BASE_PARAMS);
        expect(svc.CLASSIFIED_CLASSES).toHaveLength(7);
        expect(result.resultId).toBeDefined();
    });

    test('compare — requires startDate2 + endDate2', async () => {
        mockRepo.upsert.mockResolvedValue(makeSavedRow({ image_type: 'compare' }));
        const result = await svc.getCompare({
            ...BASE_PARAMS,
            startDate2: '2023-01-01',
            endDate2:   '2023-03-31',
        });
        expect(result.resultId).toBeDefined();
    });

    test('unknown type throws BusinessLogicError', async () => {
        await expect(svc.processRequest('invalid_type', BASE_PARAMS))
            .rejects.toThrow('Loại ảnh không hợp lệ');
    });
});

// ── processRequest — cache hit ────────────────────────────────────────────────

describe('processRequest (cache hit)', () => {
    test('returns cached result without calling GEE', async () => {
        mockRepo.getByHash.mockResolvedValue(makeSavedRow({ id: 7 }));
        const result = await svc.getRgb(BASE_PARAMS);
        expect(result.cached).toBe(true);
        expect(result.resultId).toBe(7);
        expect(mockRepo.upsert).not.toHaveBeenCalled();
    });

    test('includes geoserverLayer if result is published', async () => {
        mockRepo.getByHash.mockResolvedValue(makeSavedRow({
            geoserver_layer: 'workspace:my_layer',
        }));
        const result = await svc.getRgb(BASE_PARAMS);
        expect(result.geoserverLayer).toBe('workspace:my_layer');
    });
});

// ── streamTile ────────────────────────────────────────────────────────────────

describe('streamTile', () => {
    const mockRes = {
        status: jest.fn().mockReturnThis(),
        set:    jest.fn(),
        end:    jest.fn(),
        pipe:   jest.fn(),
    };

    beforeEach(() => jest.clearAllMocks());

    test('responds 404 when resultId not found', async () => {
        mockRepo.getById.mockResolvedValue(null);
        await svc.streamTile(999, 10, 100, 200, mockRes);
        expect(mockRes.status).toHaveBeenCalledWith(404);
        expect(mockRes.end).toHaveBeenCalled();
    });

    test('proxies tile and sets cache headers on success', async () => {
        mockRepo.getById.mockResolvedValue(makeSavedRow());
        const fakeStream = { pipe: jest.fn() };
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            headers: { get: jest.fn(() => 'image/png') },
            body: { getReader: jest.fn(), [Symbol.asyncIterator]: async function* () {} },
        });

        // Patch Readable.fromWeb
        const stream = require('stream');
        jest.spyOn(stream.Readable, 'fromWeb').mockReturnValue(fakeStream);

        await svc.streamTile(1, 10, 100, 200, mockRes);
        expect(mockRes.set).toHaveBeenCalledWith('Cache-Control', 'public, max-age=3600');
        expect(fakeStream.pipe).toHaveBeenCalledWith(mockRes);
    });

    test('responds 504 on GEE tile timeout (AbortError)', async () => {
        mockRepo.getById.mockResolvedValue(makeSavedRow());
        const abortErr = new Error('The operation was aborted');
        abortErr.name = 'AbortError';
        global.fetch = jest.fn().mockRejectedValue(abortErr);

        await svc.streamTile(1, 10, 100, 200, mockRes);
        expect(mockRes.status).toHaveBeenCalledWith(504);
    });
});

// ── publishResult ─────────────────────────────────────────────────────────────

describe('publishResult', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('submits export task and sets status to exporting', async () => {
        mockRepo.getById.mockResolvedValue(makeSavedRow({ geoserver_layer: null }));
        mockRepo.updatePublish.mockResolvedValue(makeSavedRow({ status: 'exporting' }));

        const result = await svc.publishResult(1);
        expect(mockRepo.updatePublish).toHaveBeenCalledWith(
            1,
            expect.objectContaining({ status: 'exporting' }),
        );
        expect(result.status).toBe('exporting');
    });

    test('skips re-export when already published', async () => {
        mockRepo.getById.mockResolvedValue(makeSavedRow({ geoserver_layer: 'ws:layer' }));
        const result = await svc.publishResult(1);
        expect(mockRepo.updatePublish).not.toHaveBeenCalled();
        expect(result.geoserver_layer).toBe('ws:layer');
    });

    test('throws when resultId does not exist', async () => {
        mockRepo.getById.mockResolvedValue(null);
        await expect(svc.publishResult(9999)).rejects.toThrow('Kết quả không tồn tại');
    });

    test('throws when resultId does not exist (again with GCS set)', async () => {
        mockRepo.getById.mockResolvedValue(null);
        await expect(svc.publishResult(8888)).rejects.toThrow('Kết quả không tồn tại');
    });
});

// ── pollPublishes ─────────────────────────────────────────────────────────────

describe('pollPublishes', () => {
    const { pollGeeTask, publishRasterToMinio } = require('../../utils/gee-export.helper');
    const geoserver = require('../../utils/geoserver.client');

    beforeEach(() => {
        jest.clearAllMocks();
        process.env.GEE_GCS_BUCKET = 'my-gcs-bucket';
    });

    test('marks result as published when GEE task COMPLETED', async () => {
        mockRepo.listExporting.mockResolvedValue([makeSavedRow({
            status: 'exporting', gee_task_id: 'task_001',
        })]);
        pollGeeTask.mockResolvedValue('COMPLETED');
        publishRasterToMinio.mockResolvedValue({ minioKey: 'satellite/test.tif' });
        mockRepo.updatePublish.mockResolvedValue(makeSavedRow({ status: 'published' }));

        await svc.pollPublishes();

        expect(mockRepo.updatePublish).toHaveBeenCalledWith(
            1,
            expect.objectContaining({ status: 'published' }),
        );
    });

    test('marks result as failed when GEE task FAILED', async () => {
        mockRepo.listExporting.mockResolvedValue([makeSavedRow({
            status: 'exporting', gee_task_id: 'task_fail',
        })]);
        pollGeeTask.mockResolvedValue('FAILED');
        mockRepo.updatePublish.mockResolvedValue(makeSavedRow({ status: 'failed' }));

        await svc.pollPublishes();

        expect(mockRepo.updatePublish).toHaveBeenCalledWith(
            1,
            expect.objectContaining({ status: 'failed' }),
        );
    });

    test('continues processing remaining items when one throws', async () => {
        const rows = [
            makeSavedRow({ id: 1, gee_task_id: 'bad_task' }),
            makeSavedRow({ id: 2, gee_task_id: 'good_task' }),
        ];
        mockRepo.listExporting.mockResolvedValue(rows);
        pollGeeTask
            .mockRejectedValueOnce(new Error('network error'))
            .mockResolvedValueOnce('FAILED');
        mockRepo.updatePublish.mockResolvedValue(makeSavedRow({ status: 'failed' }));

        await expect(svc.pollPublishes()).resolves.not.toThrow();
        expect(mockRepo.updatePublish).toHaveBeenCalledTimes(1); // only second item
    });

    test('does nothing when no exporting results', async () => {
        mockRepo.listExporting.mockResolvedValue([]);
        await svc.pollPublishes();
        expect(pollGeeTask).not.toHaveBeenCalled();
    });
});

// ── CLASSIFIED_CLASSES exported constant ──────────────────────────────────────

describe('CLASSIFIED_CLASSES', () => {
    test('has 7 entries with id, name, color', () => {
        expect(svc.CLASSIFIED_CLASSES).toHaveLength(7);
        svc.CLASSIFIED_CLASSES.forEach((c) => {
            expect(c).toHaveProperty('id');
            expect(c).toHaveProperty('name');
            expect(c).toHaveProperty('color');
        });
    });

    test('IDs are sequential 0-6', () => {
        const ids = svc.CLASSIFIED_CLASSES.map((c) => c.id);
        expect(ids).toEqual([0, 1, 2, 3, 4, 5, 6]);
    });
});
