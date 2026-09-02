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

describe('map-layer.validator - default_style', () => {
    const validBaseCreate = {
        code: 'style_layer',
        name_vi: 'Lớp style',
        table_name: 'style_layer',
        geometry_type: 'POLYGON',
    };

    test('accepts the canonical polygon style', () => {
        const { error, value } = schemas.createLayer.validate({
            ...validBaseCreate,
            default_style: {
                fillColor: '#f0f0f0',
                fillOpacity: 0.15,
                strokeColor: '#333333',
                strokeWidth: 2,
                lineCap: 'round',
                lineJoin: 'round',
            },
        });
        expect(error).toBeUndefined();
        expect(value.default_style.fillOpacity).toBe(0.15);
    });

    test('accepts line and raster properties', () => {
        expect(schemas.createLayer.validate({
            ...validBaseCreate,
            geometry_type: 'LINESTRING',
            default_style: {
                strokeDasharray: [2, 2],
                lineCap: 'square',
                lineJoin: 'bevel',
            },
        }).error).toBeUndefined();
        expect(schemas.createLayer.validate({
            ...validBaseCreate,
            geometry_type: 'RASTER',
            default_style: {
                opacity: 0.5,
                brightnessMin: 0.1,
                brightnessMax: 0.9,
                contrast: 0.2,
                saturation: -0.2,
                hueRotate: 45,
                fadeDuration: 250,
                resampling: 'nearest',
            },
        }).error).toBeUndefined();
    });

    test('accepts null style and update payload', () => {
        expect(schemas.createLayer.validate({ ...validBaseCreate, default_style: null }).error).toBeUndefined();
        expect(schemas.updateLayer.validate({ default_style: { strokeColor: '#123456', strokeWidth: 3 } }).error).toBeUndefined();
    });

    test.each([
        ['invalid hex color', { fillColor: 'green' }],
        ['opacity outside range', { fillOpacity: 1.2 }],
        ['negative width', { strokeWidth: -1 }],
        ['invalid line cap', { lineCap: 'dotted' }],
        ['invalid dash array', { strokeDasharray: [2, -1] }],
        ['unknown key', { fillPattern: 'dots' }],
    ])('rejects %s', (_label, default_style) => {
        const { error } = schemas.createLayer.validate({ ...validBaseCreate, default_style });
        expect(error).toBeDefined();
    });
});
