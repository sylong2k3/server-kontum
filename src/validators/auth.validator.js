const Joi = require('joi');

const registerSchema = Joi.object({
    email: Joi.string()
        .email()
        .lowercase()
        .trim()
        .required(),
    password: Joi.string()
        .min(6)
        .max(128)
        .required(),
    fullName: Joi.string()
        .min(2)
        .max(255)
        .trim()
        .required(),
    phone: Joi.string()
        .pattern(/^[0-9+\-\s()]{8,20}$/)
        .optional()
        .allow(null, ''),
});

const loginSchema = Joi.object({
    email: Joi.string()
        .email()
        .lowercase()
        .trim()
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

const forgotPasswordSchema = Joi.object({
    email: Joi.string()
        .email()
        .lowercase()
        .trim()
        .required(),
});

const resetPasswordSchema = Joi.object({
    token: Joi.string()
        .required(),
    newPassword: Joi.string()
        .min(6)
        .max(128)
        .required(),
});

const oauthExchangeSchema = Joi.object({
    code: Joi.string()
        .required(),
});

const verifyEmailSchema = Joi.object({
    token: Joi.string()
        .required(),
});

const resendVerificationSchema = Joi.object({
    email: Joi.string()
        .email()
        .lowercase()
        .trim()
        .required(),
});

module.exports = {
    registerSchema,
    loginSchema,
    refreshSchema,
    changePasswordSchema,
    logoutSchema,
    googleMobileSchema,
    forgotPasswordSchema,
    resetPasswordSchema,
    oauthExchangeSchema,
    verifyEmailSchema,
    resendVerificationSchema,
};
