const Joi = require('joi');

const feedbackCategories = ['chay_rung', 'vi_pham', 'hien_trang'];
const feedbackStatuses = ['new', 'in_progress', 'resolved', 'rejected'];
const feedbackPriorities = ['low', 'normal', 'high', 'urgent'];

const feedbackIdParamsSchema = Joi.object({
    id: Joi.number().integer().positive().required(),
});

const bboxSchema = Joi.string().trim().pattern(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?$/);

const createFeedbackSchema = Joi.object({
    category: Joi.string().valid(...feedbackCategories).required(),
    title: Joi.string().trim().min(5).max(255).required(),
    description: Joi.string().trim().max(2000).optional().allow('', null),
    priority: Joi.string().valid(...feedbackPriorities).default('normal'),
    lng: Joi.number().min(106).max(109).required(),
    lat: Joi.number().min(13).max(16.5).required(),
    clientUuid: Joi.string().trim().max(80).optional().allow('', null),
});

const listFeedbackSchema = Joi.object({
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(100).default(20),
    status: Joi.string().valid(...feedbackStatuses).optional(),
    category: Joi.string().valid(...feedbackCategories).optional(),
    priority: Joi.string().valid(...feedbackPriorities).optional(),
    q: Joi.string().trim().max(255).optional().allow(''),
    from: Joi.date().iso().optional(),
    to: Joi.date().iso().min(Joi.ref('from')).optional(),
});

const mapFeedbackSchema = Joi.object({
    status: Joi.string().valid(...feedbackStatuses).optional(),
    category: Joi.string().valid(...feedbackCategories).optional(),
    priority: Joi.string().valid(...feedbackPriorities).optional(),
    bbox: bboxSchema.optional(),
});

const updateFeedbackStatusSchema = Joi.object({
    toStatus: Joi.string().valid(...feedbackStatuses).required(),
    note: Joi.string().trim().max(1000).optional().allow('', null),
});

module.exports = {
    feedbackIdParamsSchema,
    createFeedbackSchema,
    listFeedbackSchema,
    mapFeedbackSchema,
    updateFeedbackStatusSchema,
};
