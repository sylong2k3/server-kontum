'use strict';

const { Router } = require('express');
const asyncHandler = require('../helpers/async-handler');
const ctrl = require('../controllers/fire-risk.controller');
const { optionalAuth, verifyToken, requirePermission } = require('../middlewares/auth.middleware');

const router = Router();

// ── Public / optionalAuth ─────────────────────────────────────────────────────
// Kết quả dự báo cháy rừng là công khai (optionalAuth: logged-in user có thể
// nhận thêm thông tin chi tiết nếu cần mở rộng sau).
router.get('/latest',  optionalAuth, asyncHandler(ctrl.getLatest));
router.get('/map',     optionalAuth, asyncHandler(ctrl.getMap));

// ── Admin: cần đăng nhập + quyền fire_risk.manage ────────────────────────────
router.get('/history', verifyToken, requirePermission('fire_risk', 'manage'), asyncHandler(ctrl.getHistory));
router.post('/refresh', verifyToken, requirePermission('fire_risk', 'manage'), asyncHandler(ctrl.refresh));

// Publish snapshot GeoTIFF → MinIO → GeoServer, back-link `geoserver_layer` vào
// snapshot khi job xong. Cần quyền `map_layers.ingest_raster` (đã có ở system_admin
// + so_nnmt từ migration 031); union với `fire_risk.manage` để chặt hơn.
router.post('/snapshots/:id/publish-raster',
    verifyToken, requirePermission('map_layers', 'ingest_raster'),
    asyncHandler(ctrl.publishRaster));

module.exports = router;
