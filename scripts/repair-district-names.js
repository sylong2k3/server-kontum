#!/usr/bin/env node
'use strict';

/**
 * Sửa các row snapshot cũ đang lưu district_code='KT-<N>' và
 * district_name='Huyện <N>' — hậu quả của loader `getKonTumDistricts` chỉ
 * đọc key GADM (ADM2_CODE/ADM2_NAME) trong khi file
 * `data/RanhGioiHuyen_Polygon.geojson` dùng key tiếng Việt (ma_huyen/ten_huyen).
 *
 * Loader iterate features theo thứ tự file. Sau khi fix loader, snapshot mới
 * sẽ đúng. Với snapshot cũ, script này rebuild mapping N→(ma_huyen, ten_huyen)
 * bằng cách iterate cùng file rồi UPDATE các bảng:
 *   • forest.forest_district_areas
 *   • forest.forest_district_exports
 *   • fire.fire_risk_district_exports
 *
 * Cách chạy:
 *   node scripts/repair-district-names.js               # dry-run mặc định
 *   node scripts/repair-district-names.js --apply       # thực sự UPDATE
 *   node scripts/repair-district-names.js --apply --yes # skip confirm
 */

const fs   = require('fs');
const path = require('path');
const readline = require('readline');

require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const db = require('../src/configs/database');

const args = process.argv.slice(2);
const APPLY    = args.includes('--apply');
const AUTO_YES = args.includes('--yes') || args.includes('-y');

const DISTRICTS_FILE = path.resolve(__dirname, '../data/RanhGioiHuyen_Polygon.geojson');

// Same logic as gee-satellite.util.js loader (post-fix). Giữ đồng bộ để mapping
// N ↔ feature index khớp với cả code cũ (fallback KT-N) và code mới.
function readDistricts() {
    const doc = JSON.parse(fs.readFileSync(DISTRICTS_FILE, 'utf8'));
    if (doc.type !== 'FeatureCollection' || !Array.isArray(doc.features)) {
        throw new Error('File không phải FeatureCollection hợp lệ');
    }
    const seen = new Set();
    const out  = [];
    let idx = 0;
    for (const f of doc.features) {
        const g = f?.geometry;
        if (!g || !Array.isArray(g.coordinates) || g.coordinates.length === 0) continue;
        const p = f.properties || {};
        const rawName = p.NAME_VN || p.ADM2_NAME || p.NAME_2 || p.VARNAME_2
            || p.NAME_EN || p.ten_huyen || p.ten || null;
        const rawCode = p.CODE_2002 ?? p.ADM2_CODE ?? p.ID_2 ?? p.OBJECTID
            ?? p.ma_huyen ?? null;
        const name = rawName || `Huyện ${idx + 1}`;
        const code = rawCode != null && rawCode !== '' ? String(rawCode) : `KT-${idx + 1}`;
        const dedupeKey = String(rawCode ?? '') || `name:${name.toLowerCase()}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        idx += 1;
        out.push({ n: idx, code, name });
    }
    return out;
}

async function confirm(message) {
    if (AUTO_YES) return true;
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(`${message} (yes/no) `, (answer) => {
            rl.close();
            resolve(String(answer).trim().toLowerCase() === 'yes');
        });
    });
}

const TABLES = [
    { schema: 'forest', table: 'forest_district_areas'   },
    { schema: 'forest', table: 'forest_district_exports' },
    { schema: 'fire',   table: 'fire_risk_district_exports' },
];

async function countBroken(table) {
    const { rows } = await db.query(
        `SELECT COUNT(*)::int AS n
         FROM ${table}
         WHERE district_code LIKE 'KT-%' OR district_name LIKE 'Huyện %'`
    );
    return rows[0].n;
}

async function repairTable(table, mapping) {
    const perDistrict = [];
    let updated = 0;

    for (const d of mapping) {
        const oldCode = `KT-${d.n}`;
        const oldName = `Huyện ${d.n}`;
        // Match theo cả 2 (code hoặc name) — có snapshot có thể chỉ 1 field bị lỗi.
        const query = APPLY
            ? `UPDATE ${table}
               SET district_code = $1,
                   district_name = $2
               WHERE district_code = $3 OR district_name = $4
               RETURNING id`
            : `SELECT id FROM ${table}
               WHERE district_code = $3 OR district_name = $4`;
        const values = APPLY ? [d.code, d.name, oldCode, oldName] : [null, null, oldCode, oldName];
        const { rows } = await db.query(query, values);
        perDistrict.push({ n: d.n, oldCode, oldName, newCode: d.code, newName: d.name, rows: rows.length });
        updated += rows.length;
    }
    return { updated, perDistrict };
}

async function main() {
    console.log(`[REPAIR] Districts file: ${DISTRICTS_FILE}`);
    const mapping = readDistricts();
    console.log(`[REPAIR] Đọc ${mapping.length} huyện từ file:`);
    for (const d of mapping) {
        console.log(`  KT-${d.n} / "Huyện ${d.n}"  ->  ${d.code} / ${d.name}`);
    }

    console.log('');
    console.log(`[REPAIR] Đếm rows bị lỗi trước khi ${APPLY ? 'UPDATE' : 'dry-run'}:`);
    for (const t of TABLES) {
        const table = `${t.schema}.${t.table}`;
        const n = await countBroken(table);
        console.log(`  ${table.padEnd(42)}  ${n} rows`);
    }

    if (APPLY) {
        console.log('');
        const ok = await confirm('APPLY UPDATE trên các bảng trên?');
        if (!ok) { console.log('[REPAIR] Đã huỷ.'); return; }
    }

    console.log('');
    console.log(`[REPAIR] ${APPLY ? 'UPDATE' : 'DRY-RUN'}:`);
    for (const t of TABLES) {
        const table = `${t.schema}.${t.table}`;
        const result = await repairTable(table, mapping);
        console.log(`  ${table.padEnd(42)}  ${result.updated} rows ${APPLY ? 'updated' : 'would be updated'}`);
        for (const line of result.perDistrict) {
            if (line.rows > 0) {
                console.log(`    · ${line.oldCode.padEnd(6)} → ${line.newCode.padEnd(6)}  (${line.rows} rows)`);
            }
        }
    }

    if (!APPLY) {
        console.log('');
        console.log('[REPAIR] Đây là dry-run. Chạy lại với --apply để thực thi.');
    }
}

main()
    .catch((err) => { console.error('[REPAIR] FAIL:', err.stack || err.message); process.exitCode = 1; })
    .finally(() => db.pool.end());
