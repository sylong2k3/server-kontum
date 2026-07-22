require('dotenv').config();
const db = require('../../configs/database');

// ============================================================================
// Seed 003: DỮ LIỆU ĐO ĐẠC THỰC ĐỊA (gis.monitored_areas + gis.field_measurements)
//
// Xóa sạch dữ liệu test cũ, bổ sung dữ liệu mô phỏng thực tế tỉnh Kon Tum.
// 5 khu vực theo dõi × 8 phiên đo với đủ trạng thái (draft/submitted/verified/rejected).
// commune_code dùng mã GSO cấp huyện (từ gis.administrative_units).
// ============================================================================

(async () => {
    try {
        console.log('=== Seed 003: field_measurements ===\n');

        // ── Lấy user IDs ──────────────────────────────────────────────────────
        const userRes = await db.query(`
            SELECT u.id, r.code as role_code
            FROM auth.users u JOIN auth.roles r ON u.role_id = r.id
            WHERE u.deleted_at IS NULL
        `);
        const users = userRes.rows;
        const admin  = users.find(u => u.role_code === 'system_admin')?.id || users[0].id;
        const sonn   = users.find(u => u.role_code === 'so_nnmt')?.id    || users[0].id;
        console.log(`  admin=${admin}, sonn=${sonn}`);

        // ── 1. Xóa dữ liệu cũ ────────────────────────────────────────────────
        console.log('\n[1] Xóa dữ liệu cũ...');
        await db.query('TRUNCATE TABLE gis.field_measurement_photos RESTART IDENTITY CASCADE');
        await db.query('TRUNCATE TABLE gis.field_measurements RESTART IDENTITY CASCADE');
        await db.query('TRUNCATE TABLE gis.monitored_areas RESTART IDENTITY CASCADE');
        console.log('    OK — đã xóa 3 bảng.');

        // ── 2. monitored_areas ────────────────────────────────────────────────
        console.log('\n[2] Insert monitored_areas...');
        const areasData = [
            {
                code:         'KV-2026-001',
                name:         'Khu vực rừng phòng hộ sông Krông Pô Kô',
                commune_code: '616',  // Huyện Sa Thầy
                note:         'Giáp suối Krông Pô Kô, nghi ngờ khai thác gỗ trái phép nhiều lần',
                // Polygon ~2.1 ha, trung tâm lng=107.770 lat=14.350
                wkt: 'POLYGON((107.7693 14.3506, 107.7700 14.3512, 107.7710 14.3508, 107.7712 14.3494, 107.7702 14.3486, 107.7691 14.3492, 107.7693 14.3506))',
            },
            {
                code:         'KV-2026-002',
                name:         'Vùng giáp ranh Vườn quốc gia Chư Mom Ray',
                commune_code: '616',  // Huyện Sa Thầy
                note:         'Đường mòn dân sinh cắt qua, canh tác nương rẫy lấn vào ranh vườn quốc gia',
                wkt: 'POLYGON((107.6531 14.2026, 107.6539 14.2032, 107.6548 14.2028, 107.6551 14.2018, 107.6543 14.2011, 107.6533 14.2013, 107.6531 14.2026))',
            },
            {
                code:         'KV-2026-003',
                name:         'Tiểu khu 104 xã Đăk Rơ Nga, Đăk Tô',
                commune_code: '612',  // Huyện Đăk Tô
                note:         'Phát hiện cây gỗ lớn bị cưa hạ, nhiều gốc chặt còn mới',
                wkt: 'POLYGON((107.9572 14.6686, 107.9580 14.6692, 107.9590 14.6688, 107.9593 14.6676, 107.9582 14.6670, 107.9570 14.6678, 107.9572 14.6686))',
            },
            {
                code:         'KV-2026-004',
                name:         'Khu vực rừng tái sinh Măng Cành, Kon Plông',
                commune_code: '613',  // Huyện Kon Plông
                note:         'Rừng phục hồi sau khai thác 2018, có dấu hiệu chặt phá cây tái sinh',
                wkt: 'POLYGON((108.2272 14.7326, 108.2280 14.7334, 108.2291 14.7330, 108.2294 14.7318, 108.2283 14.7312, 108.2270 14.7317, 108.2272 14.7326))',
            },
            {
                code:         'KV-2026-005',
                name:         'Rừng phòng hộ đầu nguồn Đăk Choong, Đăk Glei',
                commune_code: '610',  // Huyện Đăk Glei
                note:         'Khu vực đầu nguồn sông Đăk Drô, đất bờ taluy có nguy cơ sạt lở',
                wkt: 'POLYGON((107.6970 15.0726, 107.6979 15.0732, 107.6989 15.0728, 107.6991 15.0716, 107.6981 15.0710, 107.6969 15.0716, 107.6970 15.0726))',
            },
        ];

        const areaIds = [];
        for (const a of areasData) {
            const res = await db.query(`
                INSERT INTO gis.monitored_areas (code, name, commune_code, ref_geom, note, created_by)
                VALUES ($1, $2, $3, ST_GeomFromText($4, 4326), $5, $6)
                RETURNING id
            `, [a.code, a.name, a.commune_code, a.wkt, a.note, sonn]);
            areaIds.push(res.rows[0].id);
            console.log(`    + ${a.code}: ${a.name}`);
        }

        // ── 3. field_measurements ─────────────────────────────────────────────
        console.log('\n[3] Insert field_measurements...');

        // Helper: tính area_m2 từ WKT qua PostGIS (UTM 48N ≈ mét vuông)
        const calcArea = async (wkt) => {
            const r = await db.query(
                `SELECT ROUND(ST_Area(ST_Transform(ST_GeomFromText($1, 4326), 32648))::NUMERIC, 2) AS m2`,
                [wkt]
            );
            return parseFloat(r.rows[0].m2);
        };

        const measurements = [
            // ─── KV-2026-001 (Sa Thầy) ──────────────────────────────────────
            {
                code:       'DD-2026-00001',
                area_idx:   0,
                status:     'verified',
                commune_code: '616',
                wkt: 'POLYGON((107.7694 14.3504, 107.7700 14.3510, 107.7709 14.3506, 107.7711 14.3494, 107.7701 14.3487, 107.7692 14.3493, 107.7694 14.3504))',
                points: [
                    {lng: 107.7694, lat: 14.3504, accuracy_m: 4.2, recorded_at: '2026-05-10T08:14:22Z'},
                    {lng: 107.7700, lat: 14.3510, accuracy_m: 3.8, recorded_at: '2026-05-10T08:17:05Z'},
                    {lng: 107.7709, lat: 14.3506, accuracy_m: 4.5, recorded_at: '2026-05-10T08:20:30Z'},
                    {lng: 107.7711, lat: 14.3494, accuracy_m: 3.9, recorded_at: '2026-05-10T08:23:48Z'},
                    {lng: 107.7701, lat: 14.3487, accuracy_m: 4.1, recorded_at: '2026-05-10T08:27:12Z'},
                    {lng: 107.7692, lat: 14.3493, accuracy_m: 3.7, recorded_at: '2026-05-10T08:29:50Z'},
                ],
                avg_accuracy_m: 4.03,
                old_land_use: 'Rừng phòng hộ',
                new_land_use: 'Đất trống sau khai thác trái phép',
                note: 'Phát hiện ~20 gốc cây gỗ nhóm III-IV bị cưa hạ, đường kính 25-40cm',
                affected_features: [
                    {feature_id: 1001, land_use: 'Rừng phòng hộ', overlap_m2: 17840.50},
                    {feature_id: 1002, land_use: 'Đất lâm nghiệp', overlap_m2: 3200.20},
                ],
                device_info: {device: 'Samsung Galaxy S22', os: 'Android 13', app_version: '1.2.0'},
                measured_by: sonn,
                verified_by: admin,
                started_at:   '2026-05-10T08:10:00Z',
                finished_at:  '2026-05-10T08:31:00Z',
                submitted_at: '2026-05-10T09:05:00Z',
                verified_at:  '2026-05-11T14:20:00Z',
                review_note:  null,
            },
            {
                code:       'DD-2026-00007',
                area_idx:   0,
                status:     'draft',
                commune_code: '616',
                wkt: 'POLYGON((107.7695 14.3496, 107.7703 14.3502, 107.7712 14.3499, 107.7714 14.3488, 107.7703 14.3482, 107.7693 14.3486, 107.7695 14.3496))',
                points: [
                    {lng: 107.7695, lat: 14.3496, accuracy_m: 5.1, recorded_at: '2026-07-15T07:22:10Z'},
                    {lng: 107.7703, lat: 14.3502, accuracy_m: 4.8, recorded_at: '2026-07-15T07:25:33Z'},
                    {lng: 107.7712, lat: 14.3499, accuracy_m: 5.3, recorded_at: '2026-07-15T07:29:01Z'},
                    {lng: 107.7714, lat: 14.3488, accuracy_m: 4.9, recorded_at: '2026-07-15T07:32:18Z'},
                    {lng: 107.7703, lat: 14.3482, accuracy_m: 5.0, recorded_at: '2026-07-15T07:35:44Z'},
                    {lng: 107.7693, lat: 14.3486, accuracy_m: 5.2, recorded_at: '2026-07-15T07:38:22Z'},
                ],
                avg_accuracy_m: 5.05,
                old_land_use: 'Rừng phòng hộ',
                new_land_use: null,
                note: 'Phiên đo theo dõi diễn tiến sau lần xác nhận tháng 5/2026',
                affected_features: [],
                device_info: {device: 'Xiaomi Redmi Note 12', os: 'Android 14', app_version: '1.2.1'},
                measured_by: sonn,
                verified_by: null,
                started_at:   '2026-07-15T07:18:00Z',
                finished_at:  '2026-07-15T07:40:00Z',
                submitted_at: null,
                verified_at:  null,
                review_note:  null,
            },

            // ─── KV-2026-002 (Chư Mom Ray) ───────────────────────────────────
            {
                code:       'DD-2026-00002',
                area_idx:   1,
                status:     'verified',
                commune_code: '616',
                wkt: 'POLYGON((107.6532 14.2025, 107.6540 14.2031, 107.6549 14.2027, 107.6552 14.2016, 107.6543 14.2010, 107.6533 14.2012, 107.6532 14.2025))',
                points: [
                    {lng: 107.6532, lat: 14.2025, accuracy_m: 3.5, recorded_at: '2026-04-15T06:45:00Z'},
                    {lng: 107.6540, lat: 14.2031, accuracy_m: 3.2, recorded_at: '2026-04-15T06:48:20Z'},
                    {lng: 107.6549, lat: 14.2027, accuracy_m: 4.0, recorded_at: '2026-04-15T06:52:10Z'},
                    {lng: 107.6552, lat: 14.2016, accuracy_m: 3.6, recorded_at: '2026-04-15T06:55:40Z'},
                    {lng: 107.6543, lat: 14.2010, accuracy_m: 3.3, recorded_at: '2026-04-15T06:58:55Z'},
                    {lng: 107.6533, lat: 14.2012, accuracy_m: 3.8, recorded_at: '2026-04-15T07:01:30Z'},
                ],
                avg_accuracy_m: 3.57,
                old_land_use: 'Rừng đặc dụng',
                new_land_use: 'Đất canh tác nương rẫy',
                note: 'Hộ dân tộc thiểu số lấn chiếm ~1.9 ha làm nương rẫy trồng mì, cây còn nhỏ',
                affected_features: [
                    {feature_id: 2001, land_use: 'Rừng đặc dụng (Chư Mom Ray)', overlap_m2: 16400.80},
                    {feature_id: 2002, land_use: 'Đất canh tác', overlap_m2: 2100.30},
                ],
                device_info: {device: 'Samsung Galaxy A54', os: 'Android 13', app_version: '1.2.0'},
                measured_by: sonn,
                verified_by: admin,
                started_at:   '2026-04-15T06:40:00Z',
                finished_at:  '2026-04-15T07:05:00Z',
                submitted_at: '2026-04-15T07:30:00Z',
                verified_at:  '2026-04-16T09:15:00Z',
                review_note:  null,
            },

            // ─── KV-2026-003 (Đăk Rơ Nga – Đăk Tô) ─────────────────────────
            {
                code:       'DD-2026-00004',
                area_idx:   2,
                status:     'verified',
                commune_code: '612',
                wkt: 'POLYGON((107.9573 14.6685, 107.9581 14.6691, 107.9591 14.6687, 107.9594 14.6675, 107.9582 14.6669, 107.9570 14.6677, 107.9573 14.6685))',
                points: [
                    {lng: 107.9573, lat: 14.6685, accuracy_m: 4.8, recorded_at: '2026-03-05T07:30:00Z'},
                    {lng: 107.9581, lat: 14.6691, accuracy_m: 5.1, recorded_at: '2026-03-05T07:33:42Z'},
                    {lng: 107.9591, lat: 14.6687, accuracy_m: 4.6, recorded_at: '2026-03-05T07:37:20Z'},
                    {lng: 107.9594, lat: 14.6675, accuracy_m: 5.3, recorded_at: '2026-03-05T07:41:05Z'},
                    {lng: 107.9582, lat: 14.6669, accuracy_m: 4.9, recorded_at: '2026-03-05T07:44:38Z'},
                ],
                avg_accuracy_m: 4.94,
                old_land_use: 'Rừng sản xuất',
                new_land_use: 'Đất trống đồi trọc',
                note: 'Lô rừng sản xuất bị chặt trắng, chưa trồng lại; nhiều cành ngọn bỏ lại trên đất',
                affected_features: [
                    {feature_id: 3001, land_use: 'Rừng sản xuất', overlap_m2: 19500.00},
                    {feature_id: 3002, land_use: 'Đất lâm nghiệp', overlap_m2: 1200.00},
                ],
                device_info: {device: 'Oppo Reno8', os: 'Android 12', app_version: '1.1.5'},
                measured_by: sonn,
                verified_by: admin,
                started_at:   '2026-03-05T07:25:00Z',
                finished_at:  '2026-03-05T07:47:00Z',
                submitted_at: '2026-03-05T08:20:00Z',
                verified_at:  '2026-03-06T10:30:00Z',
                review_note:  null,
            },
            {
                code:       'DD-2026-00003',
                area_idx:   2,
                status:     'submitted',
                commune_code: '612',
                wkt: 'POLYGON((107.9568 14.6680, 107.9576 14.6688, 107.9587 14.6684, 107.9589 14.6670, 107.9577 14.6664, 107.9566 14.6672, 107.9568 14.6680))',
                points: [
                    {lng: 107.9568, lat: 14.6680, accuracy_m: 4.3, recorded_at: '2026-06-20T08:05:00Z'},
                    {lng: 107.9576, lat: 14.6688, accuracy_m: 3.9, recorded_at: '2026-06-20T08:09:14Z'},
                    {lng: 107.9587, lat: 14.6684, accuracy_m: 4.7, recorded_at: '2026-06-20T08:13:30Z'},
                    {lng: 107.9589, lat: 14.6670, accuracy_m: 4.1, recorded_at: '2026-06-20T08:17:55Z'},
                    {lng: 107.9577, lat: 14.6664, accuracy_m: 4.4, recorded_at: '2026-06-20T08:21:10Z'},
                    {lng: 107.9566, lat: 14.6672, accuracy_m: 3.8, recorded_at: '2026-06-20T08:24:40Z'},
                ],
                avg_accuracy_m: 4.20,
                old_land_use: 'Rừng sản xuất',
                new_land_use: 'Đất trồng cây lâu năm (cà phê)',
                note: 'Khu vực liền kề lô trước, người dân đã chuyển sang trồng cà phê mới 6 tháng tuổi',
                affected_features: [
                    {feature_id: 3003, land_use: 'Rừng sản xuất', overlap_m2: 15200.00},
                    {feature_id: 3004, land_use: 'Đất nông nghiệp', overlap_m2: 4800.00},
                ],
                device_info: {device: 'Samsung Galaxy S22', os: 'Android 13', app_version: '1.2.1'},
                measured_by: sonn,
                verified_by: null,
                started_at:   '2026-06-20T07:58:00Z',
                finished_at:  '2026-06-20T08:27:00Z',
                submitted_at: '2026-06-20T09:10:00Z',
                verified_at:  null,
                review_note:  null,
            },

            // ─── KV-2026-004 (Măng Cành – Kon Plông) ─────────────────────────
            {
                code:       'DD-2026-00005',
                area_idx:   3,
                status:     'rejected',
                commune_code: '613',
                wkt: 'POLYGON((108.2273 14.7324, 108.2281 14.7332, 108.2292 14.7328, 108.2295 14.7316, 108.2283 14.7310, 108.2271 14.7315, 108.2273 14.7324))',
                points: [
                    {lng: 108.2273, lat: 14.7324, accuracy_m: 18.2, recorded_at: '2026-06-01T09:10:00Z'},
                    {lng: 108.2281, lat: 14.7332, accuracy_m: 22.5, recorded_at: '2026-06-01T09:14:30Z'},
                    {lng: 108.2292, lat: 14.7328, accuracy_m: 19.8, recorded_at: '2026-06-01T09:18:45Z'},
                    {lng: 108.2295, lat: 14.7316, accuracy_m: 21.0, recorded_at: '2026-06-01T09:22:10Z'},
                    {lng: 108.2283, lat: 14.7310, accuracy_m: 17.4, recorded_at: '2026-06-01T09:26:30Z'},
                ],
                avg_accuracy_m: 19.78,
                old_land_use: 'Rừng phục hồi',
                new_land_use: null,
                note: 'Địa hình dốc, tán rừng dày, tín hiệu GPS yếu',
                affected_features: [],
                device_info: {device: 'Redmi 10C', os: 'Android 12', app_version: '1.2.0'},
                measured_by: sonn,
                verified_by: admin,
                started_at:   '2026-06-01T09:05:00Z',
                finished_at:  '2026-06-01T09:28:00Z',
                submitted_at: '2026-06-01T10:00:00Z',
                verified_at:  '2026-06-02T08:30:00Z',
                review_note:  'Độ chính xác GPS trung bình 19.78m vượt ngưỡng cho phép (≤ 10m). Đề nghị đo lại khi thời tiết tốt hơn hoặc dùng thiết bị GPS chuyên dụng.',
            },
            {
                code:       'DD-2026-00008',
                area_idx:   3,
                status:     'draft',
                commune_code: '613',
                wkt: 'POLYGON((108.2274 14.7325, 108.2282 14.7333, 108.2293 14.7329, 108.2296 14.7317, 108.2284 14.7311, 108.2272 14.7316, 108.2274 14.7325))',
                points: [
                    {lng: 108.2274, lat: 14.7325, accuracy_m: 4.5, recorded_at: '2026-07-18T07:40:00Z'},
                    {lng: 108.2282, lat: 14.7333, accuracy_m: 4.2, recorded_at: '2026-07-18T07:44:15Z'},
                    {lng: 108.2293, lat: 14.7329, accuracy_m: 4.8, recorded_at: '2026-07-18T07:48:30Z'},
                    {lng: 108.2296, lat: 14.7317, accuracy_m: 4.0, recorded_at: '2026-07-18T07:52:10Z'},
                    {lng: 108.2284, lat: 14.7311, accuracy_m: 4.3, recorded_at: '2026-07-18T07:56:00Z'},
                    {lng: 108.2272, lat: 14.7316, accuracy_m: 4.6, recorded_at: '2026-07-18T07:59:45Z'},
                ],
                avg_accuracy_m: 4.40,
                old_land_use: 'Rừng phục hồi',
                new_land_use: null,
                note: 'Đo lại sau khi lần DD-2026-00005 bị từ chối; sử dụng GPS Garmin etrex',
                affected_features: [],
                device_info: {device: 'Garmin eTrex 32x + Samsung S23 FE', os: 'Android 14', app_version: '1.2.1'},
                measured_by: sonn,
                verified_by: null,
                started_at:   '2026-07-18T07:35:00Z',
                finished_at:  '2026-07-18T08:02:00Z',
                submitted_at: null,
                verified_at:  null,
                review_note:  null,
            },

            // ─── KV-2026-005 (Đăk Choong – Đăk Glei) ────────────────────────
            {
                code:       'DD-2026-00006',
                area_idx:   4,
                status:     'submitted',
                commune_code: '610',
                wkt: 'POLYGON((107.6971 15.0725, 107.6980 15.0731, 107.6990 15.0727, 107.6992 15.0715, 107.6981 15.0709, 107.6969 15.0715, 107.6971 15.0725))',
                points: [
                    {lng: 107.6971, lat: 15.0725, accuracy_m: 3.9, recorded_at: '2026-07-01T07:00:00Z'},
                    {lng: 107.6980, lat: 15.0731, accuracy_m: 4.2, recorded_at: '2026-07-01T07:04:20Z'},
                    {lng: 107.6990, lat: 15.0727, accuracy_m: 3.7, recorded_at: '2026-07-01T07:08:45Z'},
                    {lng: 107.6992, lat: 15.0715, accuracy_m: 4.5, recorded_at: '2026-07-01T07:13:00Z'},
                    {lng: 107.6981, lat: 15.0709, accuracy_m: 4.0, recorded_at: '2026-07-01T07:17:30Z'},
                    {lng: 107.6969, lat: 15.0715, accuracy_m: 3.8, recorded_at: '2026-07-01T07:21:05Z'},
                ],
                avg_accuracy_m: 4.02,
                old_land_use: 'Rừng phòng hộ đầu nguồn',
                new_land_use: 'Đất bờ taluy sạt lở (đất trống)',
                note: 'Sạt lở bờ taluy do mưa lớn tháng 6/2026, ~0.24 ha rừng đầu nguồn bị mất',
                affected_features: [
                    {feature_id: 5001, land_use: 'Rừng phòng hộ đầu nguồn', overlap_m2: 2120.40},
                    {feature_id: 5002, land_use: 'Đất trống', overlap_m2: 18750.60},
                ],
                device_info: {device: 'Realme GT Neo3', os: 'Android 13', app_version: '1.2.0'},
                measured_by: sonn,
                verified_by: null,
                started_at:   '2026-07-01T06:55:00Z',
                finished_at:  '2026-07-01T07:23:00Z',
                submitted_at: '2026-07-01T08:05:00Z',
                verified_at:  null,
                review_note:  null,
            },
        ];

        let order = 0;
        for (const m of measurements) {
            order++;
            const area_m2 = await calcArea(m.wkt);
            await db.query(`
                INSERT INTO gis.field_measurements (
                    code, area_id, commune_code,
                    points, geom, area_m2, avg_accuracy_m,
                    affected_features, old_land_use, new_land_use, note,
                    status, review_note,
                    device_info, measured_by, verified_by,
                    started_at, finished_at, submitted_at, verified_at
                ) VALUES (
                    $1,  $2,  $3,
                    $4::jsonb,
                    ST_GeomFromText($5, 4326),
                    $6,  $7,
                    $8::jsonb,  $9,  $10, $11,
                    $12, $13,
                    $14::jsonb, $15, $16,
                    $17, $18, $19, $20
                )
            `, [
                m.code,
                areaIds[m.area_idx],
                m.commune_code,
                JSON.stringify(m.points),
                m.wkt,
                area_m2,
                m.avg_accuracy_m,
                JSON.stringify(m.affected_features),
                m.old_land_use,
                m.new_land_use,
                m.note,
                m.status,
                m.review_note,
                JSON.stringify(m.device_info),
                m.measured_by,
                m.verified_by,
                m.started_at,
                m.finished_at,
                m.submitted_at,
                m.verified_at,
            ]);
            console.log(`    + ${m.code} [${m.status}] area=${area_m2}m² → ${m.note?.slice(0, 50)}...`);
        }

        // ── 4. Tổng kết ────────────────────────────────────────────────────────
        console.log('\n[4] Kiểm tra kết quả:');
        const summary = await db.query(`
            SELECT status, COUNT(*) as so_phien
            FROM gis.field_measurements
            GROUP BY status ORDER BY status
        `);
        summary.rows.forEach(r => console.log(`    ${r.status}: ${r.so_phien} phiên`));

        const areas = await db.query(`SELECT COUNT(*) FROM gis.monitored_areas`);
        console.log(`    Khu vực theo dõi: ${areas.rows[0].count}`);

        console.log('\n=== Seed 003 hoàn thành ===');
        await db.pool.end();
        process.exit(0);
    } catch (e) {
        console.error('Seed 003 thất bại:', e.message);
        console.error(e.stack);
        await db.pool.end().catch(() => {});
        process.exit(1);
    }
})();
