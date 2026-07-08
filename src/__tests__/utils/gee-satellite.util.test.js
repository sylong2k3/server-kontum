'use strict';

/**
 * Tests for gee-satellite.util.js
 *
 * All EE objects are mocked — no real GEE SDK calls.
 */

// ── Mock @google/earthengine before any require ───────────────────────────────

const mockEe = {
    Geometry: Object.assign(
        jest.fn((g) => ({ type: 'Geometry', g })),
        { BBox: jest.fn((minX, minY, maxX, maxY) => ({ type: 'BBox', minX, minY, maxX, maxY })) },
    ),
    FeatureCollection: jest.fn((id) => ({
        filter: jest.fn().mockReturnThis(),
        geometry: jest.fn(() => ({ type: 'Geometry', id })),
    })),
    Filter: {
        eq: jest.fn((k, v) => ({ k, v })),
    },
    Image: Object.assign(
        jest.fn(() => makeImageMock()),
        {
            cat:       jest.fn((bands) => ({ type: 'Image', bands })),
            constant:  jest.fn((vals) => ({ rename: jest.fn().mockReturnThis(), updateMask: jest.fn().mockReturnThis() })),
            pixelArea: jest.fn(() => ({ divide: jest.fn().mockReturnThis(), addBands: jest.fn().mockReturnThis(), reduceRegion: jest.fn(() => ({ evaluate: jest.fn() })) })),
        },
    ),
    ImageCollection: jest.fn(() => ({
        filterBounds: jest.fn().mockReturnThis(),
        filterDate: jest.fn().mockReturnThis(),
        filter: jest.fn().mockReturnThis(),
        map: jest.fn().mockReturnThis(),
        merge: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        median: jest.fn().mockReturnThis(),
        size: jest.fn(() => ({ gt: jest.fn(() => ({ evaluate: jest.fn() })) })),
    })),
    Reducer: {
        sum: jest.fn(() => ({ group: jest.fn().mockReturnThis() })),
        mean: jest.fn(() => ({ combine: jest.fn().mockReturnThis() })),
        min: jest.fn().mockReturnValue({ unmask: jest.fn().mockReturnThis() }),
    },
    Algorithms: {
        If: jest.fn((cond, a, b) => a),
    },
    Date: {
        fromYMD: jest.fn((y, m, d) => ({ advance: jest.fn().mockReturnThis() })),
    },
    Terrain: {
        slope: jest.fn((dem) => ({ rename: jest.fn().mockReturnThis() })),
        aspect: jest.fn((dem) => ({ rename: jest.fn().mockReturnThis() })),
    },
    data: {
        getMapId: jest.fn(),
    },
};

// Mock the image-like chainable object returned by prepL57/prepL89/maskS2.
const makeImageMock = () => {
    const img = {};
    img.select         = jest.fn(() => img);
    img.multiply       = jest.fn(() => img);
    img.add            = jest.fn(() => img);
    img.clamp          = jest.fn(() => img);
    img.toFloat        = jest.fn(() => img);
    img.copyProperties = jest.fn(() => img);
    img.updateMask     = jest.fn(() => img);
    img.rename         = jest.fn(() => img);
    img.normalizedDifference = jest.fn(() => img);
    img.expression     = jest.fn(() => img);
    img.clip           = jest.fn(() => img);
    img.addBands       = jest.fn(() => img);
    img.unmask         = jest.fn(() => img);
    img.mask           = jest.fn(() => img);
    img.reduce         = jest.fn(() => img);
    img.toByte         = jest.fn(() => img);
    img.neq = img.and = img.bitwiseAnd = img.eq = img.gt = img.gte =
        img.lt = img.lte = img.subtract = img.abs = img.not = () => img;
    img.evaluate = jest.fn();
    return img;
};

jest.mock('../../configs/gge', () => ({ ee: mockEe, initializeEarthEngine: jest.fn() }));

