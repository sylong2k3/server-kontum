/**
 * Routes Index — Router tổng hợp
 *
 * Mount tất cả sub-routes vào đây.
 * app.js sẽ mount router này vào /api/v1
 *
 * Hiện tại:
 *   /api/v1/auth/*   — Xác thực (login, register, OAuth, ...)
 *
 * Tương lai (thêm sau):
 *   /api/v1/users/*        — Quản lý user
 *   /api/v1/monitoring/*   — Dữ liệu môi trường
 *   /api/v1/stations/*     — Trạm đo / sensor
 *   /api/v1/alerts/*       — Cảnh báo
 *   /api/v1/map/*          — GeoJSON, heatmap
 *   /api/v1/media/*        — Upload ảnh/file
 *   /api/v1/reports/*      — Báo cáo
 */

const { Router } = require('express');
const authRoutes = require('./auth.routes');

const router = Router();

// ── Auth Module ─────────────────────────────────────────────────────────
router.use('/auth', authRoutes);

// ── Placeholder cho các module tương lai ────────────────────────────────
// router.use('/users', require('./user.routes'));
// router.use('/monitoring', require('./monitoring.routes'));
// router.use('/stations', require('./station.routes'));
// router.use('/alerts', require('./alert.routes'));
// router.use('/map', require('./map.routes'));
// router.use('/media', require('./media.routes'));
// router.use('/reports', require('./report.routes'));

module.exports = router;
