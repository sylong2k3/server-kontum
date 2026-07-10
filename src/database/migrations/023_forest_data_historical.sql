-- ============================================================================
-- Migration 023: DỮ LIỆU LỊCH SỬ RỪNG KON TUM (2019–2022) — CẤP TỈNH
--
-- Mục đích: bổ sung các mốc năm để endpoint forest-change (US-061) có
--   ít nhất 3 cặp so sánh: 2020↔2022, 2022↔2023, 2023↔2024.
--
-- Nguồn dữ liệu:
--   2020 — QĐ 1558/QĐ-BNN-TCLN ngày 13/4/2021 (hiện trạng đến 31/12/2020)
--           · Rừng tự nhiên = 547.776 ha (số liệu gốc từ QĐ)
--           · Tỷ lệ che phủ = 63,02% (số liệu gốc từ QĐ)
--           · Tổng diện tích đủ tiêu chuẩn và rừng trồng được DẪN XUẤT từ
--             63,02% × 967.730 ha (diện tích tự nhiên tỉnh) — xem chú thích.
--   2021 — KHÔNG CÓ DỮ LIỆU CHÍNH THỨC khả dụng tính đến thời điểm migration.
--           Bộ NN&PTNT chỉ công bố tổng toàn quốc, không có bảng chi tiết tỉnh.
--   2022 — QĐ 156/QĐ-UBND ngày 25/4/2023 (hiện trạng đến 31/12/2022)
--           + QĐ 2357/QĐ-BNN-KL ngày 14/6/2023 (tỷ lệ che phủ quốc gia)
--
-- Chú thích phương pháp (2020):
--   QĐ 1558 công bố tổng = 621.025 ha (bao gồm rừng trồng chưa khép tán).
--   Tổng đủ tiêu chuẩn tính che phủ = 63,02% × 967.730 ha ≈ 609.863 ha.
--   Rừng trồng (đủ tiêu chuẩn) = 609.863 – 547.776 ≈ 62.087 ha.
--   Cùng phương pháp với migration 017 (chỉ lưu diện tích đủ tiêu chuẩn che phủ).
--
-- Idempotent: ON CONFLICT DO UPDATE.
-- ============================================================================

-- ── 2020: Rừng tỉnh Kon Tum (tính đến 31/12/2020) ────────────────────────────
-- Rừng tự nhiên lấy từ QĐ 1558/QĐ-BNN-TCLN; tổng + trồng dẫn xuất từ 63,02%.
INSERT INTO gis.landcover_statistics
    (unit_code, period_year, forest_type, area_ha, coverage_pct, source)
VALUES
    ('62', 2020, 'total',   609863.45, 63.02, 'QĐ 1558/QĐ-BNN-TCLN 13/4/2021'),
    ('62', 2020, 'natural', 547776.00, NULL,  'QĐ 1558/QĐ-BNN-TCLN 13/4/2021'),
    ('62', 2020, 'planted',  62087.45, NULL,  'QĐ 1558/QĐ-BNN-TCLN 13/4/2021 (dẫn xuất)')
ON CONFLICT (unit_code, period_year, forest_type) DO UPDATE SET
    area_ha      = EXCLUDED.area_ha,
    coverage_pct = EXCLUDED.coverage_pct,
    source       = EXCLUDED.source;

-- ── 2022: Rừng tỉnh Kon Tum (tính đến 31/12/2022) ────────────────────────────
-- Số liệu chính xác từ QĐ 156/QĐ-UBND ngày 25/4/2023 (tỉnh Kon Tum).
-- Tỷ lệ che phủ từ QĐ 2357/QĐ-BNN-KL ngày 14/6/2023 (toàn quốc).
INSERT INTO gis.landcover_statistics
    (unit_code, period_year, forest_type, area_ha, coverage_pct, source)
VALUES
    ('62', 2022, 'total',   609968.95, 63.05, 'QĐ 156/QĐ-UBND 25/4/2023'),
    ('62', 2022, 'natural', 547603.50, NULL,  'QĐ 156/QĐ-UBND 25/4/2023'),
    ('62', 2022, 'planted',  62365.45, NULL,  'QĐ 156/QĐ-UBND 25/4/2023')
ON CONFLICT (unit_code, period_year, forest_type) DO UPDATE SET
    area_ha      = EXCLUDED.area_ha,
    coverage_pct = EXCLUDED.coverage_pct,
    source       = EXCLUDED.source;