const {
    eeEval,
    getEeMapId,
    toEeGeometry,
    fmtDate,
    todayUtc,
    maskLandsatC2,
    prepL57,
    prepL89,
    maskS2,
    maskS2FireRisk,
    addIndices,
    medianOrFallback,
} = require('../../utils/gee-satellite.util');

// ── eeEval ────────────────────────────────────────────────────────────────────

describe('eeEval', () => {
    test('resolves with GEE result on success', async () => {
        const fakeObj = { evaluate: jest.fn((cb) => cb({ value: 42 }, null)) };
        const result = await eeEval(fakeObj);
        expect(result).toEqual({ value: 42 });
    });

    test('rejects when GEE returns an error', async () => {
        const fakeObj = { evaluate: jest.fn((cb) => cb(null, 'GEE error')) };
        await expect(eeEval(fakeObj)).rejects.toThrow('GEE error');
    });

    test('rejects after timeout', async () => {
        jest.useFakeTimers();
        const fakeObj = { evaluate: jest.fn() }; // never calls callback
        const p = eeEval(fakeObj, 100);
        jest.advanceTimersByTime(200);
        await expect(p).rejects.toThrow('timeout');
        jest.useRealTimers();
    });
});

// ── getEeMapId ────────────────────────────────────────────────────────────────

describe('getEeMapId', () => {
    test('builds tile URL with legacy token format', async () => {
        mockEe.data.getMapId.mockImplementationOnce((params, cb) =>
            cb({ mapid: 'maps/abc123', token: 'tok_xyz' }, null)
        );
        const { mapId, tileUrl } = await getEeMapId(makeImageMock(), {});
        expect(mapId).toBe('maps/abc123');
        expect(tileUrl).toContain('{z}/{x}/{y}');
        expect(tileUrl).toContain('tok_xyz');
    });

    test('builds tile URL with v1alpha format (no token)', async () => {
        mockEe.data.getMapId.mockImplementationOnce((params, cb) =>
            cb({ name: 'projects/earthengine-public/maps/proj-abc', token: '' }, null)
        );
        const { tileUrl } = await getEeMapId(makeImageMock(), {});
        expect(tileUrl).toContain('v1alpha');
    });

    test('rejects on GEE error', async () => {
        mockEe.data.getMapId.mockImplementationOnce((params, cb) =>
            cb(null, 'Access denied')
        );
        await expect(getEeMapId(makeImageMock(), {})).rejects.toThrow('Access denied');
    });
});

// ── toEeGeometry ──────────────────────────────────────────────────────────────

describe('toEeGeometry', () => {
    test('returns Kon Tum region when geometry is null', () => {
        const geom = toEeGeometry(null);
        // Should call FeatureCollection('FAO/GAUL/2015/level1').filter().filter().geometry()
        expect(typeof geom).toBe('object');
    });

    test('converts bbox array [minX,minY,maxX,maxY] to ee.Geometry.BBox', () => {
        const geom = toEeGeometry([102, 13, 109, 16]);
        expect(mockEe.Geometry.BBox).toHaveBeenCalledWith(102, 13, 109, 16);
    });

    test('passes GeoJSON object straight to ee.Geometry', () => {
        const geoJson = { type: 'Polygon', coordinates: [[[102, 13], [109, 13], [109, 16], [102, 13]]] };
        const result = toEeGeometry(geoJson);
        expect(mockEe.Geometry).toHaveBeenCalledWith(geoJson);
        expect(result).toBeDefined();
    });
});

// ── fmtDate / todayUtc ────────────────────────────────────────────────────────

