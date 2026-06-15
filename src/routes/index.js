const { Router } = require('express');
const authRoutes = require('./auth.routes');
const userRoutes = require('./user.routes');
const notificationRoutes = require('./notification.routes');
const newsRoutes = require('./news.routes');
const documentRoutes = require('./document.routes');

const router = Router();

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/notifications', notificationRoutes);
router.use('/news', newsRoutes);
router.use('/documents', documentRoutes);

module.exports = router;
