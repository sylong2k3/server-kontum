'use strict';
/**
 * Script đăng ký và publish 8 lớp GIS vào layer_registry + GeoServer.
 * Chạy: node register-and-publish.js
 */
require('dotenv').config();

const db        = require('./src/configs/database');
const layerRepo = require('./src/repositories/map-layer.repository');
const geoserver = require('./src/utils/geoserver.client');
const { geoserverConfig } = require('./src/configs/geoserver');

// ── Định nghĩa 8 lớp ─────────────────────────────────────────────────────────
// Tất cả từ GDB, SRID 32648 (UTM Zone 48N), geometry column: Shape
const LAYERS = [
    {
        code:           'ao_ho',
        table_name:     'AoHo',
        name_vi:        'Ao, hồ',
        geometry_type:  'MULTIPOLYGON',
        label_field:    'Ten',
        category:       'thuy_van',
        layer_group:    'thuy_van',
    },
    {
        code:           'duong_quoc_lo',
        table_name:     'DuongQuocLo',
        name_vi:        'Đường quốc lộ',
        geometry_type:  'MULTILINESTRING',
        label_field:    'Ten_duong',
        category:       'giao_thong',
        layer_group:    'giao_thong',
    },
    {
        code:           'duong_tinh_lo',
        table_name:     'DuongTinhLo',
        name_vi:        'Đường tỉnh lộ',
        geometry_type:  'MULTILINESTRING',
        label_field:    'Ten_duong',
        category:       'giao_thong',
        layer_group:    'giao_thong',
    },
    {
        code:           'ranh_gioi_huyen',
        table_name:     'RanhGioiHuyen',
        name_vi:        'Ranh giới huyện',
        geometry_type:  'MULTILINESTRING',
        label_field:    'NAME_VN',
        category:       'hanh_chinh',
        layer_group:    'ranh_gioi_hanh_chinh',
    },
    {
        code:           'ranh_gioi_tinh_polygon',
        table_name:     'RanhGioiTinh_Polygon',
        name_vi:        'Ranh giới tỉnh (vùng)',
        geometry_type:  'MULTIPOLYGON',
        label_field:    'Ten_tinh',
        category:       'hanh_chinh',
        layer_group:    'ranh_gioi_hanh_chinh',
    },
    {
        code:           'ranh_gioi_tinh_polyline',
        table_name:     'RanhGioiTinh_Polyline',
        name_vi:        'Ranh giới tỉnh (đường)',
        geometry_type:  'MULTILINESTRING',
        label_field:    'Ten_tinh',
        category:       'hanh_chinh',
        layer_group:    'ranh_gioi_hanh_chinh',
    },
    {
        code:           'song_suoi',
        table_name:     'SongSuoi',
        name_vi:        'Sông, suối',
        geometry_type:  'MULTILINESTRING',
        label_field:    'Ten',
        category:       'thuy_van',
        layer_group:    'thuy_van',
    },
    {
        code:           'uy_ban_nhan_dan',
        table_name:     'UyBanNhanDan',
        name_vi:        'Uỷ ban nhân dân',
        geometry_type:  'POINT',
        label_field:    'NAME_VN',
        category:       'hanh_chinh',
        layer_group:    'hanh_chinh',
    },
];

const COMMON = {
    schema_name:    'gis',
    geometry_column: 'Shape',
    epsg_code:      32648,
    is_active:      true,
    is_public:      true,
    is_editable:    false,
    layer_kind:     'overlay',
    sort_order:     0,
};

