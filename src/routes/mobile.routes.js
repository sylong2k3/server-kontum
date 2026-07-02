const { Router } = require('express');
const asyncHandler = require('../helpers/async-handler');
const mobileController = require('../controllers/mobile.controller');
const { verifyToken, requireRole, enforcePasswordChange } = require('../middlewares/auth.middleware');
const { validate } = require('../middlewares/validate.middleware');
const { createFieldUpdateSchema, syncQuerySchema } = require('../validators/mobile.validator');

const router = Router();

// Field-updates chỉ dành cho tài khoản đã đăng nhập (kiểm lâm/so_nnmt) — không hỗ trợ anonymous
// như module feedback, vì đây là ghi trực tiếp vào dữ liệu GIS chính thức.

// POST /mobile/field-updates — đo đạc GPS + cập nhật đối tượng trên 1 layer điểm.
router.post(
    '/field-updates',
    verifyToken,
    enforcePasswordChange,
    requireRole('so_nnmt', 'system_admin'),
    validate(createFieldUpdateSchema),
    asyncHandler(mobileController.createFieldUpdate)
);

// GET /mobile/sync — đồng bộ tăng dần các field-update của chính user kể từ `since`.
router.get(
    '/sync',
    verifyToken,
    enforcePasswordChange,
    requireRole('so_nnmt', 'system_admin'),
    validate(syncQuerySchema, 'query'),
    asyncHandler(mobileController.sync)
);

module.exports = router;
