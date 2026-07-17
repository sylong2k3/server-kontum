/**
 * Diagnostic: đọc file huyện + in ra chi tiết feature/properties.
 *
 * Dùng: `node scripts/diag-districts.js`
 *
 * KHÔNG cần deploy code mới, không đụng DB, không gọi GEE.
 * Chỉ đọc file trên đĩa và in ra để biết cấu trúc thực tế.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.resolve(__dirname, '../data');
// HARD-CODED paths — không dùng env override nữa.
const paths = [
    path.join(DATA_DIR, 'RanhGioiHuyen_Polygon.geojson'),
];

console.log('\n══════════════════════════════════════════════════════════════');
console.log('  DISTRICTS FILE DIAGNOSTIC');
console.log('══════════════════════════════════════════════════════════════\n');

console.log('(HARD-CODED paths — không dùng env override)\n');

for (const p of paths) {
    console.log('─── Check:', p);
    if (!fs.existsSync(p)) {
        console.log('    ✗ NOT EXIST\n');
        continue;
    }
    const stat = fs.statSync(p);
    console.log(`    ✓ exists, size=${(stat.size / 1024).toFixed(1)} KB`);

    let doc;
    try {
        doc = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) {
        console.log('    ✗ JSON parse fail:', e.message, '\n');
        continue;
    }

    console.log(`    doc.type = ${doc?.type}`);
    console.log(`    doc.crs  = ${JSON.stringify(doc?.crs?.properties || doc?.crs || null)}`);
    const feats = Array.isArray(doc?.features) ? doc.features : [];
    console.log(`    feature count = ${feats.length}`);

    // Sample 3 features
    const empty = feats.filter((f) => {
        const c = f?.geometry?.coordinates;
        return !c || (Array.isArray(c) && c.length === 0);
    }).length;
    console.log(`    empty-coordinates count = ${empty}`);

    // Show all unique property KEYS (across all features)
    const keys = new Set();
    for (const f of feats) {
        for (const k of Object.keys(f?.properties || {})) keys.add(k);
    }
    console.log(`    unique property keys = [${Array.from(keys).sort().join(', ')}]`);

    // Sample first 3 features' properties
    console.log('    sample properties:');
    feats.slice(0, 3).forEach((f, i) => {
        const props = f?.properties || {};
        const geomType = f?.geometry?.type;
        const coordCount = countCoords(f?.geometry?.coordinates);
        console.log(`      [${i}] geom=${geomType} coords=${coordCount} props=${JSON.stringify(props).slice(0, 200)}`);
    });

    // Try the same field extraction that the loader uses
    console.log('    loader field extraction (first 5 features):');
    feats.slice(0, 5).forEach((f, i) => {
        const p = f?.properties || {};
        const name = p.NAME_VN || p.ADM2_NAME || p.NAME_2 || p.VARNAME_2 || p.NAME_EN || null;
        const code = p.CODE_2002 ?? p.ADM2_CODE ?? p.ID_2 ?? p.OBJECTID ?? null;
        console.log(`      [${i}] name="${name}" code="${code}"`);
    });

    console.log();
}

function countCoords(arr) {
    if (!arr) return 0;
    if (typeof arr[0] === 'number') return 1;
    let n = 0;
    for (const x of arr) n += countCoords(x);
    return n;
}

console.log('══════════════════════════════════════════════════════════════');
console.log('Kết luận:');
console.log('  • feature count phải là 9-18 (Kon Tum có ~10 huyện).');
console.log('  • unique keys phải chứa NAME_2 hoặc ADM2_NAME.');
console.log('  • loader extraction phải cho name/code KHÔNG null.');
console.log('  • empty-coordinates phải = 0.');
console.log('══════════════════════════════════════════════════════════════\n');
