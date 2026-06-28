'use strict';

const svc = require('../services/statistics.service');
const { OK } = require('../core/success.response');
const { t } = require('../utils/i18n.util');

// GET /api/v1/stats/administrative-units?level=district
const getAdministrativeUnits = async (req, res) => {
    const data = await svc.getAdministrativeUnits({ level: req.query.level });
    return OK(res, t('get_list_success', req.lang), { units: data }, { count: data.length });
};

// GET /api/v1/stats/landcover?year=&forest_type=
const getLandcover = async (req, res) => {
    const data = await svc.getLandcover({
        year:       req.query.year ? Number(req.query.year) : null,
        forestType: req.query.forest_type || 'total',
        lang:       req.lang,
    });
    return OK(res, t('stats_landcover_success', req.lang), data);
};

// GET /api/v1/stats/dashboard?force=true
const getDashboard = async (req, res) => {
    const data = await svc.getDashboard({ lang: req.lang, force: req.query.force === 'true' });
    return OK(res, t('stats_dashboard_success', req.lang), data);
};

module.exports = {
    getAdministrativeUnits,
    getLandcover,
    getDashboard,
};
