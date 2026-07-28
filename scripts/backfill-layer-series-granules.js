/**
 * Backfill: gộp 18 layer GeoTIFF rời rạc đã publish thủ công trước khi có
 * tính năng time-series (lop_phu_1991, nhietdobemat_2023, biendonglopphu_...,
 * dienbiennhietdo_...) vào 4 nhóm ImageMosaic mới (lop_phu, nhiet_do_be_mat,
 * bien_dong_lop_phu, dien_bien_nhiet_do).
 *
 * Cách làm: kéo từng raster gốc qua WCS GetCoverage (chỉ đọc, không đụng/xoá
 * store cũ) rồi gọi lại layer-series.service#ingestGranule y như API
 * `POST /map/layer-groups/:group/granules` — không cần chạy server HTTP,
 * không cần token.
 *
 * YÊU CẦU: biến môi trường GEOSERVER_DATA_DIR phải trỏ tới thư mục mà CHÍNH
 * process GeoServer đọc được (volume chia sẻ Docker/host) — script này phải
 * chạy TRÊN server đó (hoặc máy có mount chung), không chạy được từ máy dev
 * thông thường chỉ có GEOSERVER_URL trỏ ra ngoài.
 *
 * Idempotent: granule (group, year_from, year_to) đã tồn tại thì SKIP, trừ
 * khi truyền --force. Chạy lại an toàn nếu bị đứt giữa chừng.
 *
 * Dùng:
 *   node scripts/backfill-layer-series-granules.js
 *   node scripts/backfill-layer-series-granules.js --dry-run
 *   node scripts/backfill-layer-series-granules.js --only=lop_phu
 *   node scripts/backfill-layer-series-granules.js --force
 */
require('dotenv').config();

const db                = require('../src/configs/database');
const layerSeriesRepo   = require('../src/repositories/layer-series.repository');
const layerSeriesService = require('../src/services/layer-series.service');

const args    = process.argv.slice(2);
const FORCE   = args.includes('--force');
const DRY_RUN = args.includes('--dry-run');
const ONLY    = (args.find((a) => a.startsWith('--only=')) || '').split('=')[1] || null;

// Mapping store GeoTIFF cũ (publish thủ công qua GeoServer UI) -> nhóm time-series.
const SOURCES = [
    ...[1991, 2014, 2023].map((y) => (
        { store: `lop_phu_${y}`, group: 'lop_phu', yearFrom: y, yearTo: y }
    )),
    ...[1991, 2000, 2010, 2014, 2015, 2020, 2021, 2022, 2023].map((y) => (
        { store: `nhietdobemat_${y}`, group: 'nhiet_do_be_mat', yearFrom: y, yearTo: y }
    )),
    { store: 'biendonglopphu_1991_2014', group: 'bien_dong_lop_phu', yearFrom: 1991, yearTo: 2014 },
    { store: 'biendonglopphu_1991_2023', group: 'bien_dong_lop_phu', yearFrom: 1991, yearTo: 2023 },
    { store: 'biendonglopphu_2014_2023', group: 'bien_dong_lop_phu', yearFrom: 2014, yearTo: 2023 },
    { store: 'dienbiennhietdo_1991_2014', group: 'dien_bien_nhiet_do', yearFrom: 1991, yearTo: 2014 },
    { store: 'dienbiennhietdo_1991_2023', group: 'dien_bien_nhiet_do', yearFrom: 1991, yearTo: 2023 },
    { store: 'dienbiennhietdo_2014_2023', group: 'dien_bien_nhiet_do', yearFrom: 2014, yearTo: 2023 },
];

const GEOSERVER_URL = process.env.GEOSERVER_URL;
const WORKSPACE      = process.env.GEOSERVER_WORKSPACE || 'kontum';
const authHeader     = `Basic ${Buffer.from(`${process.env.GEOSERVER_USER}:${process.env.GEOSERVER_PASSWORD}`).toString('base64')}`;

const fmtMB = (bytes) => `${(bytes / 1048576).toFixed(1)}MB`;
const fmtLabel = (src) => `${src.store} → ${src.group} (${src.yearFrom === src.yearTo ? src.yearFrom : `${src.yearFrom}-${src.yearTo}`})`;

async function pullRasterViaWCS(storeName) {
    const url = `${GEOSERVER_URL}/${WORKSPACE}/wcs?service=WCS&version=2.0.1&request=GetCoverage`
        + `&coverageId=${WORKSPACE}__${storeName}&format=image/geotiff`;
    const res = await fetch(url, { headers: { Authorization: authHeader } });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`WCS GetCoverage thất bại (${res.status}): ${body.slice(0, 300)}`);
    }
    return Buffer.from(await res.arrayBuffer());
}

async function alreadyIngested(group, yearFrom, yearTo) {
    const layer = await layerSeriesRepo.findGroupByCode(group);
    if (!layer) { return false; }
    const granules = await layerSeriesRepo.listGranules(layer.id);
    return granules.some((g) => g.year_from === yearFrom && g.year_to === yearTo);
}

(async () => {
    const targets = ONLY ? SOURCES.filter((s) => s.group === ONLY) : SOURCES;

    console.log('\n══════════════════════════════════════════════════════════');
    console.log(`  BACKFILL layer-series granules — ${targets.length} store(s)${DRY_RUN ? ' [DRY RUN]' : ''}${FORCE ? ' [FORCE]' : ''}`);
    console.log('══════════════════════════════════════════════════════════\n');

    if (!DRY_RUN && !process.env.GEOSERVER_DATA_DIR) {
        console.error('GEOSERVER_DATA_DIR chưa cấu hình — script này phải chạy trên server có quyền ghi vào thư mục dữ liệu GeoServer (xem docs/guides/13-geoserver-postgis-setup-guide.md).');
        process.exit(1);
    }

    const results = { ok: [], skipped: [], failed: [] };

    for (const src of targets) {
        const label = fmtLabel(src);
        try {
            if (!FORCE && await alreadyIngested(src.group, src.yearFrom, src.yearTo)) {
                console.log(`  ⏭  SKIP  ${label} — đã có granule (dùng --force để ghi đè)`);
                results.skipped.push(src.store);
                continue;
            }

            if (DRY_RUN) {
                console.log(`  •  DRY   ${label}`);
                continue;
            }

            console.log(`  ⇣  Pull  ${label} qua WCS...`);
            const buf = await pullRasterViaWCS(src.store);
            console.log(`  ⇡  Ingest ${label} (${fmtMB(buf.length)})...`);

            await layerSeriesService.ingestGranule({
                group:    src.group,
                yearFrom: src.yearFrom,
                yearTo:   src.yearTo,
                fileBuffer: buf,
                user: null,
                lang: 'vi',
            });

            console.log(`  ✓  OK    ${label}`);
            results.ok.push(src.store);
        } catch (err) {
            console.error(`  ✗  FAIL  ${label} — ${err.message}`);
            results.failed.push({ store: src.store, error: err.message });
        }
    }

    console.log('\n──────────────────────────────────────────────────────────');
    console.log(`Kết quả: ${results.ok.length} OK, ${results.skipped.length} skip, ${results.failed.length} fail`);
    if (results.failed.length) {
        results.failed.forEach((f) => console.log(`  ✗ ${f.store}: ${f.error}`));
    }
    console.log('──────────────────────────────────────────────────────────\n');

    await db.pool.end();
    process.exit(results.failed.length ? 1 : 0);
})().catch(async (err) => {
    console.error('BACKFILL FAILED:', err.message);
    await db.pool.end().catch(() => {});
    process.exit(1);
});
