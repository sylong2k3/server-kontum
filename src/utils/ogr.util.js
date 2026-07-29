'use strict';

/**
 * ogr.util.js — bọc ogr2ogr / ogrinfo (GDAL) qua child_process.spawn.
 *
 * An toàn:
 *  - Mọi đối số truyền dạng mảng (KHÔNG nội suy vào shell string).
 *  - Credential DB qua biến môi trường PGPASSWORD (không xuất hiện trong log).
 *  - filePath và table_name được whitelist trước khi truyền.
 *
 * Fallback: .geojson được xử lý native (không cần GDAL) qua PostGIS ST_GeomFromGeoJSON.
 * Yêu cầu môi trường cho các format khác: `gdal-bin` (ogr2ogr, ogrinfo) phải được cài sẵn.
 *   Docker: RUN apt-get install -y gdal-bin
 */

const { spawn } = require('child_process');
const fs         = require('fs');
const path       = require('path');
const { t }      = require('./i18n.util');

// ── Constants ─────────────────────────────────────────────────────────────────

const IDENTIFIER_RE     = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const SAFE_PATH_RE      = /^[\w\-. /\\:()[\]{}~]+$/;   // cho phép đường dẫn hệ thống thông thường (kể cả Windows 8.3 short path ~)
const GEOM_TYPE_MAP     = {
    point:           'POINT',
    multipoint:      'MULTIPOINT',
    linestring:      'LINESTRING',
    multilinestring: 'MULTILINESTRING',
    polygon:         'MULTIPOLYGON',      // PROMOTE_TO_MULTI nên polygon → multi
    multipolygon:    'MULTIPOLYGON',
    line:            'LINESTRING',
    multiline:       'MULTILINESTRING',
    geometrycollection: 'GEOMETRY',
    geometry:        'GEOMETRY',
    unknown:         'GEOMETRY',
    none:            'GEOMETRY',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const assertSafePath = (filePath) => {
    const resolved = path.resolve(filePath);
    if (!SAFE_PATH_RE.test(resolved)) {
        throw new Error(`ogr.util: unsafe file path: ${filePath}`);
    }
    return resolved;
};

const assertIdentifier = (value, label = 'identifier') => {
    if (!IDENTIFIER_RE.test(String(value || ''))) {
        throw new Error(`ogr.util: invalid ${label}: ${value}`);
    }
    return value;
};

const normalizeGeomType = (ogrType) => {
    if (!ogrType) { return 'GEOMETRY'; }
    const key = ogrType.toLowerCase()
        .replace(/\s+/g, '')
        .replace(/^multi/, 'multi')
        .replace(/curve/, 'linestring')
        .replace(/surface/, 'polygon')
        .replace(/solid/, 'geometry')
        .replace(/25d$/, '')
        .replace(/z$/, '');
    return GEOM_TYPE_MAP[key] || 'GEOMETRY';
};

/**
 * Chạy một child process và collect stdout/stderr.
 * @returns {Promise<{stdout: string, stderr: string, code: number}>}
 */
const runProcess = (cmd, args, env = {}) =>
    new Promise((resolve, reject) => {
        const child = spawn(cmd, args, {
            env: { ...process.env, ...env },
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (d) => { stdout += d.toString(); });
        child.stderr.on('data', (d) => { stderr += d.toString(); });

        child.on('error', (err) => {
            if (err.code === 'ENOENT') {
                reject(new Error(t('ogr_command_not_found', env.lang, { cmd })));
            } else {
                reject(err);
            }
        });

        child.on('close', (code) => resolve({ stdout, stderr, code }));
    });

// ── Build connection string ───────────────────────────────────────────────────

const buildPgConn = (lang = 'vi') => {
    const { DB_HOST, DB_PORT, DB_NAME, DB_USER } = process.env;
    if (!DB_HOST || !DB_NAME || !DB_USER) {
        throw new Error(t('ogr_db_config_required', lang));
    }
    return `PG:host=${DB_HOST} port=${DB_PORT || 5432} dbname=${DB_NAME} user=${DB_USER}`;
};

// ── Native GeoJSON fallback (không cần GDAL) ─────────────────────────────────

const inspectGeoJSON = (filePath) => {
    const gj = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const features = gj.type === 'FeatureCollection' ? gj.features : [gj];

    let geometryType = 'GEOMETRY';
    if (features.length > 0 && features[0].geometry) {
        geometryType = normalizeGeomType(features[0].geometry.type);
    }

    const layerName = path.basename(filePath, path.extname(filePath)).replace(/[^a-zA-Z0-9_]/g, '_').replace(/^(\d)/, '_$1');

    return {
        layerName,
        geometryType,
        epsgCode: 4326,
        featureCount: features.length,
        layers: [layerName],
    };
};

const loadGeoJSONToPostgis = async ({ filePath, schema, table, mode = 'overwrite', onProgress, lang = 'vi' }) => {
    const safeSchema = assertIdentifier(schema, 'schema');
    const safeTable  = assertIdentifier(table, 'table');

    const { getClient } = require('../configs/database');

    if (onProgress) { onProgress(5, t('ogr_prepare', lang)); }

    const gj = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const features = gj.type === 'FeatureCollection' ? gj.features : [gj];

    if (features.length === 0) {
        throw new Error(t('ogrinfo_failed', lang, { msg: 'GeoJSON has no features' }));
    }

    // Collect property keys (chỉ giữ tên hợp lệ làm identifier)
    const propKeySet = new Set();
    for (const f of features) {
        if (f.properties) { Object.keys(f.properties).forEach(k => propKeySet.add(k)); }
    }
    const propKeys = [...propKeySet].filter(k => IDENTIFIER_RE.test(k));

    // Xác định kiểu geometry từ feature đầu tiên có geometry
    // Dùng MULTI type để khớp với ST_Multi() khi INSERT
    const firstGeom = features.find(f => f.geometry);
    const baseGeomType = firstGeom ? normalizeGeomType(firstGeom.geometry.type) : 'GEOMETRY';
    const MULTI_PROMOTE = { POINT: 'MULTIPOINT', LINESTRING: 'MULTILINESTRING', POLYGON: 'MULTIPOLYGON' };
    const geomType = MULTI_PROMOTE[baseGeomType] || baseGeomType;

    if (onProgress) { onProgress(10, t('ogr_loading_postgis', lang)); }

    const client = await getClient();
    try {
        await client.query('BEGIN');

        if (mode === 'overwrite') {
            await client.query(`DROP TABLE IF EXISTS "${safeSchema}"."${safeTable}"`);
        }

        const colDefs = propKeys.map(c => `"${c}" TEXT`).join(', ');
        await client.query(`
            CREATE TABLE IF NOT EXISTS "${safeSchema}"."${safeTable}" (
                id   SERIAL PRIMARY KEY
                ${colDefs ? ', ' + colDefs : ''}
                , geom geometry(${geomType}, 4326)
            )
        `);

        const BATCH = 500;
        for (let i = 0; i < features.length; i += BATCH) {
            const batch = features.slice(i, i + BATCH);
            for (const feat of batch) {
                if (!feat.geometry) { continue; }
                const props = feat.properties || {};
                const vals  = propKeys.map(c => (props[c] != null ? String(props[c]) : null));
                const geomJson = JSON.stringify(feat.geometry);

                if (propKeys.length > 0) {
                    const colList   = propKeys.map(c => `"${c}"`).join(', ');
                    const paramList = propKeys.map((_, idx) => `$${idx + 1}`).join(', ');
                    await client.query(
                        `INSERT INTO "${safeSchema}"."${safeTable}" (${colList}, geom)
                         VALUES (${paramList}, ST_Multi(ST_GeomFromGeoJSON($${propKeys.length + 1})))`,
                        [...vals, geomJson],
                    );
                } else {
                    await client.query(
                        `INSERT INTO "${safeSchema}"."${safeTable}" (geom)
                         VALUES (ST_Multi(ST_GeomFromGeoJSON($1)))`,
                        [geomJson],
                    );
                }
            }
            if (onProgress) {
                onProgress(10 + Math.round(((i + batch.length) / features.length) * 65), t('ogr_loading_postgis', lang));
            }
        }

        await client.query(
            `CREATE INDEX IF NOT EXISTS "${safeTable}_geom_idx" ON "${safeSchema}"."${safeTable}" USING GIST(geom)`,
        );

        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }

    if (onProgress) { onProgress(80, t('ogr_load_completed', lang)); }
};

// ── Inspect (ogrinfo) ─────────────────────────────────────────────────────────

/**
 * Lấy thông tin lớp đầu tiên (hoặc `layerName` cụ thể) trong file geo.
 * .geojson dùng native parser (không cần GDAL).
 *
 * @param {string} filePath    - Đường dẫn tuyệt đối đến file (.zip/.geojson/.kml/.tif...)
 * @param {string} [layerName] - Tên layer con trong FileGDB/KML nhiều layer (không bắt buộc)
 * @returns {Promise<{
 *   layerName: string,
 *   geometryType: string,   // enum registry: POINT/MULTIPOLYGON/...
 *   epsgCode: number,
 *   featureCount: number,
 *   layers: string[],       // danh sách layer trong file
 * }>}
 */
const inspect = async (filePath, layerName = null, lang = 'vi') => {
    const safePath = assertSafePath(filePath);

    if (safePath.toLowerCase().endsWith('.geojson')) {
        return inspectGeoJSON(safePath);
    }

    // Lấy danh sách layers trước
    const listResult = await runProcess('ogrinfo', ['-al', '-so', safePath]);
    if (listResult.code !== 0 && !listResult.stdout) {
        throw new Error(t('ogrinfo_failed', lang, { msg: listResult.stderr.slice(0, 500) }));
    }

    const layers = [];
    const layerLineRe = /^Layer name:\s*(.+)/im;
    for (const line of listResult.stdout.split('\n')) {
        const m = line.match(/^(\S.+)\s+\((\w+)\)$/);
        if (m) { layers.push(m[1].trim()); }
        const m2 = line.match(layerLineRe);
        if (m2 && !layers.includes(m2[1].trim())) { layers.push(m2[1].trim()); }
    }

    // Chọn layer cần inspect
    const targetLayer = layerName || layers[0] || null;

    const args = ['-so', safePath];
    if (targetLayer) { args.push(targetLayer); }

    const result = await runProcess('ogrinfo', args);
    const out = result.stdout + result.stderr;

    // Parse geometry type
    const geomMatch = out.match(/Geometry:\s*(.+)/i);
    const rawGeomType = geomMatch ? geomMatch[1].trim() : 'Unknown';
    const geometryType = normalizeGeomType(rawGeomType);

    // Parse EPSG
    let epsgCode = 4326;
    const epsgMatch = out.match(/AUTHORITY\["EPSG","(\d+)"\]/i)
        || out.match(/EPSG:(\d+)/i)
        || out.match(/ID\["EPSG",\s*(\d+)\]/i);
    if (epsgMatch) { epsgCode = parseInt(epsgMatch[1], 10); }

    // Parse feature count
    let featureCount = 0;
    const countMatch = out.match(/Feature Count:\s*(\d+)/i);
    if (countMatch) { featureCount = parseInt(countMatch[1], 10); }

    return {
        layerName: targetLayer,
        geometryType,
        epsgCode,
        featureCount,
        layers: [...new Set(layers)],
    };
};

// ── Load to PostGIS (ogr2ogr hoặc native cho GeoJSON) ────────────────────────

/**
 * Nạp dữ liệu vector từ file vào bảng PostGIS.
 * .geojson dùng native loader (không cần GDAL).
 * Tự tạo bảng nếu chưa có (chế độ overwrite/-overwrite).
 *
 * @param {object} opts
 * @param {string}  opts.filePath        - Đường dẫn tuyệt đối đến file nguồn
 * @param {string}  opts.schema          - Schema đích (vd 'gis')
 * @param {string}  opts.table           - Tên bảng đích (vd 'ranh_gioi_rung')
 * @param {number}  [opts.sridInput]     - SRID nguồn nếu file không khai báo CRS (mặc định 4326)
 * @param {string}  [opts.mode]          - 'overwrite' | 'append' (mặc định 'overwrite')
 * @param {string}  [opts.sourceLayerName] - Layer con trong FileGDB/KML
 * @param {function} [opts.onProgress]   - callback(percent: number, message: string)
 * @returns {Promise<void>}
 */
const loadToPostgis = async ({
    filePath,
    schema,
    table,
    sridInput = 4326,
    mode = 'overwrite',
    sourceLayerName = null,
    onProgress = null,
    lang = 'vi',
} = {}) => {
    const safePath   = assertSafePath(filePath);
    const safeSchema = assertIdentifier(schema, 'schema');
    const safeTable  = assertIdentifier(table, 'table');

    if (safePath.toLowerCase().endsWith('.geojson')) {
        return loadGeoJSONToPostgis({ filePath: safePath, schema: safeSchema, table: safeTable, mode, onProgress, lang });
    }

    const connStr = buildPgConn(lang);

    if (onProgress) { onProgress(5, t('ogr_prepare', lang)); }

    // Xác định input dùng VSI nếu cần
    let inputPath = safePath;
    const lowerPath = safePath.toLowerCase();
    if ((lowerPath.endsWith('.zip') || lowerPath.endsWith('.kmz')) && !lowerPath.startsWith('/vsizip/')) {
        inputPath = `/vsizip/${safePath}`;
    }

    const args = [
        '-f', 'PostgreSQL',
        connStr,
        inputPath,
        '-nln', `${safeSchema}.${safeTable}`,
        '-t_srs', 'EPSG:4326',
        '-lco', 'GEOMETRY_NAME=geom',
        '-lco', `FID=id`,
        '-lco', `SCHEMA=${safeSchema}`,
        '-lco', 'SPATIAL_INDEX=GIST',
        '-nlt', 'PROMOTE_TO_MULTI',
        '-preserve_fid',
    ];

    // Chỉ định a_srs nếu file không có CRS
    if (sridInput && sridInput !== 4326) {
        args.push('-a_srs', `EPSG:${sridInput}`);
    }

    // Layer con (FileGDB / KML nhiều layer)
    if (sourceLayerName) { args.push(sourceLayerName); }

    // Import mode
    if (mode === 'append') {
        args.push('-append');
    } else {
        args.push('-overwrite');
    }

    if (onProgress) { onProgress(10, t('ogr_loading_postgis', lang)); }

    const result = await runProcess('ogr2ogr', args, {
        PGPASSWORD: process.env.DB_PASSWORD || '',
    });

    if (result.code !== 0) {
        const msg = (result.stderr || result.stdout).slice(0, 1000);
        throw new Error(t('ogr2ogr_failed', lang, { code: result.code, msg }));
    }

    if (onProgress) { onProgress(80, t('ogr_load_completed', lang)); }
};

// ── Availability check ────────────────────────────────────────────────────────

/**
 * Kiểm tra ogr2ogr có sẵn trong PATH không.
 * @returns {Promise<{available: boolean, version?: string}>}
 */
const checkAvailability = async () => {
    try {
        const result = await runProcess('ogr2ogr', ['--version']);
        if (result.code === 0 || result.stdout) {
            return { available: true, version: (result.stdout || result.stderr).split('\n')[0].trim() };
        }
        return { available: false };
    } catch {
        return { available: false };
    }
};

module.exports = {
    inspect,
    loadToPostgis,
    checkAvailability,
    normalizeGeomType,
};
