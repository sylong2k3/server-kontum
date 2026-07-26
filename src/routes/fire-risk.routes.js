'use strict';

const { Router } = require('express');
const asyncHandler = require('../helpers/async-handler');
const ctrl = require('../controllers/fire-risk.controller');
const gtCtrl = require('../controllers/fire-gt.controller');
const { optionalAuth, verifyToken, requirePermission } = require('../middlewares/auth.middleware');

const router = Router();

// ── Public / optionalAuth ─────────────────────────────────────────────────────
// Kết quả dự báo cháy rừng là công khai (optionalAuth: logged-in user có thể
// nhận thêm thông tin chi tiết nếu cần mở rộng sau).
router.get('/latest',  optionalAuth, asyncHandler(ctrl.getLatest));
router.get('/map',     optionalAuth, asyncHandler(ctrl.getMap));

// Per-district downloads (migration 040): list 10 URL/huyện + area stats.
// optionalAuth để cả public + admin đọc được. Không lộ sensitive info — URL
// GEE tự expire 24h.
router.get('/snapshots/:id/districts', optionalAuth, asyncHandler(ctrl.getDistrictExports));

// Public browse các snapshot ĐÃ publish GeoServer — client sidebar dùng để
// hiển thị list history + add WMS overlay. Force hasGeoserverLayer=true trong
// controller. Trả subset field (bỏ error_message, minio_key, download URL...)
// để không leak thông tin admin. Khác với /history: /history admin-only, trả
// full field + tất cả trạng thái (completed/published/failed).
router.get('/published-history', optionalAuth, asyncHandler(ctrl.getPublishedHistory));

// ── Admin: cần đăng nhập + quyền fire_risk.manage ────────────────────────────
router.get('/history', verifyToken, requirePermission('fire_risk', 'manage'), asyncHandler(ctrl.getHistory));
router.post('/refresh', verifyToken, requirePermission('fire_risk', 'manage'), asyncHandler(ctrl.refresh));

// Publish snapshot GeoTIFF → MinIO → GeoServer, back-link `geoserver_layer` vào
// snapshot khi job xong. Cần quyền `map_layers.ingest_raster` (đã có ở system_admin
// + so_nnmt từ migration 031); union với `fire_risk.manage` để chặt hơn.
router.post('/snapshots/:id/publish-raster',
    verifyToken, requirePermission('map_layers', 'ingest_raster'),
    asyncHandler(ctrl.publishRaster));

// ── Ground truth ────────────────────────────────────────────────────────────
// Quyền `fire_risk.ground_truth` (migration 032) — chỉ system_admin + so_nnmt.
const gt = (h) => [verifyToken, requirePermission('fire_risk', 'ground_truth'), asyncHandler(h)];

// Zones
router.post  ('/ground-truth/zones',       ...gt(gtCtrl.createZone));
router.post  ('/ground-truth/zones/bulk',  ...gt(gtCtrl.bulkZone));
router.get   ('/ground-truth/zones',       ...gt(gtCtrl.listZones));
router.delete('/ground-truth/zones/:id',   ...gt(gtCtrl.deleteZone));

// Points
router.post  ('/ground-truth/points',      ...gt(gtCtrl.createPoint));
router.post  ('/ground-truth/points/bulk', ...gt(gtCtrl.bulkPoint));
router.get   ('/ground-truth/points',      ...gt(gtCtrl.listPoints));
router.delete('/ground-truth/points/:id',  ...gt(gtCtrl.deletePoint));

module.exports = router;
