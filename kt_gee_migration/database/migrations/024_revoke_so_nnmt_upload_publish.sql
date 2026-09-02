-- ══════════════════════════════════════════════════════════════════════════════
-- Migration 024: Thu hồi quyền upload ảnh viễn thám + publish lên GeoServer của so_nnmt
--
-- Trước đây so_nnmt (Sở Nông nghiệp & Môi trường) có thể upload ảnh viễn thám
-- (remote_sensing.create) và publish layer lên GeoServer (map_layers.publish).
-- Từ nay 2 quyền này chỉ dành cho system_admin. Các quyền khác của so_nnmt trên
-- remote_sensing/map_layers (read, update, delete, process, download, unpublish,
-- harvest, feature_*) giữ nguyên.
-- ══════════════════════════════════════════════════════════════════════════════

UPDATE auth.roles
SET permissions = permissions
    #- '{remote_sensing,create}'
    #- '{map_layers,publish}'
WHERE code = 'so_nnmt';
