'use strict';

const service = require('../services/layer-series.service');
const schemas = require('../validators/layer-series.validator');
const { CREATED, OK } = require('../core/success.response');
const { t } = require('../utils/i18n.util');

const validate = (schema, source, lang) => {
    const { value, error } = schema.validate(source, { abortEarly: false, stripUnknown: true, convert: true });
    if (error) {
        const err = new Error(t('invalid_data', lang));
        err.status = 400;
        err.errors = error.details.map((item) => item.message);
        throw err;
    }
    return value;
};

const listGroups = async (req, res) => {
    const items = await service.listGroups(req.user);
    return OK(res, t('layer_series_groups_success', req.lang), { items }, { count: items.length });
};

const getTimeline = async (req, res) => {
    const params = validate(schemas.groupParams, req.params, req.lang);
    const timeline = await service.getTimeline(params.group, req.user, req.lang);
    return OK(res, t('layer_series_timeline_success', req.lang), timeline);
};

const createGroup = async (req, res) => {
    const payload = validate(schemas.createGroup, req.body || {}, req.lang);
    const group = await service.createGroup(payload, req.lang);
    return CREATED(
        res,
        req.lang === 'en' ? 'Layer group created successfully' : 'Tạo nhóm lớp thành công',
        group
    );
};

const updateGroup = async (req, res) => {
    const params = validate(schemas.groupParams, req.params, req.lang);
    const payload = validate(schemas.updateGroup, req.body || {}, req.lang);
    const group = await service.updateGroup(params.group, payload, req.lang);
    return OK(
        res,
        req.lang === 'en' ? 'Layer group updated successfully' : 'Cập nhật nhóm lớp thành công',
        group
    );
};

const deleteGroup = async (req, res) => {
    const params = validate(schemas.groupParams, req.params, req.lang);
    const group = await service.deleteGroup(params.group, req.lang);
    return OK(
        res,
        req.lang === 'en' ? 'Layer group deleted successfully' : 'Xóa nhóm lớp thành công',
        group
    );
};

const reorderSteps = async (req, res) => {
    const params = validate(schemas.groupParams, req.params, req.lang);
    const payload = validate(schemas.reorderSteps, req.body || {}, req.lang);
    const result = await service.reorderSteps(params.group, payload.order, req.lang);
    return OK(
        res,
        req.lang === 'en' ? 'Steps reordered successfully' : 'Cập nhật thứ tự thành công',
        result
    );
};

module.exports = { createGroup, deleteGroup, getTimeline, listGroups, reorderSteps, updateGroup };
