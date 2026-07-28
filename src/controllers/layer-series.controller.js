'use strict';

const service = require('../services/layer-series.service');
const schemas = require('../validators/layer-series.validator');
const { OK, CREATED } = require('../core/success.response');
const { t } = require('../utils/i18n.util');

const validate = (schema, source, lang) => {
    const { value, error } = schema.validate(source, {
        abortEarly: false, stripUnknown: true, convert: true,
    });
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

const ingestGranule = async (req, res) => {
    const params = validate(schemas.groupParams, req.params, req.lang);
    try {
        const payload = validate(schemas.ingestGranule, req.body || {}, req.lang);
        const granule = await service.ingestGranule({
            groupCode: params.group,
            file: req.file,
            payload,
            user: req.user,
            lang: req.lang,
        });
        return CREATED(res, t('layer_series_granule_created', req.lang), granule);
    } catch (error) {
        if (req.file?.path) {
            await require('fs').promises.unlink(req.file.path).catch(() => {});
        }
        throw error;
    }
};

module.exports = { getTimeline, ingestGranule, listGroups };
