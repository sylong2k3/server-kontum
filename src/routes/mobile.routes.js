const { Router } = require('express');
const asyncHandler = require('../helpers/async-handler');
const mobileController = require('../controllers/mobile.controller');
const { verifyToken, requireRole, enforcePasswordChange } = require('../middlewares/auth.middleware');
const { validate } = require('../middlewares/validate.middleware');
const { uploadImage, handleUploadError } = require('../middlewares/upload.middleware');
const {
    createFieldUpdateSchema,
    syncQuerySchema,
    adminListFieldUpdatesSchema,
} = require('../validators/mobile.validator');

const router = Router();
const adminRouter = Router();

// Field-updates chỉ dành cho tài khoản đã đăng nhập (kiểm lâm/so_nnmt) — không hỗ trợ anonymous
// như module feedback, vì đây là ghi trực tiếp vào dữ liệu GIS chính thức.

// POST /mobile/field-updates — đo đạc GPS + cập nhật đối tượng trên 1 layer điểm,
// kèm ảnh hiện trường (multipart field `media`, chỉ nhận ảnh — video không thuộc
// nghiệp vụ đo đạc). Request JSON thuần không ảnh vẫn hoạt động như cũ (multer
// bỏ qua request không phải multipart).
router.post(
    '/field-updates',
    verifyToken,
    enforcePasswordChange,
    requireRole('so_nnmt', 'system_admin'),
    uploadImage.array('media', Number(process.env.FIELD_UPDATE_MAX_MEDIA_FILES || 5)),
    handleUploadError,
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

// ─── Admin — mounted at /admin/field-updates ─────────────────────────────────

// GET /admin/field-updates — báo cáo hiện trường toàn hệ thống (MB-092):
// ubnd_tinh "xem báo cáo hiện trường" + system_admin "theo dõi dữ liệu gửi lên"
// (doc 01 §2). so_nnmt xem bản ghi của mình qua GET /mobile/sync nên không cần.
adminRouter.get(
    '/',
    verifyToken,
    enforcePasswordChange,
    requireRole('ubnd_tinh', 'system_admin'),
    validate(adminListFieldUpdatesSchema, 'query'),
    asyncHandler(mobileController.adminListFieldUpdates)
);

module.exports = { router, adminRouter };
