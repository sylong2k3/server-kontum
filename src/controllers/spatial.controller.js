'use strict';

const svc = require('../services/spatial.service');
const { OK } = require('../core/success.response');
const { t } = require('../utils/i18n.util');

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
    getResidentialDistance,
};
