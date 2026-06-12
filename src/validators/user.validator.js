const Joi = require('joi');

const VALID_ROLES = ['system_admin', 'ubnd_tinh', 'so_nnmt', 'citizen'];

const createUserSchema = Joi.object({
    email: Joi.string().email().lowercase().trim().required(),
    password: Joi.string().min(6).max(128).required(),
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
    newPassword: Joi.string().min(6).max(128).required(),
});

const updateProfileSchema = Joi.object({
    fullName: Joi.string().min(2).max(255).trim().optional(),
    phone: Joi.string().pattern(/^[0-9+\-\s()]{8,20}$/).optional().allow(null, ''),
    avatarUrl: Joi.string().uri().max(2048).optional().allow(null, ''),
});

const listUsersSchema = Joi.object({
    page: Joi.number().integer().min(1).default(1),
    pageSize: Joi.number().integer().min(1).max(100).default(20),
    roleCode: Joi.string().valid(...VALID_ROLES).optional(),
    isActive: Joi.boolean().optional(),
    email: Joi.string().max(255).optional().allow(''),
});

module.exports = { createUserSchema, updateRoleSchema, setActiveSchema, resetPasswordAdminSchema, updateProfileSchema, listUsersSchema };
