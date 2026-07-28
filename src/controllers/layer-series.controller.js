'use strict';

const layerSeriesService = require('../services/layer-series.service');
const { OK, OK_LIST, CREATED } = require('../core/success.response');
const { t } = require('../utils/i18n.util');

const listGroups = async (req, res) => {
    const items = await layerSeriesService.listGroups(req.lang);
    OK_LIST(res, t('layer_series_groups_list_success', req.lang), items, { total: items.length });
};

const listTimesteps = async (req, res) => {
    const items = await layerSeriesService.listTimesteps(req.params.group, req.lang);
    OK_LIST(res, t('layer_series_timesteps_success', req.lang), items, { total: items.length });
};

const ingestGranule = async (req, res) => {
    const file = req.file || (req.files && req.files.raster_file?.[0]);
    const granule = await layerSeriesService.ingestGranule({
        group:      req.params.group,
        yearFrom:   req.body?.year_from,
        yearTo:     req.body?.year_to,
        fileBuffer: file?.buffer,
        user:       req.user,
        lang:       req.lang,
    });
    CREATED(res, t('layer_series_ingest_success', req.lang), granule);
};

module.exports = { listGroups, listTimesteps, ingestGranule };
