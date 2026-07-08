const Joi = require('joi');

// Request kèm ảnh đi dạng multipart/form-data nên `attributes` tới nơi là
// chuỗi JSON thay vì object — chấp nhận cả hai dạng.
const attributesSchema = Joi.alternatives()
    .try(
        Joi.object().pattern(Joi.string(), Joi.any()),
        Joi.string().trim().allow('').custom((value, helpers) => {
            if (value === '') { return {}; }
            try {
                const parsed = JSON.parse(value);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) { return parsed; }
            } catch (err) { /* rơi xuống helpers.error bên dưới */ }
            return helpers.error('any.invalid');
        }),
    )
    .default({});

const createFieldUpdateSchema = Joi.object({
    layerCode: Joi.string().trim().max(60).required(),
    featureId: Joi.number().integer().positive().optional().allow(null),
    lng: Joi.number().min(106).max(109).required(),
    lat: Joi.number().min(13).max(16.5).required(),
    attributes: attributesSchema,
    clientUuid: Joi.string().trim().max(80).optional().allow('', null),
    note: Joi.string().trim().max(1000).optional().allow('', null),
});

const syncQuerySchema = Joi.object({
    since: Joi.date().iso().optional(),
    limit: Joi.number().integer().min(1).max(1000).default(500),
});

// GET /admin/field-updates — báo cáo hiện trường cho ubnd_tinh/system_admin.
const adminListFieldUpdatesSchema = Joi.object({
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(100).default(20),
    layerCode: Joi.string().trim().max(60).optional(),
    userId: Joi.number().integer().positive().optional(),
    action: Joi.string().valid('insert', 'update').optional(),
    from: Joi.date().iso().optional(),
    to: Joi.date().iso().min(Joi.ref('from')).optional(),
});

module.exports = { createFieldUpdateSchema, syncQuerySchema, adminListFieldUpdatesSchema };
