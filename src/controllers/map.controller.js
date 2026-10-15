'use strict';

const fs = require('fs');

const mapService       = require('../services/map.service');
const geoImportService = require('../services/geo-import.service');
const geoserver        = require('../utils/geoserver.client');
const schemas          = require('../validators/map-layer.validator');
const { geoImportPayload } = require('../validators/geo-import.validator');
const { OK, OK_LIST, CREATED }  = require('../core/success.response');
const { Api400Error } = require('../core/error.response');
const { t } = require('../utils/i18n.util');

const validate = (schema, source, lang = 'vi') => {
    const { value, error } = schema.validate(source, { abortEarly: false, stripUnknown: true, convert: true });
    if (error) {
        const details = error.details.map((item) => item.message);
        throw new Api400Error(t('invalid_data', lang), details);
    }
    return value;
};

const listLayers = async (req, res) => {
    const query = validate(schemas.listLayersQuery, req.query, req.lang);
    const { items, page, limit, total } = await mapService.listLayers(req.user, { page: query.page, limit: query.limit, filter: query });
    OK_LIST(res, t('map_layer_list_success', req.lang), items, { page, limit, total });
};

const getLayer = async (req, res) => {
    const layer = await mapService.getLayer(req.params.code, req.user, req.lang);
    OK(res, t('map_layer_get_success', req.lang), layer);
};

const createLayer = async (req, res) => {
    const payload = validate(schemas.createLayer, req.body || {}, req.lang);
    const layer = await mapService.createLayer(payload, req.user, req.lang);
    CREATED(res, t('map_layer_created_success', req.lang), layer);
};

const updateLayer = async (req, res) => {
    const payload = validate(schemas.updateLayer, req.body || {}, req.lang);
    const layer = await mapService.updateLayer(req.params.code, payload, req.user, req.lang);
    OK(res, t('map_layer_updated_success', req.lang), layer);
};

const deleteLayer = async (req, res) => {
    const layer = await mapService.deleteLayer(req.params.code, req.user, req.lang);
    OK(res, t('map_layer_deleted_success', req.lang), layer);
};

const publishLayer = async (req, res) => {
    const layer = await mapService.publishLayer(req.params.code, req.user, req.lang);
    CREATED(res, t('map_layer_published_success', req.lang), layer);
};

const unpublishLayer = async (req, res) => {
    const layer = await mapService.unpublishLayer(req.params.code, req.user, req.lang);
    OK(res, t('map_layer_unpublished_success', req.lang), layer);
};

const setLayerActive = async (req, res) => {
    const payload = validate(schemas.activeLayer, req.body || {}, req.lang);
    const layer = await mapService.setLayerActive(req.params.code, payload.is_active, req.user, req.lang);
    OK(res, t(payload.is_active ? 'map_layer_activated_success' : 'map_layer_deactivated_success', req.lang), layer);
};

const listImportJobs = async (req, res) => {
    const data = await mapService.listImportJobs(req.params.code, req.query || {}, req.user, req.lang);
    OK(res, t('map_import_jobs_list_success', req.lang), data);
};

const getImportJob = async (req, res) => {
    const data = await mapService.getImportJob(req.params.jobId, req.lang);
    OK(res, t('map_import_job_get_success', req.lang), data);
};

const importGeoFile = async (req, res) => {
    const source = { ...(req.body || {}) };
    let payload;
    try {
        for (const field of ['default_style', 'legend_config']) {
            if (typeof source[field] === 'string') {
                try { source[field] = JSON.parse(source[field]); }
                catch { throw new Api400Error(t('invalid_data', req.lang), [`${field}: invalid JSON`]); }
            }
        }
        payload = validate(geoImportPayload, source, req.lang);
    } catch (error) {
        if (req.geoFile?.path) {
            try { fs.unlinkSync(req.geoFile.path); } catch { /* already removed */ }
        }
        throw error;
    }
    const result  = await geoImportService.enqueueImport({
        file:    req.geoFile,
        payload,
        user:    req.user,
        lang:    req.lang,
    });
    res.status(202).json({
        success: true,
        message: t('map_geo_import_accepted', req.lang),
        data:    result,
    });
};

const harvestRaster = async (req, res) => {
    const { coverageStore } = req.params;
    const { tif_path: tifPath, geoserver_layer: geoserverLayer, truncate_cache: truncateCache = true } = req.body || {};
    if (!tifPath || typeof tifPath !== 'string') {
        return res.status(400).json({ success: false, message: t('map_tif_path_required', req.lang), errors: ['TIF_PATH_REQUIRED'] });
    }
    await geoserver.harvestGeoTiff(coverageStore, tifPath);
    if (truncateCache && geoserverLayer) { await geoserver.truncateGwcLayer(geoserverLayer); }
    OK(res, t('map_harvest_success', req.lang), { coverageStore, geoserverLayer: geoserverLayer || null });
};

module.exports = {
    createLayer, deleteLayer, getImportJob,
    getLayer, harvestRaster, importGeoFile, listImportJobs, listLayers,
    publishLayer, setLayerActive, unpublishLayer, updateLayer,
};

