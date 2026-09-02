'use strict';

const schemas = require('../map-layer.validator');

describe('map-layer.validator - legend_config', () => {
    const validBaseCreate = {
        code: 'test_layer',
        name_vi: 'Lớp thử nghiệm',
        table_name: 'test_layer',
        geometry_type: 'POLYGON',
    };

    test('accepts valid canonical legend_config with hex colors', () => {
        const payload = {
            ...validBaseCreate,
            legend_config: {
                entries: [
                    { label: 'Mặt nước', color: '#1A73E8' },
                    { label: 'Rừng', color: '#2D7B2E' },
                    { label: 'Cỏ', color: '#3A9' },
                ],
            },
        };

        const { error, value } = schemas.createLayer.validate(payload);
        expect(error).toBeUndefined();
        expect(value.legend_config.entries).toHaveLength(3);
    });

    test('accepts null legend_config to clear legend', () => {
        const payload = {
            ...validBaseCreate,
            legend_config: null,
        };

        const { error, value } = schemas.createLayer.validate(payload);
        expect(error).toBeUndefined();
        expect(value.legend_config).toBeNull();
    });

    test('accepts legend_config in updateLayer schema', () => {
        const updatePayload = {
            name_vi: 'Tên mới',
            legend_config: {
                entries: [{ label: 'Đất trống', color: '#F4B400' }],
            },
        };

        const { error, value } = schemas.updateLayer.validate(updatePayload);
        expect(error).toBeUndefined();
        expect(value.legend_config.entries).toHaveLength(1);
    });

    test('rejects non-hex color strings like "green"', () => {
        const payload = {
            ...validBaseCreate,
            legend_config: {
                entries: [{ label: 'Rừng', color: 'green' }],
            },
        };

        const { error } = schemas.createLayer.validate(payload);
        expect(error).toBeDefined();
    });

    test('rejects empty label', () => {
        const payload = {
            ...validBaseCreate,
            legend_config: {
                entries: [{ label: '   ', color: '#2D7B2E' }],
            },
        };

        const { error } = schemas.createLayer.validate(payload);
        expect(error).toBeDefined();
    });

    test('rejects empty entries array', () => {
        const payload = {
            ...validBaseCreate,
            legend_config: {
                entries: [],
            },
        };

        const { error } = schemas.createLayer.validate(payload);
        expect(error).toBeDefined();
    });

    test('rejects more than 50 entries', () => {
        const entries = Array.from({ length: 51 }, (_, i) => ({
            label: `Lớp ${i + 1}`,
            color: '#123456',
        }));

        const payload = {
            ...validBaseCreate,
            legend_config: { entries },
        };

        const { error } = schemas.createLayer.validate(payload);
        expect(error).toBeDefined();
    });

    test('rejects legacy arbitrary object shapes', () => {
        const payload = {
            ...validBaseCreate,
            legend_config: {
                type: 'rgb',
                bands: ['red', 'green', 'blue'],
            },
        };

        const { error } = schemas.createLayer.validate(payload);
        expect(error).toBeDefined();
    });
});