const log  = (msg) => console.log(`  ${msg}`);
const ok   = (msg) => console.log(`  ✓ ${msg}`);
const warn = (msg) => console.log(`  ⚠ ${msg}`);
const err  = (msg) => console.log(`  ✗ ${msg}`);

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
    console.log('\n══════════════════════════════════════════════');
    console.log('  Đăng ký + Publish 8 lớp GIS lên GeoServer');
    console.log('══════════════════════════════════════════════\n');

    // 0. Kiểm tra GeoServer
    log('Kiểm tra GeoServer...');
    const gsOk = await geoserver.healthCheck();
    if (!gsOk) {
        warn('GeoServer chưa kết nối được — sẽ chỉ đăng ký registry, bỏ qua publish');
    } else {
        ok(`GeoServer kết nối thành công (${process.env.GEOSERVER_URL})`);
    }

    // 1. Xóa phantom ranh_gioi_rung (không có bảng vật lý)
    console.log('\n[1] Dọn phantom layers...');
    const phantom = await layerRepo.findByCode('ranh_gioi_rung');
    if (phantom && !await layerRepo.physicalTableExists('gis', 'ranh_gioi_rung')) {
        if (phantom.geoserver_layer) {
            await geoserver.unpublishLayer(phantom.geoserver_layer).catch(() => {});
        }
        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');
            await layerRepo.deleteLayer(client, 'ranh_gioi_rung');
            await client.query('COMMIT');
            ok('Xóa phantom ranh_gioi_rung');
        } finally { client.release(); }
    } else {
        log('Không có phantom cần dọn');
    }

    // 2. Upsert tất cả 8 lớp
    console.log('\n[2] Đăng ký layer_registry...');
    const registered = [];
    for (const def of LAYERS) {
        const payload = { ...COMMON, ...def };
        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');

            // Kiểm tra bảng vật lý
            const exists = await layerRepo.physicalTableExists(payload.schema_name, payload.table_name, client);
            if (!exists) {
                warn(`Bỏ qua ${def.code}: bảng gis."${def.table_name}" không tồn tại`);
                await client.query('ROLLBACK');
                client.release();
                continue;
            }

            const row = await layerRepo.upsertLayerByCode(client, { ...payload, userId: null });
            await client.query('COMMIT');
            registered.push(row);
            ok(`${def.code} → gis."${def.table_name}" (id=${row.id}, gs=${row.geoserver_layer || 'chưa publish'})`);
        } catch (e) {
            await client.query('ROLLBACK');
            err(`${def.code}: ${e.message}`);
        } finally {
            client.release();
        }
    }

    // 3. Publish lên GeoServer
    console.log('\n[3] Publish lên GeoServer...');
    if (!gsOk) {
        warn('Bỏ qua publish (GeoServer không kết nối được)');
    } else {
        for (const layer of registered) {
            if (layer.geoserver_layer) {
                ok(`${layer.code} đã publish sẵn → ${layer.geoserver_layer}`);
                continue;
            }
            try {
                const gsName = await geoserver.publishVectorLayer(layer);
                const client = await db.pool.connect();
                try {
                    await layerRepo.markPublished(client, {
                        code:           layer.code,
                        geoserverLayer: gsName,
                        geoserverStore: geoserverConfig.datastore,
                        updatedBy:      null,
                    });
                } finally { client.release(); }
                ok(`${layer.code} → published: ${gsName}`);
            } catch (e) {
                err(`${layer.code}: publish thất bại — ${e.message}`);
            }
        }
    }

    // 4. Kết quả cuối
    console.log('\n[4] Kết quả layer_registry...');
    const final = await db.query(`
        SELECT code, table_name, geometry_type, epsg_code, geometry_column,
               geoserver_layer, is_active, is_public, feature_count
        FROM gis.layer_registry
        ORDER BY code
    `);
    console.log('');
    console.log('  Code                      | Table                    | GeomType        | GeoServer layer           | fc');
    console.log('  ' + '─'.repeat(100));
    final.rows.forEach(r => {
        const gs = r.geoserver_layer ? `✓ ${r.geoserver_layer}` : '✗ chưa publish';
        console.log(`  ${r.code.padEnd(25)} | ${r.table_name.padEnd(24)} | ${r.geometry_type.padEnd(15)} | ${gs.padEnd(25)} | ${r.feature_count}`);
    });

    console.log('\n══ Hoàn tất ══\n');
    process.exit(0);
})().catch(e => {
    console.error('\nLỗi không mong đợi:', e.message);
    process.exit(1);
});
