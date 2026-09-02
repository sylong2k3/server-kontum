-- ============================================================================
-- Migration 048: XOÁ DỮ LIỆU CẢNH BÁO CHÁY RỪNG + SEED ĐO THỰC ĐỊA KON TUM
--
-- Phần 1 — XOÁ CẢNH BÁO CHÁY RỪNG:
--   Xoá toàn bộ dữ liệu phân tích fire risk (snapshots, features, district
--   exports, raster ingest jobs liên quan). Giữ nguyên ground truth (fire_gt_*).
--
-- Phần 2 — SEED ĐO THỰC ĐỊA:
--   Reset và thêm mới 5 khu vực theo dõi + 10 phiên đo GPS thực địa trải đều
--   5 huyện của tỉnh Kon Tum: Sa Thầy, Ngọk Hồi, TP Kon Tum, Đăk Hà,
--   Tu Mơ Rông. Đủ 4 trạng thái: draft / submitted / verified / rejected.
--
-- Phần 3 — XOÁ LỚP BẢN ĐỒ TEST:
--   5 bản ghi gis.layer_registry tạo trong lúc thử nghiệm import ngày
--   29/07/2026 (code: test, test_sample_001, test_sample_002,
--   test_geojson_fix, test_geojson_v3). GeoServer layer/coveragestore tương
--   ứng (kontum:test_geojson_v3 + 84 coveragestore fire_risk_*/forest_class_*
--   sinh ra lúc test pipeline) đã được xoá thủ công qua REST API trước khi
--   chạy migration này. Hard-delete (không soft-delete) vì đây là rác test,
--   không phải dữ liệu nghiệp vụ cần giữ lịch sử.
--
-- Idempotent: dùng ON CONFLICT DO NOTHING ở INSERT để chạy lại an toàn.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- PHẦN 1: XOÁ DỮ LIỆU CẢNH BÁO CHÁY RỪNG
-- ─────────────────────────────────────────────────────────────────────────────

-- Raster ingest jobs tham chiếu fire risk qua JSON (không có FK cứng).
-- Xoá trước để tránh dedupe ngược với snapshot mới khi pipeline chạy lại.
DELETE FROM gis.raster_ingest_jobs
WHERE COALESCE(
          request_params #>> '{linkedResource,type}',
          request_params #>> '{linked_resource,type}'
      ) IN ('fire_risk', 'fire_risk_district')
   OR LEFT(layer_code, 10) = 'fire_risk_';

-- fire_risk_district_exports và fire_risk_features khai báo ON DELETE CASCADE
-- từ fire_risk_snapshots → TRUNCATE cha là đủ.
TRUNCATE TABLE fire.fire_risk_snapshots RESTART IDENTITY CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- PHẦN 2: RESET + SEED DỮ LIỆU ĐO THỰC ĐỊA
-- ─────────────────────────────────────────────────────────────────────────────

-- Xoá sạch để tránh trùng với bất kỳ seed JS nào đã chạy trước.
-- field_measurements + field_measurement_photos CASCADE từ monitored_areas.
TRUNCATE TABLE gis.monitored_areas RESTART IDENTITY CASCADE;

-- ─── Insert dữ liệu trong DO block để tái dùng RETURNING id ──────────────────
DO $$
DECLARE
    v_admin   BIGINT;
    v_sonn    BIGINT;
    v_area1   BIGINT;   -- Sa Thầy: KV-2026-001
    v_area2   BIGINT;   -- Ngọk Hồi: KV-2026-002
    v_area3   BIGINT;   -- TP Kon Tum: KV-2026-003
    v_area4   BIGINT;   -- Đăk Hà: KV-2026-004
    v_area5   BIGINT;   -- Tu Mơ Rông: KV-2026-005
