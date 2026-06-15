const Joi = require('joi');

const listNotificationsSchema = Joi.object({
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(100).default(20),
    onlyUnread: Joi.boolean().default(false),
    isRead: Joi.boolean().optional(),
    channel: Joi.string().trim().max(50).optional().allow(''),
    type: Joi.string().trim().max(50).optional().allow(''),
    audience: Joi.string().valid('user', 'all', 'role').optional(),
    sortBy: Joi.string()
        .valid('id', 'created_at', 'expires_at', 'channel', 'type', 'audience', 'read_at')
        .optional()
        .default('created_at'),
    sortOrder: Joi.string().valid('ASC', 'DESC', 'asc', 'desc').optional().default('DESC'),
});

const notificationIdParamsSchema = Joi.object({
    id: Joi.number().integer().positive().required(),
});

const registerDeviceSchema = Joi.object({
    token: Joi.string().min(10).max(4096).trim().required(),
    platform: Joi.string().valid('web', 'android', 'ios').required(),
    deviceInfo: Joi.object().default({}),
});

const unregisterDeviceSchema = Joi.object({
    token: Joi.string().min(10).max(4096).trim().required(),
});

const VALID_ROLES = ['system_admin', 'ubnd_tinh', 'so_nnmt', 'citizen'];

// Gửi thông báo thủ công (admin): target = user | all | role
const sendNotificationSchema = Joi.object({
    target: Joi.string().valid('user', 'all', 'role').required(),
    userId: Joi.number().integer().positive().when('target', { is: 'user', then: Joi.required() }),
    roleCode: Joi.string().valid(...VALID_ROLES).when('target', { is: 'role', then: Joi.required() }),
    channel: Joi.string().max(50).default('system'),
    type: Joi.string().max(50).required(),
    title: Joi.string().min(1).max(255).trim().required(),
    body: Joi.string().max(5000).allow('', null),
    data: Joi.object().default({}),
    expiresAt: Joi.date().iso().greater('now').optional().allow(null),
});

module.exports = {
    listNotificationsSchema,
    notificationIdParamsSchema,
    registerDeviceSchema,
    unregisterDeviceSchema,
    sendNotificationSchema,
};
