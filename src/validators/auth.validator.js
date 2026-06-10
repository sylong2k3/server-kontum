const Joi = require('joi');

const registerSchema = Joi.object({
    email: Joi.string()
        .email()
        .required(),
    password: Joi.string()
        .min(6)
        .max(128)
        .required(),
    fullName: Joi.string()
        .min(2)
        .max(255)
        .required(),
    phone: Joi.string()
        .pattern(/^[0-9+\-\s()]{8,20}$/)
        .optional()
        .allow(null, ''),
});

const loginSchema = Joi.object({
    email: Joi.string()
        .email()
        .required(),
    password: Joi.string()
        .required(),
});

const refreshSchema = Joi.object({
    refreshToken: Joi.string()
        .required(),
});

const changePasswordSchema = Joi.object({
    oldPassword: Joi.string()
        .required(),
    newPassword: Joi.string()
        .min(6)
        .max(128)
        .required()
        .invalid(Joi.ref('oldPassword')),
});

const logoutSchema = Joi.object({
    refreshToken: Joi.string()
        .optional()
        .allow(null, ''),
});

const googleMobileSchema = Joi.object({
    idToken: Joi.string()
        .required(),
});

module.exports = {
    registerSchema,
    loginSchema,
    refreshSchema,
    changePasswordSchema,
    logoutSchema,
    googleMobileSchema,
};