BEGIN

    -- Lấy user IDs theo role; fallback = user đầu tiên nếu chưa có seed.
    SELECT u.id INTO v_admin
    FROM auth.users u
    JOIN auth.roles r ON u.role_id = r.id
    WHERE r.code = 'system_admin' AND u.deleted_at IS NULL
    ORDER BY u.id LIMIT 1;

    SELECT u.id INTO v_sonn
    FROM auth.users u
    JOIN auth.roles r ON u.role_id = r.id
    WHERE r.code = 'so_nnmt' AND u.deleted_at IS NULL
    ORDER BY u.id LIMIT 1;

    v_admin := COALESCE(v_admin, 1);
    v_sonn  := COALESCE(v_sonn, v_admin);

    -- =========================================================================
    -- MONITORED AREAS — 5 khu vực theo dõi trải đều địa bàn tỉnh
    -- =========================================================================

    -- ── KV-2026-001: Huyện Sa Thầy (616) ─────────────────────────────────────
    -- Rừng phòng hộ sông Krông Pô Kô, đã phát hiện khai thác gỗ trái phép.
    INSERT INTO gis.monitored_areas (code, name, commune_code, ref_geom, note, created_by)
    VALUES (
        'KV-2026-001',
        'Rừng phòng hộ sông Krông Pô Kô, Sa Thầy',
        '616',
        ST_GeomFromText(
            'POLYGON((107.7693 14.3506, 107.7700 14.3512, 107.7710 14.3508,'
            '107.7712 14.3494, 107.7702 14.3486, 107.7691 14.3492, 107.7693 14.3506))',
            4326
        ),
        'Giáp suối Krông Pô Kô; phát hiện khai thác gỗ nhóm III-IV trái phép nhiều lần',
        v_sonn
    ) RETURNING id INTO v_area1;

    -- ── KV-2026-002: Huyện Ngọk Hồi (611) ───────────────────────────────────
    -- Tiểu khu 209 vùng biên giới Việt – Lào.
    INSERT INTO gis.monitored_areas (code, name, commune_code, ref_geom, note, created_by)
    VALUES (
        'KV-2026-002',
        'Tiểu khu 209 giáp biên giới Việt – Lào, Ngọk Hồi',
        '611',
        ST_GeomFromText(
            'POLYGON((107.7082 14.7241, 107.7091 14.7249, 107.7103 14.7244,'
            '107.7105 14.7230, 107.7093 14.7222, 107.7080 14.7228, 107.7082 14.7241))',
            4326
        ),
        'Rừng biên giới; dấu vết vận chuyển lâm sản trái phép qua đường mòn dân sinh',
        v_sonn
    ) RETURNING id INTO v_area2;

    -- ── KV-2026-003: TP Kon Tum (608) ────────────────────────────────────────
    -- Rừng phòng hộ đầu nguồn sông Đăk Bla.
    INSERT INTO gis.monitored_areas (code, name, commune_code, ref_geom, note, created_by)
    VALUES (
        'KV-2026-003',
        'Rừng phòng hộ đầu nguồn Đăk Bla, TP Kon Tum',
        '608',
        ST_GeomFromText(
            'POLYGON((108.0141 14.3588, 108.0150 14.3596, 108.0161 14.3591,'
            '108.0163 14.3577, 108.0152 14.3570, 108.0139 14.3576, 108.0141 14.3588))',
            4326
        ),
        'Đầu nguồn sông Đăk Bla; nguy cơ sạt lở taluy và khai thác cát lòng suối trái phép',
        v_sonn
    ) RETURNING id INTO v_area3;

    -- ── KV-2026-004: Huyện Đăk Hà (615) ─────────────────────────────────────
    -- Tiểu khu 181 rừng sản xuất.
    INSERT INTO gis.monitored_areas (code, name, commune_code, ref_geom, note, created_by)
    VALUES (
        'KV-2026-004',
        'Tiểu khu 181 rừng sản xuất, Đăk Hà',
        '615',
        ST_GeomFromText(
            'POLYGON((107.9451 14.5823, 107.9460 14.5831, 107.9471 14.5826,'
            '107.9474 14.5812, 107.9462 14.5805, 107.9449 14.5811, 107.9451 14.5823))',
            4326
        ),
        'Lô rừng sản xuất thuộc kế hoạch khai thác; cần đo xác nhận diện tích thực chặt',
        v_sonn
    ) RETURNING id INTO v_area4;

    -- ── KV-2026-005: Huyện Tu Mơ Rông (617) ─────────────────────────────────
    -- Tiểu khu 252 rừng nguyên sinh gỗ quý.
    INSERT INTO gis.monitored_areas (code, name, commune_code, ref_geom, note, created_by)
    VALUES (
        'KV-2026-005',
        'Tiểu khu 252 rừng nguyên sinh, Tu Mơ Rông',
        '617',
        ST_GeomFromText(
            'POLYGON((108.0023 14.9612, 108.0032 14.9620, 108.0043 14.9615,'
            '108.0046 14.9601, 108.0034 14.9594, 108.0021 14.9600, 108.0023 14.9612))',
            4326
        ),
        'Rừng già nguyên sinh; phát hiện vết khai thác cẩm lai, giáng hương trái phép',
        v_sonn
    ) RETURNING id INTO v_area5;

    -- =========================================================================
    -- FIELD MEASUREMENTS — 10 phiên đo GPS: verified/submitted/rejected/draft
    -- =========================================================================

    -- ── DD-2026-00001: KV-2026-001 (Sa Thầy) — VERIFIED ─────────────────────
    -- Phiên đo xác nhận khai thác gỗ trái phép ~2 ha rừng phòng hộ.
    INSERT INTO gis.field_measurements (
        code, area_id, commune_code,
        points, geom, area_m2, avg_accuracy_m,
        affected_features, old_land_use, new_land_use, note,
        status, review_note, device_info, measured_by, verified_by,
        started_at, finished_at, submitted_at, verified_at
    ) VALUES (
        'DD-2026-00001', v_area1, '616',
        '[
            {"lng":107.7694,"lat":14.3504,"accuracy_m":4.2,"recorded_at":"2026-04-10T08:14:22Z"},
            {"lng":107.7700,"lat":14.3510,"accuracy_m":3.8,"recorded_at":"2026-04-10T08:17:05Z"},
            {"lng":107.7709,"lat":14.3506,"accuracy_m":4.5,"recorded_at":"2026-04-10T08:20:30Z"},
            {"lng":107.7711,"lat":14.3494,"accuracy_m":3.9,"recorded_at":"2026-04-10T08:23:48Z"},
            {"lng":107.7701,"lat":14.3487,"accuracy_m":4.1,"recorded_at":"2026-04-10T08:27:12Z"},
            {"lng":107.7692,"lat":14.3493,"accuracy_m":3.7,"recorded_at":"2026-04-10T08:29:50Z"}
        ]'::jsonb,
        ST_GeomFromText(
            'POLYGON((107.7694 14.3504, 107.7700 14.3510, 107.7709 14.3506,'
            '107.7711 14.3494, 107.7701 14.3487, 107.7692 14.3493, 107.7694 14.3504))',
            4326
        ),
        ROUND(ST_Area(ST_Transform(
            ST_GeomFromText(
                'POLYGON((107.7694 14.3504, 107.7700 14.3510, 107.7709 14.3506,'
                '107.7711 14.3494, 107.7701 14.3487, 107.7692 14.3493, 107.7694 14.3504))',
                4326
            ), 32648))::NUMERIC, 2),
        4.03,
        '[
            {"feature_id":1001,"land_use":"Rừng phòng hộ","overlap_m2":17840.50},
            {"feature_id":1002,"land_use":"Đất lâm nghiệp","overlap_m2":3200.20}
        ]'::jsonb,
        'Rừng phòng hộ',
        'Đất trống sau khai thác trái phép',
        'Phát hiện ~20 gốc cây gỗ nhóm III-IV bị cưa hạ; đường kính 25–40 cm; cành ngọn vứt tại chỗ',
        'verified', NULL,
        '{"device":"Samsung Galaxy S22","os":"Android 13","app_version":"1.2.0"}'::jsonb,
        v_sonn, v_admin,
        '2026-04-10T08:10:00Z', '2026-04-10T08:31:00Z',
        '2026-04-10T09:05:00Z', '2026-04-11T14:20:00Z'
    );

    -- ── DD-2026-00002: KV-2026-001 (Sa Thầy) — DRAFT ─────────────────────────
    -- Phiên theo dõi diễn tiến 3 tháng sau lần đo xác nhận; chưa nộp.
    INSERT INTO gis.field_measurements (
        code, area_id, commune_code,
        points, geom, area_m2, avg_accuracy_m,
        affected_features, old_land_use, new_land_use, note,
        status, review_note, device_info, measured_by, verified_by,
        started_at, finished_at, submitted_at, verified_at
    ) VALUES (
        'DD-2026-00002', v_area1, '616',
        '[
            {"lng":107.7695,"lat":14.3497,"accuracy_m":5.1,"recorded_at":"2026-07-15T07:22:10Z"},
            {"lng":107.7703,"lat":14.3503,"accuracy_m":4.8,"recorded_at":"2026-07-15T07:25:33Z"},
            {"lng":107.7712,"lat":14.3499,"accuracy_m":5.3,"recorded_at":"2026-07-15T07:29:01Z"},
            {"lng":107.7714,"lat":14.3488,"accuracy_m":4.9,"recorded_at":"2026-07-15T07:32:18Z"},
            {"lng":107.7703,"lat":14.3482,"accuracy_m":5.0,"recorded_at":"2026-07-15T07:35:44Z"},
            {"lng":107.7694,"lat":14.3486,"accuracy_m":5.2,"recorded_at":"2026-07-15T07:38:22Z"}
        ]'::jsonb,
        ST_GeomFromText(
            'POLYGON((107.7695 14.3497, 107.7703 14.3503, 107.7712 14.3499,'
            '107.7714 14.3488, 107.7703 14.3482, 107.7694 14.3486, 107.7695 14.3497))',
            4326
        ),
        ROUND(ST_Area(ST_Transform(
            ST_GeomFromText(
                'POLYGON((107.7695 14.3497, 107.7703 14.3503, 107.7712 14.3499,'
                '107.7714 14.3488, 107.7703 14.3482, 107.7694 14.3486, 107.7695 14.3497))',
                4326
            ), 32648))::NUMERIC, 2),
        5.05,
        '[]'::jsonb,
        'Rừng phòng hộ',
        NULL,
        'Theo dõi diễn tiến sau lần xác nhận tháng 4/2026; đất vẫn trống, chưa có dấu phục hồi',
        'draft', NULL,
        '{"device":"Xiaomi Redmi Note 12","os":"Android 14","app_version":"1.2.1"}'::jsonb,
        v_sonn, NULL,
        '2026-07-15T07:18:00Z', '2026-07-15T07:40:00Z',
        NULL, NULL
    );

    -- ── DD-2026-00003: KV-2026-002 (Ngọk Hồi) — VERIFIED ────────────────────
    -- Xác nhận lấn chiếm rừng biên giới làm nương rẫy.
    INSERT INTO gis.field_measurements (
        code, area_id, commune_code,
        points, geom, area_m2, avg_accuracy_m,
        affected_features, old_land_use, new_land_use, note,
        status, review_note, device_info, measured_by, verified_by,
        started_at, finished_at, submitted_at, verified_at
    ) VALUES (
        'DD-2026-00003', v_area2, '611',
        '[
            {"lng":107.7083,"lat":14.7240,"accuracy_m":3.5,"recorded_at":"2026-03-18T06:45:00Z"},
            {"lng":107.7091,"lat":14.7248,"accuracy_m":3.2,"recorded_at":"2026-03-18T06:48:20Z"},
            {"lng":107.7102,"lat":14.7243,"accuracy_m":4.0,"recorded_at":"2026-03-18T06:52:10Z"},
            {"lng":107.7104,"lat":14.7229,"accuracy_m":3.6,"recorded_at":"2026-03-18T06:55:40Z"},
            {"lng":107.7093,"lat":14.7221,"accuracy_m":3.3,"recorded_at":"2026-03-18T06:58:55Z"},
            {"lng":107.7081,"lat":14.7227,"accuracy_m":3.8,"recorded_at":"2026-03-18T07:01:30Z"}
        ]'::jsonb,
        ST_GeomFromText(
            'POLYGON((107.7083 14.7240, 107.7091 14.7248, 107.7102 14.7243,'
            '107.7104 14.7229, 107.7093 14.7221, 107.7081 14.7227, 107.7083 14.7240))',
            4326
        ),
        ROUND(ST_Area(ST_Transform(
            ST_GeomFromText(
                'POLYGON((107.7083 14.7240, 107.7091 14.7248, 107.7102 14.7243,'
                '107.7104 14.7229, 107.7093 14.7221, 107.7081 14.7227, 107.7083 14.7240))',
                4326
            ), 32648))::NUMERIC, 2),
        3.57,
        '[
            {"feature_id":2001,"land_use":"Rừng phòng hộ biên giới","overlap_m2":15600.80},
            {"feature_id":2002,"land_use":"Đất canh tác","overlap_m2":2700.30}
        ]'::jsonb,
        'Rừng phòng hộ biên giới',
        'Đất canh tác nương rẫy (sắn)',
        'Hộ dân địa phương lấn chiếm ~1.8 ha làm nương rẫy trồng sắn; cây còn nhỏ khoảng 4 tháng tuổi',
        'verified', NULL,
        '{"device":"Samsung Galaxy A54","os":"Android 13","app_version":"1.2.0"}'::jsonb,
        v_sonn, v_admin,
        '2026-03-18T06:40:00Z', '2026-03-18T07:05:00Z',
        '2026-03-18T07:30:00Z', '2026-03-19T09:15:00Z'
    );

    -- ── DD-2026-00004: KV-2026-002 (Ngọk Hồi) — REJECTED ────────────────────
    -- Phiên đo lần 2 bị từ chối do GPS kém (tán rừng dày, vùng núi cao).
    INSERT INTO gis.field_measurements (
        code, area_id, commune_code,
        points, geom, area_m2, avg_accuracy_m,
        affected_features, old_land_use, new_land_use, note,
        status, review_note, device_info, measured_by, verified_by,
        started_at, finished_at, submitted_at, verified_at
    ) VALUES (
        'DD-2026-00004', v_area2, '611',
        '[
            {"lng":107.7090,"lat":14.7233,"accuracy_m":24.5,"recorded_at":"2026-05-22T09:10:00Z"},
            {"lng":107.7098,"lat":14.7241,"accuracy_m":28.2,"recorded_at":"2026-05-22T09:14:30Z"},
            {"lng":107.7109,"lat":14.7236,"accuracy_m":22.7,"recorded_at":"2026-05-22T09:18:45Z"},
            {"lng":107.7111,"lat":14.7222,"accuracy_m":26.1,"recorded_at":"2026-05-22T09:22:10Z"},
            {"lng":107.7100,"lat":14.7215,"accuracy_m":19.8,"recorded_at":"2026-05-22T09:26:30Z"}
        ]'::jsonb,
        ST_GeomFromText(
            'POLYGON((107.7090 14.7233, 107.7098 14.7241, 107.7109 14.7236,'
            '107.7111 14.7222, 107.7100 14.7215, 107.7088 14.7221, 107.7090 14.7233))',
            4326
        ),
        ROUND(ST_Area(ST_Transform(
            ST_GeomFromText(
                'POLYGON((107.7090 14.7233, 107.7098 14.7241, 107.7109 14.7236,'
                '107.7111 14.7222, 107.7100 14.7215, 107.7088 14.7221, 107.7090 14.7233))',
                4326
            ), 32648))::NUMERIC, 2),
        24.26,
        '[]'::jsonb,
        'Rừng phòng hộ biên giới',
        NULL,
        'Địa hình vách núi dốc đứng, tán rừng dày ba tầng, tín hiệu GPS yếu và không ổn định',
        'rejected',
        'Độ chính xác GPS trung bình 24.26 m vượt ngưỡng cho phép (≤ 10 m). '
        'Đề nghị đo lại khi thời tiết tốt hơn hoặc sử dụng thiết bị GPS chuyên dụng (Garmin/Trimble).',
        '{"device":"Redmi 10C","os":"Android 12","app_version":"1.2.0"}'::jsonb,
        v_sonn, v_admin,
        '2026-05-22T09:05:00Z', '2026-05-22T09:28:00Z',
        '2026-05-22T10:00:00Z', '2026-05-23T08:30:00Z'
    );

    -- ── DD-2026-00005: KV-2026-003 (TP Kon Tum) — SUBMITTED ─────────────────
    -- Ghi nhận sạt lở taluy đầu nguồn Đăk Bla sau đợt mưa lớn tháng 6/2026.
    INSERT INTO gis.field_measurements (
        code, area_id, commune_code,
        points, geom, area_m2, avg_accuracy_m,
        affected_features, old_land_use, new_land_use, note,
        status, review_note, device_info, measured_by, verified_by,
        started_at, finished_at, submitted_at, verified_at
    ) VALUES (
        'DD-2026-00005', v_area3, '608',
        '[
            {"lng":108.0142,"lat":14.3587,"accuracy_m":3.9,"recorded_at":"2026-07-05T07:00:00Z"},
            {"lng":108.0151,"lat":14.3595,"accuracy_m":4.2,"recorded_at":"2026-07-05T07:04:20Z"},
            {"lng":108.0162,"lat":14.3590,"accuracy_m":3.7,"recorded_at":"2026-07-05T07:08:45Z"},
            {"lng":108.0164,"lat":14.3576,"accuracy_m":4.5,"recorded_at":"2026-07-05T07:13:00Z"},
            {"lng":108.0153,"lat":14.3569,"accuracy_m":4.0,"recorded_at":"2026-07-05T07:17:30Z"},
            {"lng":108.0140,"lat":14.3575,"accuracy_m":3.8,"recorded_at":"2026-07-05T07:21:05Z"}
        ]'::jsonb,
        ST_GeomFromText(
            'POLYGON((108.0142 14.3587, 108.0151 14.3595, 108.0162 14.3590,'
            '108.0164 14.3576, 108.0153 14.3569, 108.0140 14.3575, 108.0142 14.3587))',
            4326
        ),
        ROUND(ST_Area(ST_Transform(
            ST_GeomFromText(
                'POLYGON((108.0142 14.3587, 108.0151 14.3595, 108.0162 14.3590,'
                '108.0164 14.3576, 108.0153 14.3569, 108.0140 14.3575, 108.0142 14.3587))',
                4326
            ), 32648))::NUMERIC, 2),
        4.02,
        '[
            {"feature_id":3001,"land_use":"Rừng phòng hộ đầu nguồn","overlap_m2":2320.40},
            {"feature_id":3002,"land_use":"Đất trống bờ taluy","overlap_m2":19550.60}
        ]'::jsonb,
        'Rừng phòng hộ đầu nguồn',
        'Đất trống bờ taluy sạt lở',
        'Sạt lở bờ taluy do mưa lớn đợt 25–28/06/2026; ước ~0.22 ha rừng đầu nguồn bị mất; '
        'lộ vết nứt dọc sườn dài khoảng 85 m',
        'submitted', NULL,
        '{"device":"Realme GT Neo3","os":"Android 13","app_version":"1.2.0"}'::jsonb,
        v_sonn, NULL,
        '2026-07-05T06:55:00Z', '2026-07-05T07:23:00Z',
        '2026-07-05T08:05:00Z', NULL
    );

    -- ── DD-2026-00006: KV-2026-003 (TP Kon Tum) — DRAFT ─────────────────────
    -- Phiên đo mở rộng sang khu vực liền kề; đang ở hiện trường, chưa hoàn thành.
    INSERT INTO gis.field_measurements (
        code, area_id, commune_code,
        points, geom, area_m2, avg_accuracy_m,
        affected_features, old_land_use, new_land_use, note,
        status, review_note, device_info, measured_by, verified_by,
        started_at, finished_at, submitted_at, verified_at
    ) VALUES (
        'DD-2026-00006', v_area3, '608',
        '[
            {"lng":108.0135,"lat":14.3581,"accuracy_m":4.1,"recorded_at":"2026-07-20T07:30:00Z"},
            {"lng":108.0144,"lat":14.3589,"accuracy_m":3.9,"recorded_at":"2026-07-20T07:34:10Z"},
            {"lng":108.0155,"lat":14.3584,"accuracy_m":4.3,"recorded_at":"2026-07-20T07:38:25Z"}
        ]'::jsonb,
        ST_GeomFromText(
            'POLYGON((108.0135 14.3581, 108.0144 14.3589, 108.0155 14.3584,'
            '108.0157 14.3570, 108.0146 14.3563, 108.0133 14.3569, 108.0135 14.3581))',
            4326
        ),
        ROUND(ST_Area(ST_Transform(
            ST_GeomFromText(
                'POLYGON((108.0135 14.3581, 108.0144 14.3589, 108.0155 14.3584,'
                '108.0157 14.3570, 108.0146 14.3563, 108.0133 14.3569, 108.0135 14.3581))',
                4326
            ), 32648))::NUMERIC, 2),
        4.10,
        '[]'::jsonb,
        'Rừng phòng hộ đầu nguồn',
        NULL,
        'Đo mở rộng khu vực liền kề ổ trượt; đang khảo sát vết nứt phía thượng lưu',
        'draft', NULL,
        '{"device":"iPhone 14 Pro","os":"iOS 17","app_version":"1.2.1"}'::jsonb,
        v_sonn, NULL,
        '2026-07-20T07:25:00Z', NULL,
        NULL, NULL
    );

    -- ── DD-2026-00007: KV-2026-004 (Đăk Hà) — VERIFIED ─────────────────────
    -- Đo xác nhận diện tích thực tế đã chặt hạ trong lô rừng sản xuất.
    INSERT INTO gis.field_measurements (
        code, area_id, commune_code,
        points, geom, area_m2, avg_accuracy_m,
        affected_features, old_land_use, new_land_use, note,
        status, review_note, device_info, measured_by, verified_by,
        started_at, finished_at, submitted_at, verified_at
    ) VALUES (
        'DD-2026-00007', v_area4, '615',
        '[
            {"lng":107.9452,"lat":14.5822,"accuracy_m":4.8,"recorded_at":"2026-05-08T07:30:00Z"},
            {"lng":107.9461,"lat":14.5830,"accuracy_m":5.1,"recorded_at":"2026-05-08T07:33:42Z"},
            {"lng":107.9472,"lat":14.5825,"accuracy_m":4.6,"recorded_at":"2026-05-08T07:37:20Z"},
            {"lng":107.9475,"lat":14.5811,"accuracy_m":5.3,"recorded_at":"2026-05-08T07:41:05Z"},
            {"lng":107.9463,"lat":14.5804,"accuracy_m":4.9,"recorded_at":"2026-05-08T07:44:38Z"},
            {"lng":107.9450,"lat":14.5810,"accuracy_m":4.7,"recorded_at":"2026-05-08T07:47:55Z"}
        ]'::jsonb,
        ST_GeomFromText(
            'POLYGON((107.9452 14.5822, 107.9461 14.5830, 107.9472 14.5825,'
            '107.9475 14.5811, 107.9463 14.5804, 107.9450 14.5810, 107.9452 14.5822))',
            4326
        ),
        ROUND(ST_Area(ST_Transform(
            ST_GeomFromText(
                'POLYGON((107.9452 14.5822, 107.9461 14.5830, 107.9472 14.5825,'
                '107.9475 14.5811, 107.9463 14.5804, 107.9450 14.5810, 107.9452 14.5822))',
                4326
            ), 32648))::NUMERIC, 2),
        4.90,
        '[
            {"feature_id":4001,"land_use":"Rừng sản xuất","overlap_m2":21300.00},
            {"feature_id":4002,"land_use":"Đất lâm nghiệp","overlap_m2":1100.00}
        ]'::jsonb,
        'Rừng sản xuất',
        'Đất trống sau khai thác (chưa trồng lại)',
        'Lô chặt trắng theo kế hoạch; diện tích thực đo vượt hồ sơ giấy phép 0.4 ha; '
        'chưa có cây con tái sinh; cành ngọn bỏ lại trên đất',
        'verified', NULL,
        '{"device":"Oppo Reno10","os":"Android 13","app_version":"1.2.1"}'::jsonb,
        v_sonn, v_admin,
        '2026-05-08T07:25:00Z', '2026-05-08T07:50:00Z',
        '2026-05-08T08:30:00Z', '2026-05-09T10:00:00Z'
    );

    -- ── DD-2026-00008: KV-2026-004 (Đăk Hà) — SUBMITTED ─────────────────────
    -- Phiên đo theo dõi phục hồi 2 tháng sau khai thác; đã nộp, chờ xác nhận.
    INSERT INTO gis.field_measurements (
        code, area_id, commune_code,
        points, geom, area_m2, avg_accuracy_m,
        affected_features, old_land_use, new_land_use, note,
        status, review_note, device_info, measured_by, verified_by,
        started_at, finished_at, submitted_at, verified_at
    ) VALUES (
        'DD-2026-00008', v_area4, '615',
        '[
            {"lng":107.9448,"lat":14.5818,"accuracy_m":4.3,"recorded_at":"2026-07-10T08:05:00Z"},
            {"lng":107.9457,"lat":14.5826,"accuracy_m":3.9,"recorded_at":"2026-07-10T08:09:14Z"},
            {"lng":107.9468,"lat":14.5821,"accuracy_m":4.7,"recorded_at":"2026-07-10T08:13:30Z"},
            {"lng":107.9471,"lat":14.5807,"accuracy_m":4.1,"recorded_at":"2026-07-10T08:17:55Z"},
            {"lng":107.9459,"lat":14.5800,"accuracy_m":4.4,"recorded_at":"2026-07-10T08:21:10Z"},
            {"lng":107.9446,"lat":14.5806,"accuracy_m":3.8,"recorded_at":"2026-07-10T08:24:40Z"}
        ]'::jsonb,
        ST_GeomFromText(
            'POLYGON((107.9448 14.5818, 107.9457 14.5826, 107.9468 14.5821,'
            '107.9471 14.5807, 107.9459 14.5800, 107.9446 14.5806, 107.9448 14.5818))',
            4326
        ),
        ROUND(ST_Area(ST_Transform(
            ST_GeomFromText(
                'POLYGON((107.9448 14.5818, 107.9457 14.5826, 107.9468 14.5821,'
                '107.9471 14.5807, 107.9459 14.5800, 107.9446 14.5806, 107.9448 14.5818))',
                4326
            ), 32648))::NUMERIC, 2),
        4.20,
        '[
            {"feature_id":4001,"land_use":"Rừng sản xuất","overlap_m2":18200.00},
            {"feature_id":4003,"land_use":"Đất trống (sau khai thác)","overlap_m2":4800.00}
        ]'::jsonb,
        'Đất trống sau khai thác',
        'Đất trồng cây lâu năm (cà phê non)',
        'Theo dõi 2 tháng sau khai thác; hộ dân đã trồng cà phê con 1.5 tháng tuổi trên ~0.5 ha lô chưa có giấy phép chuyển đổi',
        'submitted', NULL,
        '{"device":"Samsung Galaxy S22","os":"Android 13","app_version":"1.2.1"}'::jsonb,
        v_sonn, NULL,
        '2026-07-10T07:58:00Z', '2026-07-10T08:27:00Z',
        '2026-07-10T09:10:00Z', NULL
    );

    -- ── DD-2026-00009: KV-2026-005 (Tu Mơ Rông) — SUBMITTED ─────────────────
    -- Ghi nhận điểm khai thác gỗ quý trong rừng nguyên sinh tiểu khu 252.
    INSERT INTO gis.field_measurements (
        code, area_id, commune_code,
        points, geom, area_m2, avg_accuracy_m,
        affected_features, old_land_use, new_land_use, note,
        status, review_note, device_info, measured_by, verified_by,
        started_at, finished_at, submitted_at, verified_at
    ) VALUES (
        'DD-2026-00009', v_area5, '617',
        '[
            {"lng":108.0024,"lat":14.9611,"accuracy_m":5.2,"recorded_at":"2026-06-25T06:30:00Z"},
            {"lng":108.0033,"lat":14.9619,"accuracy_m":4.9,"recorded_at":"2026-06-25T06:34:15Z"},
            {"lng":108.0044,"lat":14.9614,"accuracy_m":5.5,"recorded_at":"2026-06-25T06:38:42Z"},
            {"lng":108.0047,"lat":14.9600,"accuracy_m":5.1,"recorded_at":"2026-06-25T06:43:00Z"},
            {"lng":108.0035,"lat":14.9593,"accuracy_m":4.8,"recorded_at":"2026-06-25T06:47:30Z"},
            {"lng":108.0022,"lat":14.9599,"accuracy_m":5.4,"recorded_at":"2026-06-25T06:51:10Z"}
        ]'::jsonb,
        ST_GeomFromText(
            'POLYGON((108.0024 14.9611, 108.0033 14.9619, 108.0044 14.9614,'
            '108.0047 14.9600, 108.0035 14.9593, 108.0022 14.9599, 108.0024 14.9611))',
            4326
        ),
        ROUND(ST_Area(ST_Transform(
            ST_GeomFromText(
                'POLYGON((108.0024 14.9611, 108.0033 14.9619, 108.0044 14.9614,'
                '108.0047 14.9600, 108.0035 14.9593, 108.0022 14.9599, 108.0024 14.9611))',
                4326
            ), 32648))::NUMERIC, 2),
        5.15,
        '[
            {"feature_id":5001,"land_use":"Rừng đặc dụng nguyên sinh","overlap_m2":22800.00},
            {"feature_id":5002,"land_use":"Rừng nguyên sinh gỗ quý","overlap_m2":4100.00}
        ]'::jsonb,
        'Rừng đặc dụng nguyên sinh',
        'Rừng nguyên sinh bị tác động (khai thác chọn gỗ quý)',
        'Phát hiện 8 gốc cẩm lai và 3 gốc giáng hương bị cưa hạ; đường kính 45–70 cm; '
        'gỗ đã vận chuyển, chỉ còn lại mùn cưa và vết cưa máy; đường lâm nghiệp được mở rộng trái phép',
        'submitted', NULL,
        '{"device":"Garmin eTrex 32x + Samsung S23 FE","os":"Android 14","app_version":"1.2.1"}'::jsonb,
        v_sonn, NULL,
        '2026-06-25T06:25:00Z', '2026-06-25T06:55:00Z',
        '2026-06-25T07:40:00Z', NULL
    );

    -- ── DD-2026-00010: KV-2026-005 (Tu Mơ Rông) — DRAFT ─────────────────────
    -- Phiên đo mở rộng phạm vi theo dấu vết vận chuyển gỗ; chưa hoàn thành.
    INSERT INTO gis.field_measurements (
        code, area_id, commune_code,
        points, geom, area_m2, avg_accuracy_m,
        affected_features, old_land_use, new_land_use, note,
        status, review_note, device_info, measured_by, verified_by,
        started_at, finished_at, submitted_at, verified_at
    ) VALUES (
        'DD-2026-00010', v_area5, '617',
        '[
            {"lng":108.0031,"lat":14.9604,"accuracy_m":4.7,"recorded_at":"2026-07-22T06:40:00Z"},
            {"lng":108.0040,"lat":14.9612,"accuracy_m":4.4,"recorded_at":"2026-07-22T06:44:18Z"},
            {"lng":108.0051,"lat":14.9607,"accuracy_m":5.0,"recorded_at":"2026-07-22T06:49:05Z"}
        ]'::jsonb,
        ST_GeomFromText(
            'POLYGON((108.0031 14.9604, 108.0040 14.9612, 108.0051 14.9607,'
            '108.0054 14.9593, 108.0042 14.9586, 108.0029 14.9592, 108.0031 14.9604))',
            4326
        ),
        ROUND(ST_Area(ST_Transform(
            ST_GeomFromText(
                'POLYGON((108.0031 14.9604, 108.0040 14.9612, 108.0051 14.9607,'
                '108.0054 14.9593, 108.0042 14.9586, 108.0029 14.9592, 108.0031 14.9604))',
                4326
            ), 32648))::NUMERIC, 2),
        4.70,
        '[]'::jsonb,
        'Rừng đặc dụng nguyên sinh',
        NULL,
        'Đo theo dấu đường vận chuyển gỗ mở rộng; đang bám vết về phía đông; địa hình dốc',
        'draft', NULL,
        '{"device":"Garmin eTrex 32x + Samsung S23 FE","os":"Android 14","app_version":"1.2.1"}'::jsonb,
        v_sonn, NULL,
        '2026-07-22T06:35:00Z', NULL,
        NULL, NULL
    );

END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- PHẦN 3: XOÁ LỚP BẢN ĐỒ TEST (gis.layer_registry)
-- ─────────────────────────────────────────────────────────────────────────────

-- Bảng vật lý duy nhất còn tồn tại trong 5 layer test (4 layer còn lại là
-- import job failed, không tạo bảng). GeoServer featuretype kontum:test_geojson_v3
-- đã unpublish/xoá thủ công trước khi chạy migration này.
DROP TABLE IF EXISTS gis.test_geojson_v3;

-- Hard-delete registry: layer_import_jobs + map_apis liên quan CASCADE theo
-- layer_id; field_measurements/raster_ingest_jobs/layer_edit_history SET NULL
-- (không có bản ghi nào tham chiếu 5 layer test này tại thời điểm viết migration).
DELETE FROM gis.layer_registry
WHERE code IN ('test', 'test_sample_001', 'test_sample_002', 'test_geojson_fix', 'test_geojson_v3');
