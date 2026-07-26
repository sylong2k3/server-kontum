#!/usr/bin/env node
'use strict';

/**
 * Reset Fire Risk + Forest Classification snapshot data.
 *
 * Chỉ đụng vào DB — KHÔNG xoá:
 *   • ground truth (fire_gt_*, forest_gt_*)
 *   • satellite.image_results (cache tile GEE on-demand)
 *   • MinIO objects, GeoServer layers, gis.layer_registry rows
 *
 * Dùng khi cần fresh start trước khi apply migration 040 (schema mới), hoặc
 * bất kỳ lúc nào muốn dọn snapshot cũ trước khi chạy lại pipeline chính thức.
 *
 * Chạy:
 *   node scripts/reset-fire-forest-data.js               # in ra số row sẽ xoá + hỏi confirm
 *   node scripts/reset-fire-forest-data.js --yes         # skip confirm
 *   node scripts/reset-fire-forest-data.js --dry-run     # chỉ đếm, không xoá
 *
 * Trước khi chạy: đảm bảo dev/staging DB, KHÔNG chạy trên prod trừ khi có backup.
 */

const path   = require('path');
const readline = require('readline');

require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const db = require('../src/configs/database');

const args = process.argv.slice(2);
const AUTO_YES  = args.includes('--yes') || args.includes('-y');
const DRY_RUN   = args.includes('--dry-run');

const TABLES = [
    // Bảng con trước, cha sau (để CASCADE không cần thiết).
    { schema: 'fire',   table: 'fire_risk_features'         },
    { schema: 'fire',   table: 'fire_risk_district_exports' }, // migration 040
    { schema: 'fire',   table: 'fire_risk_snapshots'        },
    { schema: 'forest', table: 'forest_district_areas'      },
    { schema: 'forest', table: 'forest_district_exports'    }, // migration 040
    { schema: 'forest', table: 'forest_snapshots'           },
];

const RASTER_INGEST_DELETE_SQL = `
    DELETE FROM gis.raster_ingest_jobs
    WHERE COALESCE(
              request_params #>> '{linkedResource,type}',
              request_params #>> '{linked_resource,type}'
          ) IN ('fire_risk', 'forest', 'forest_classification',
                'fire_risk_district', 'forest_district')
       OR LEFT(layer_code, 10) = 'fire_risk_'
       OR LEFT(layer_code, 13) = 'forest_class_'
`;

function ask(q) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(q, (a) => { rl.close(); resolve(a.trim().toLowerCase()); });
    });
}

async function tableExists(schema, table) {
    const { rows } = await db.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2`,
        [schema, table],
    );
    return rows.length > 0;
}

async function countRows(schema, table) {
    if (!(await tableExists(schema, table))) return null;
    const { rows } = await db.query(`SELECT COUNT(*)::int AS n FROM ${schema}.${table}`);
    return rows[0].n;
}

async function countRasterIngest() {
    const { rows } = await db.query(
        RASTER_INGEST_DELETE_SQL.replace(/^\s*DELETE FROM/, 'SELECT COUNT(*)::int AS n FROM'),
    );
    return rows[0]?.n ?? 0;
}

async function main() {
    const banner = DRY_RUN ? '[DRY RUN] ' : '';
    console.log(`\n${banner}Fire Risk + Forest Classification data reset\n`);

    // ── Count phase ─────────────────────────────────────────────────────────
    const counts = {};
    for (const { schema, table } of TABLES) {
        counts[`${schema}.${table}`] = await countRows(schema, table);
    }
    const rasterIngestCount = await countRasterIngest();

    console.log('Sẽ xoá:');
    for (const [key, n] of Object.entries(counts)) {
        if (n === null) console.log(`  · ${key.padEnd(45)}  (bảng chưa tồn tại)`);
        else            console.log(`  · ${key.padEnd(45)}  ${n} rows`);
    }
    console.log(`  · gis.raster_ingest_jobs (fire/forest linked)  ${rasterIngestCount} rows\n`);

    console.log('KHÔNG bị đụng vào:');
    console.log('  · fire.fire_gt_zones / fire.fire_gt_points');
    console.log('  · forest.forest_gt_zones / forest.forest_gt_points');
    console.log('  · satellite.image_results');
    console.log('  · MinIO objects / GeoServer layers / gis.layer_registry\n');

    const totalRows = Object.values(counts).reduce((a, b) => a + (b || 0), 0) + rasterIngestCount;
    if (totalRows === 0) {
        console.log('Không có row nào để xoá. Exit.');
        await db.pool.end();
        return;
    }

    if (DRY_RUN) {
        console.log('[DRY RUN] Không thực hiện DELETE/TRUNCATE.\n');
        await db.pool.end();
        return;
    }

    // ── Confirm ─────────────────────────────────────────────────────────────
    if (!AUTO_YES) {
        const dbLabel = `${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`;
        const ans = await ask(`Xác nhận xoá trên DB "${dbLabel}"? (yes/no) `);
        if (ans !== 'yes' && ans !== 'y') {
            console.log('Huỷ.');
            await db.pool.end();
            process.exit(1);
        }
    }

    // ── Delete phase (1 transaction) ────────────────────────────────────────
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        console.log('\nBEGIN transaction…');

        // Ingest job trước (không FK cứng, xoá trước để tránh dedupe partial UNIQUE).
        const { rowCount: ingestDeleted } = await client.query(RASTER_INGEST_DELETE_SQL);
        console.log(`  gis.raster_ingest_jobs          → ${ingestDeleted} deleted`);

        // Snapshot + con: dùng TRUNCATE để nhanh + reset SEQUENCE.
        // Liệt kê full 6 bảng, có CASCADE để phòng FK phát sinh về sau.
        const truncatableTables = [];
        for (const { schema, table } of TABLES) {
            if (await tableExists(schema, table)) truncatableTables.push(`${schema}.${table}`);
        }
        if (truncatableTables.length > 0) {
            const sql = `TRUNCATE TABLE ${truncatableTables.join(', ')} RESTART IDENTITY CASCADE`;
            await client.query(sql);
            for (const t of truncatableTables) console.log(`  ${t.padEnd(45)} → TRUNCATED`);
        }

        await client.query('COMMIT');
        console.log('COMMIT ✓\n');
        console.log('Reset xong. Chạy migration 040 nếu chưa để cài schema mới.');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('ROLLBACK ✗', err.message);
        process.exitCode = 1;
    } finally {
        client.release();
        await db.pool.end();
    }
}

main().catch((err) => {
    console.error('Fatal:', err.message);
    if (process.env.NODE_ENV === 'development') console.error(err.stack);
    process.exit(1);
});
