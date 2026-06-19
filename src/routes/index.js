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
router.use('/users', userRoutes);
router.use('/notifications', notificationRoutes);
router.use('/news', newsRoutes.publicRouter);
router.use('/admin/news', newsRoutes.adminRouter);
router.use('/documents', documentRoutes.publicRouter);
router.use('/admin/documents', documentRoutes.adminRouter);
router.use('/comments', commentRoutes);
router.use('/feedback', feedbackRoutes);

module.exports = router;
