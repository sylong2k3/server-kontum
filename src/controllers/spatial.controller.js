'use strict';

const svc = require('../services/spatial.service');
const { OK } = require('../core/success.response');
const { t } = require('../utils/i18n.util');

// GET /api/v1/spatial/forest-change?from_year=&to_year=&forest_type=&unit_code=
const getForestChange = async (req, res) => {
    const data = await svc.getForestChange({
        fromYear:   Number(req.query.from_year),
        toYear:     Number(req.query.to_year),
        forestType: req.query.forest_type || 'total',
        unitCode:   req.query.unit_code || null,
        lang:       req.lang,
    });
    return OK(res, t('spatial_forest_change_success', req.lang), data);
};

// GET /api/v1/spatial/residential-distance?residential_code=&forest_code=&threshold_m=
const getResidentialDistance = async (req, res) => {
    const data = await svc.getResidentialDistance({
        residentialCode: req.query.residential_code,
        forestCode:      req.query.forest_code,
        thresholdM:      Number(req.query.threshold_m) || 500,
        limit:           Number(req.query.limit) || 500,
        lang:            req.lang,
    });
    return OK(res, t('spatial_residential_distance_success', req.lang), data);
};

module.exports = {
    getForestChange,
    getResidentialDistance,
};
