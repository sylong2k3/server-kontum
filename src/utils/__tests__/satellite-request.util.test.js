'use strict';

const {
    normalizeParams,
    resolveClassifiedAnchor,
} = require('../satellite-request.util');

describe('satellite classified anchor', () => {
    test('derives both year and month from endDate by default', () => {
        const params = normalizeParams({
            startDate: '2025-12-20',
            endDate: '2026-07-29',
        });

        expect(params.month).toBe(7);
        expect(resolveClassifiedAnchor(params)).toEqual({
            year: 2026,
            month: 7,
        });
    });

    test('keeps a valid direct month override', () => {
        const params = normalizeParams({
            startDate: '2026-06-28',
            endDate: '2026-07-29',
            month: '6',
        });

        expect(params.month).toBe(6);
        expect(resolveClassifiedAnchor(params)).toEqual({
            year: 2026,
            month: 6,
        });
    });

    test('rejects a direct month outside 1..12', () => {
        const params = normalizeParams({
            startDate: '2026-06-28',
            endDate: '2026-07-29',
            month: 13,
        });

        expect(() => resolveClassifiedAnchor(params)).toThrow(
            'month phải là số nguyên từ 1 đến 12.',
        );
    });
});
