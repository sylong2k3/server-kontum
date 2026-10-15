'use strict';

jest.mock('fs', () => ({ readFileSync: jest.fn() }));
jest.mock('child_process', () => ({ spawn: jest.fn(() => { throw new Error('GDAL must not run for GeoJSON'); }) }));
jest.mock('../../configs/database', () => ({ getClient: jest.fn() }));

const fs = require('fs');
const { spawn } = require('child_process');
const db = require('../../configs/database');
const ogr = require('../ogr.util');

const point = { type: 'Point', coordinates: [108, 14.35] };
const polygon = { type: 'Polygon', coordinates: [[[108, 14], [109, 14], [109, 15], [108, 14]]] };
const feature = (geometry = point, properties = {}) => ({ type: 'Feature', properties, geometry });
const collection = (...features) => ({ type: 'FeatureCollection', features });
const filePath = 'C:/gis/upload.geojson';
let client;

beforeEach(() => {
    jest.clearAllMocks();
    fs.readFileSync.mockReturnValue(JSON.stringify(collection(feature())));
    client = { query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() };
    db.getClient.mockResolvedValue(client);
});

const source = (value) => fs.readFileSync.mockReturnValue(JSON.stringify(value));
const load = (options = {}) => ogr.loadToPostgis({ filePath, schema: 'gis', table: 'import_test', ...options });
const sqlCalls = () => client.query.mock.calls.map(([sql]) => sql);

test.each(['C:/gis/upload.json', 'C:/gis/upload.GEOJSON', 'D:/Code/@kt_web_GIS/ranh giới.geojson'])(
    'inspect and load %s natively without GDAL', async (input) => {
        await expect(ogr.inspect(input)).resolves.toMatchObject({ featureCount: 1, geometryType: 'MULTIPOINT', epsgCode: 4326 });
        await expect(load({ filePath: input })).resolves.toBeUndefined();
        expect(spawn).not.toHaveBeenCalled();
    },
);

test('UTF-8 BOM does not break a valid GeoJSON file', async () => {
    fs.readFileSync.mockReturnValue('\uFEFF' + JSON.stringify(collection(feature())));
    await expect(ogr.inspect(filePath)).resolves.toMatchObject({ featureCount: 1 });
    await expect(load()).resolves.toBeUndefined();
});

test.each([point, { type: 'GeometryCollection', geometries: [point, polygon] }])(
    'a top-level geometry is loaded rather than silently skipped: $type', async (geometry) => {
        source(geometry);
        await expect(ogr.inspect(filePath)).resolves.toMatchObject({ featureCount: 1 });
        await load();
        const inserts = client.query.mock.calls.filter(([sql]) => /INSERT INTO/.test(sql));
        expect(inserts).toHaveLength(1);
        expect(inserts[0][1]).toContain(JSON.stringify(geometry));
    },
);

test('mixed geometry families use GEOMETRY; null geometries retain their feature row', async () => {
    source(collection(feature(null, { name: 'unknown' }), feature(point), feature(polygon)));
    await expect(ogr.inspect(filePath)).resolves.toMatchObject({ featureCount: 3, geometryType: 'GEOMETRY' });
    await load();
    expect(sqlCalls().find(sql => /CREATE TABLE/.test(sql))).toContain('geometry(GEOMETRY, 4326)');
    expect(client.query.mock.calls.filter(([sql]) => /INSERT INTO/.test(sql))).toHaveLength(3);
});

test.each([
    null, {}, { type: 'FeatureCollection', features: {} }, collection(null),
    { type: 'Feature', properties: {}, geometry: { type: 'Unknown', coordinates: [] } },
])('invalid GeoJSON is rejected before opening a database transaction: %j', async (input) => {
    source(input);
    await expect(ogr.inspect(filePath)).rejects.toThrow(/GeoJSON/i);
    await expect(load()).rejects.toThrow(/GeoJSON/i);
    expect(db.getClient).not.toHaveBeenCalled();
});

test('empty collections fail before a table can be overwritten', async () => {
    source(collection());
    await expect(load()).rejects.toThrow(/GeoJSON/i);
    expect(db.getClient).not.toHaveBeenCalled();
});

test('source SRID is set and transformed into the canonical EPSG:4326', async () => {
    await load({ sridInput: 3857 });
    const [sql, params] = client.query.mock.calls.find(([statement]) => /INSERT INTO/.test(statement));
    expect(sql).toMatch(/ST_Transform\(ST_SetSRID\(ST_GeomFromGeoJSON\(/);
    expect(params).toContain(3857);
});

test.each(['id', 'geom'])('reserved property %s fails explicitly before overwrite, without silently dropping data', async (key) => {
    source(collection(feature(point, { [key]: 'source-value' })));
    await expect(load()).rejects.toThrow(new RegExp(key));
    expect(db.getClient).not.toHaveBeenCalled();
});

test('SQL failures roll back and release the client; append never drops the table', async () => {
    client.query.mockImplementation(async (sql) => {
        if (/INSERT INTO/.test(sql)) throw new Error('PostGIS rejected geometry');
        return { rows: [] };
    });
    await expect(load({ mode: 'append' })).rejects.toThrow('PostGIS rejected geometry');
    expect(sqlCalls()).toContain('ROLLBACK');
    expect(sqlCalls().some(sql => /DROP TABLE/.test(sql))).toBe(false);
    expect(client.release).toHaveBeenCalledTimes(1);
});

test('progress callbacks are awaited and cannot update a job after load resolves', async () => {
    let finished = false;
    const onProgress = jest.fn(async (percent) => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        if (percent === 80) finished = true;
    });
    await load({ onProgress });
    expect(finished).toBe(true);
});

test('single and multi geometries in the same family share a promoted column type', async () => {
    source(collection(feature(point), feature({ type: 'MultiPoint', coordinates: [[108, 14]] })));
    await expect(ogr.inspect(filePath)).resolves.toMatchObject({ geometryType: 'MULTIPOINT' });
    await load();
    expect(sqlCalls().find(sql => /CREATE TABLE/.test(sql))).toContain('geometry(MULTIPOINT, 4326)');
});

test('properties preserve zero, false, null, Unicode text and nested JSON', async () => {
    source(collection(feature(point, { count: 0, enabled: false, missing: null, name: 'Kon Tum – rừng', details: { class: 5 } })));
    await load();
    const [sql, params] = client.query.mock.calls.find(([statement]) => /INSERT INTO/.test(statement));
    expect(params).toEqual(['0', 'false', null, 'Kon Tum – rừng', '{"class":5}', JSON.stringify(point), 4326]);
    expect(sql).toContain('ST_GeomFromGeoJSON($6), $7');
});

test.each(['bad-name', 'a'.repeat(64), 'name"; DROP TABLE gis.layers; --'])(
    'unsupported property names fail before writes: %s', async (key) => {
        source(collection(feature(point, { [key]: 'value' })));
        await expect(load()).rejects.toThrow(/GeoJSON/);
        expect(db.getClient).not.toHaveBeenCalled();
    },
);

test('unsafe SQL identifiers and shell metacharacters remain rejected', async () => {
    await expect(load({ table: 'bad; DROP TABLE layers' })).rejects.toThrow(/invalid table/);
    await expect(load({ filePath: 'C:/gis/input;command.geojson' })).rejects.toThrow(/unsafe file path/);
    expect(db.getClient).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
});

test('rejected progress updates propagate without leaving an unhandled promise', async () => {
    await expect(load({ onProgress: async () => { throw new Error('progress update failed'); } }))
        .rejects.toThrow('progress update failed');
    expect(db.getClient).not.toHaveBeenCalled();
});
