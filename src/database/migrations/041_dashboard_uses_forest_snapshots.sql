-- ============================================================================
-- Migration 041 — Xoá gis.landcover_statistics + dọn cache dashboard
--
-- Trước migration này:
--   • Dashboard 4 stat card (Tổng 616.196 ha, Tự nhiên 552.351 ha, Trồng
--     63.845 ha, Che phủ 63,69%) đọc từ gis.landcover_statistics — seed cứng
--     theo QĐ 1558/2021, QĐ 156/2023, Bộ NN&PTNT 2023/2024.
--   • Trang /statistics và endpoint GET /statistics/landcover cũng đọc từ đây.
--   • Các số này KHÔNG thay đổi khi pipeline forest classify chạy → dashboard
--     lag với thực tế + cần bảo trì mỗi khi Bộ công bố số mới.
--
-- Sau migration này:
--   • Bảng gis.landcover_statistics bị DROP hoàn toàn (không giữ, không seed).
--   • Dashboard + /statistics/landcover chuyển sang aggregate từ
--     forest.forest_snapshots + forest.forest_district_areas (nguồn nghiệp vụ
--     duy nhất — kết quả pipeline phân loại 13 lớp v5.3).
--   • gis.administrative_units GIỮ NGUYÊN (mã huyện, diện tích km², dân số —
--     dùng chung nhiều nơi, không thay được).
--
-- Idempotent: DROP TABLE IF EXISTS + DELETE cache.
-- ============================================================================

BEGIN;

-- 1. Xoá cache dashboard đang chứa 4 con số cũ (10 phút TTL). Nếu không xoá,
--    user thấy số cũ tới khi cache hết hạn.
DELETE FROM gis.stats_cache
WHERE cache_key LIKE 'dashboard:%';

-- 2. Drop bảng landcover_statistics — không còn caller sau khi refactor
--    statistics.service.js sang forest_snapshots. Các INSERT seed từ
--    017_statistics.sql (2024 official) + 023_forest_data_historical.sql
--    (2020/2022) đi theo bảng.
DROP TABLE IF EXISTS gis.landcover_statistics CASCADE;

COMMIT;
