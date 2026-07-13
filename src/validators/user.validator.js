const Joi = require('joi');

const VALID_ROLES = ['system_admin', 'ubnd_tinh', 'so_nnmt', 'citizen'];

const createUserSchema = Joi.object({
    email: Joi.string().email().lowercase().trim().required(),
    password: Joi.string().min(8).max(128).pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).+$/).required(),
    fullName: Joi.string().min(2).max(255).trim().required(),
    phone: Joi.string().pattern(/^[0-9+\-\s()]{8,20}$/).optional().allow(null, ''),
    roleCode: Joi.string().valid(...VALID_ROLES).default('citizen'),
});

const updateRoleSchema = Joi.object({
    roleCode: Joi.string().valid(...VALID_ROLES).required(),
});

const setActiveSchema = Joi.object({
    isActive: Joi.boolean().required(),
});

const resetPasswordAdminSchema = Joi.object({
    newPassword: Joi.string().min(8).max(128).pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).+$/).required(),
});


const listUsersSchema = Joi.object({
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(100).default(20),
    roleCode: Joi.string().valid(...VALID_ROLES).optional(),
    isActive: Joi.boolean().optional(),
    q: Joi.string().trim().max(255).optional().allow(''),
    email: Joi.string().trim().max(255).optional().allow(''),
    sortBy: Joi.string()
        .valid('id', 'created_at', 'updated_at', 'email', 'full_name', 'phone', 'last_login_at')
        .optional()
        .default('created_at'),
    sortOrder: Joi.string().valid('ASC', 'DESC', 'asc', 'desc').optional().default('DESC'),
});

const userIdParamsSchema = Joi.object({
    id: Joi.number().integer().positive().required(),
});

module.exports = { createUserSchema, updateRoleSchema, setActiveSchema, resetPasswordAdminSchema, listUsersSchema, userIdParamsSchema };
