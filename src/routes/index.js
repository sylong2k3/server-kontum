const { Router } = require('express');
const authRoutes = require('./auth.routes');
const userRoutes = require('./user.routes');
const notificationRoutes = require('./notification.routes');
const newsRoutes = require('./news.routes');
const documentRoutes = require('./document.routes');
const commentRoutes = require('./comment.routes');
const feedbackRoutes = require('./feedback.routes');

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

module.exports = router;
