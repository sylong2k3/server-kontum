'use strict';

/**
 * Backfill các GeoTIFF đã publish rời rạc vào bốn ImageMosaic time-series.
 * Chỉ đọc layer cũ bằng WCS; không xóa hay sửa CoverageStore nguồn.
 *
 * Yêu cầu: đã chạy migration 045 và GEOSERVER_DATA_DIR là thư mục dùng chung
 * với GeoServer. Chạy script trên server có thể truy cập thư mục đó.
 *
 * Dùng:
 *   node scripts/backfill-layer-series-granules.js
 *   node scripts/backfill-layer-series-granules.js --dry-run
 *   node scripts/backfill-layer-series-granules.js --only=lop_phu
 *   node scripts/backfill-layer-series-granules.js --force
 */
require('dotenv').config({ quiet: true });

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const db = require('../src/configs/database');
const repo = require('../src/repositories/layer-series.repository');
const service = require('../src/services/layer-series.service');

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const force = args.has('--force');
const onlyArg = [...args].find((arg) => arg.startsWith('--only='));
const only = onlyArg ? onlyArg.slice('--only='.length) : null;
const GROUP_ALIASES = { bien_dong_nhiet_do: 'dien_bien_nhiet_do' };
const ALLOWED_GROUPS = new Set([
    'lop_phu', 'nhiet_do_be_mat', 'bien_dong_lop_phu', 'dien_bien_nhiet_do',
]);

const sourceLayers = async () => {
    const { rows } = await db.query(
        `SELECT code, geoserver_layer, layer_group, data_year
         FROM gis.layer_registry
         WHERE geometry_type = 'RASTER'
           AND geoserver_layer IS NOT NULL
           AND deleted_at IS NULL
           AND layer_group = ANY($1::text[])
         ORDER BY layer_group, data_year, code`,
        [[...ALLOWED_GROUPS, ...Object.keys(GROUP_ALIASES)]]
    );

    return rows.map((row) => {
        const years = String(row.code).match(/(?:19|20)\d{2}/g)?.map(Number) || [];
        const yearFrom = years.length > 1 ? years[years.length - 2] : (years[0] || row.data_year);
        const yearTo = years.length ? years[years.length - 1] : row.data_year;
        return {
            ...row,
            group: GROUP_ALIASES[row.layer_group] || row.layer_group,
            yearFrom,
            yearTo,
        };
    }).filter((row) => row.yearFrom && row.yearTo && ALLOWED_GROUPS.has(row.group));
};

const wcsUrl = (layerFqn) => {
    const configured = String(process.env.GEOSERVER_URL || '').trim().replace(/\/+$/, '');
    if (!configured) { throw new Error('GEOSERVER_URL chưa cấu hình'); }
    const [workspace, name] = layerFqn.includes(':')
        ? layerFqn.split(':')
        : [process.env.GEOSERVER_WORKSPACE || 'kontum', layerFqn];
    const root = configured
        .replace(new RegExp(`/${workspace}/(?:wms|wcs)$`, 'i'), '')
        .replace(/\/(?:wms|wcs)$/i, '');
    const query = new URLSearchParams({
        service: 'WCS', version: '2.0.1', request: 'GetCoverage',
        coverageId: `${workspace}__${name}`, format: 'image/tiff',
    });
    return `${root}/${workspace}/wcs?${query.toString()}`;
};

const download = async (url, target) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number(process.env.GEOSERVER_WCS_TIMEOUT_MS || 120000));
    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok || !response.body) {
            throw new Error(`WCS ${response.status}: ${(await response.text()).slice(0, 300)}`);
        }
        await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(target));
    } finally {
        clearTimeout(timeout);
    }
};

const main = async () => {
    const layers = (await sourceLayers()).filter((row) => !only || row.group === only);
    if (only && !ALLOWED_GROUPS.has(only)) {
        throw new Error(`--only không hợp lệ: ${only}`);
    }
    console.log(`[BACKFILL] ${layers.length} granule${dryRun ? ' (dry-run)' : ''}`);

    for (const source of layers) {
        const tag = `${source.group} ${source.yearFrom}-${source.yearTo}`;
        const url = wcsUrl(source.geoserver_layer);
        if (dryRun) {
            console.log(`[PLAN] ${tag} <- ${source.geoserver_layer}`);
            continue;
        }

        const group = await repo.findGroupByCode(source.group);
        if (!group) { throw new Error(`Chưa có group ${source.group}; chạy npm run migrate`); }
        const existing = await repo.findGranule(group.id, source.yearFrom, source.yearTo);
        if (existing && !force) {
            console.log(`[SKIP] ${tag}`);
            continue;
        }

        const temp = path.join(os.tmpdir(), `kontum_series_${process.pid}_${Date.now()}.tif`);
        try {
            console.log(`[GET ] ${tag} <- ${source.geoserver_layer}`);
            await download(url, temp);
            await service.ingestGranule({
                groupCode: source.group,
                file: { path: temp, originalname: `${source.code}.tif` },
                payload: {
                    year_from: source.yearFrom,
                    year_to: source.yearTo,
                    label: source.yearFrom === source.yearTo
                        ? String(source.yearFrom)
                        : `${source.yearFrom}–${source.yearTo}`,
                    source_layer: source.geoserver_layer,
                    source_url: url,
                    force,
                },
                user: null,
                lang: 'vi',
            });
            console.log(`[DONE] ${tag}`);
        } finally {
            await fs.promises.unlink(temp).catch(() => {});
        }
    }
};

main()
    .catch((error) => { console.error(`[FAIL] ${error.stack || error.message}`); process.exitCode = 1; })
    .finally(() => db.pool.end());
