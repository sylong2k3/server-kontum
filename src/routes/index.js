const { Router } = require('express');
const authRoutes = require('./auth.routes');
const userRoutes = require('./user.routes');
const notificationRoutes = require('./notification.routes');
const newsRoutes = require('./news.routes');
const documentRoutes = require('./document.routes');
const commentRoutes = require('./comment.routes');
const feedbackRoutes = require('./feedback.routes');
const remoteSensingRoutes = require('./remote-sensing.routes');
const mapRoutes = require('./map.routes');
const pdfMapRoutes = require('./pdf-map.routes');
const weatherRoutes = require('./weather.routes');
const mapApiRoutes = require('./map-api.routes');

const router = Router();

router.use('/auth', authRoutes);
router.use('/admin/users', userRoutes.adminRouter);
router.use('/notifications', notificationRoutes);
router.use('/news', newsRoutes.publicRouter);
router.use('/admin/news', newsRoutes.adminRouter);
router.use('/documents', documentRoutes.publicRouter);
router.use('/admin/documents', documentRoutes.adminRouter);
router.use('/feedback', feedbackRoutes.publicRouter);
router.use('/admin/feedback', feedbackRoutes.adminRouter);
router.use('/admin/comments', commentRoutes.adminRouter);
router.use('/pdf-maps', pdfMapRoutes.publicRouter);
router.use('/admin/pdf-maps', pdfMapRoutes.adminRouter);
router.use('/map', mapRoutes);

// ── Chia sẻ API lớp dữ liệu bản đồ (US-025) ──────────────────────────────────
router.use('/map-apis', mapApiRoutes.adminRouter);   // admin quản lý api_key
router.use('/map-data', mapApiRoutes.dataRouter);    // consumer dùng X-Map-Api-Key

// ── Thời tiết / Weather (EP-05) ──────────────────────────────────────────────
router.use('/weather', weatherRoutes);

// ── Remote Sensing / Viễn thám ───────────────────────────────────────────────
router.use('/remote-sensing', remoteSensingRoutes);

module.exports = router;