describe('date helpers', () => {
    test('fmtDate formats a Date object to YYYY-MM-DD', () => {
        const d = new Date('2024-06-15T12:00:00Z');
        expect(fmtDate(d)).toBe('2024-06-15');
    });

    test('fmtDate formats a date string', () => {
        expect(fmtDate('2024-01-01')).toBe('2024-01-01');
    });

    test('todayUtc returns YYYY-MM-DD format', () => {
        expect(todayUtc()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
});

// ── prepL57 / prepL89 ─────────────────────────────────────────────────────────

describe('Landsat band preparation', () => {
    test('prepL57 selects L5/7 bands and scales', () => {
        const img = makeImageMock();
        prepL57(img);
        expect(img.select).toHaveBeenCalledWith(
            ['SR_B1', 'SR_B2', 'SR_B3', 'SR_B4', 'SR_B5', 'SR_B7'],
            ['blue', 'green', 'red', 'nir', 'swir1', 'swir2'],
        );
        expect(img.multiply).toHaveBeenCalledWith(0.0000275);
    });

    test('prepL89 selects L8/9 bands and scales', () => {
        const img = makeImageMock();
        prepL89(img);
        expect(img.select).toHaveBeenCalledWith(
            ['SR_B2', 'SR_B3', 'SR_B4', 'SR_B5', 'SR_B6', 'SR_B7'],
            ['blue', 'green', 'red', 'nir', 'swir1', 'swir2'],
        );
    });
});

// ── maskS2 / maskS2FireRisk ───────────────────────────────────────────────────

describe('S2 masking', () => {
    test('maskS2 selects and renames optical bands', () => {
        const img = makeImageMock();
        maskS2(img);
        expect(img.select).toHaveBeenCalledWith(
            ['B2', 'B3', 'B4', 'B8', 'B11', 'B12'],
            ['blue', 'green', 'red', 'nir', 'swir1', 'swir2'],
        );
    });

    test('maskS2FireRisk keeps original B2-B12 band names', () => {
        const img = makeImageMock();
        maskS2FireRisk(img);
        expect(img.select).toHaveBeenCalledWith(['B2', 'B3', 'B4', 'B8', 'B11', 'B12']);
    });
});

// ── maskLandsatC2 ─────────────────────────────────────────────────────────────

describe('maskLandsatC2', () => {
    test('applies QA_PIXEL mask without throwing', () => {
        const img = makeImageMock();
        expect(() => maskLandsatC2(img)).not.toThrow();
        expect(img.select).toHaveBeenCalledWith('QA_PIXEL');
    });
});

// ── addIndices ────────────────────────────────────────────────────────────────

describe('addIndices', () => {
    test('returns an image with 8 index bands (empty prefix)', () => {
        const img = makeImageMock();
        addIndices(img, '');
        // Image.cat should be called with 8 images
        const catCall = mockEe.Image.cat.mock.calls[mockEe.Image.cat.mock.calls.length - 1][0];
        expect(catCall).toHaveLength(8);
    });

    test('prefixes band names when prefix is provided', () => {
        const img = makeImageMock();
        // Track calls to rename
        const renames = [];
        img.normalizedDifference = jest.fn(() => {
            const band = makeImageMock();
            band.rename = jest.fn((name) => { renames.push(name); return band; });
            return band;
        });
        img.expression = jest.fn(() => {
            const band = makeImageMock();
            band.rename = jest.fn((name) => { renames.push(name); return band; });
            return band;
        });
        addIndices(img, 'base');
        expect(renames.some((n) => n.startsWith('base_'))).toBe(true);
    });
});

// ── medianOrFallback ──────────────────────────────────────────────────────────

describe('medianOrFallback', () => {
    test('returns an image object without throwing', () => {
        const medianImg = makeImageMock();
        const col = {
            size:   jest.fn(() => ({ gt: jest.fn(() => 'sizeGt0') })),
            select: jest.fn().mockReturnThis(),
            median: jest.fn(() => medianImg),
        };
        mockEe.Algorithms.If.mockImplementationOnce((cond, a, b) => a);
        expect(() => medianOrFallback(col, ['B2', 'B3'], [0.1, 0.1])).not.toThrow();
    });
});
