'use strict';

const mapService       = require('../services/map.service');
const geoImportService = require('../services/geo-import.service');
const geoserver        = require('../utils/geoserver.client');
const schemas          = require('../validators/map-layer.validator');
const { geoImportPayload } = require('../validators/geo-import.validator');
const { OK, CREATED }  = require('../core/success.response');
const { t } = require('../utils/i18n.util');

const validate = (schema, source, lang = 'vi') => {
    const { value, error } = schema.validate(source, { abortEarly: false, stripUnknown: true, convert: true });
    if (error) {
        const details = error.details.map((item) => item.message);
        const err = new Error(t('invalid_data', lang));
        err.status = 400;
        err.messageKey = 'invalid_data';
        err.errors = details;
        throw err;
    }
    return value;
};

const listLayers = async (req, res) => {
    const query = validate(schemas.listLayersQuery, req.query, req.lang);
    const result = await mapService.listLayers(req.user, { page: query.page, limit: query.limit, filter: query });
    OK(res, t('map_layer_list_success', req.lang), result);
};

const getLayer = async (req, res) => {
    const layer = await mapService.getLayer(req.params.code, req.user);
    OK(res, t('map_layer_get_success', req.lang), layer);
};

const createLayer = async (req, res) => {
    const payload = validate(schemas.createLayer, req.body || {}, req.lang);
    const layer = await mapService.createLayer(payload, req.user);
    CREATED(res, t('map_layer_created_success', req.lang), layer);
};

const updateLayer = async (req, res) => {
    const payload = validate(schemas.updateLayer, req.body || {}, req.lang);
    const layer = await mapService.updateLayer(req.params.code, payload, req.user);
    OK(res, t('map_layer_updated_success', req.lang), layer);
};

const deleteLayer = async (req, res) => {
    const layer = await mapService.deleteLayer(req.params.code, req.user);
    OK(res, t('map_layer_deleted_success', req.lang), layer);
};

const publishLayer = async (req, res) => {
    const layer = await mapService.publishLayer(req.params.code, req.user);
    CREATED(res, t('map_layer_published_success', req.lang), layer);
};

const unpublishLayer = async (req, res) => {
    const layer = await mapService.unpublishLayer(req.params.code, req.user);
    OK(res, t('map_layer_unpublished_success', req.lang), layer);
};

const setLayerActive = async (req, res) => {
    const payload = validate(schemas.activeLayer, req.body || {}, req.lang);
    const layer = await mapService.setLayerActive(req.params.code, payload.is_active, req.user);
    OK(res, t(payload.is_active ? 'map_layer_activated_success' : 'map_layer_deactivated_success', req.lang), layer);
};

const listImportJobs = async (req, res) => {
    const data = await mapService.listImportJobs(req.params.code, req.query || {}, req.user);
    OK(res, t('map_import_jobs_list_success', req.lang), data);
};

const getImportJob = async (req, res) => {
    const data = await mapService.getImportJob(req.params.jobId);
    OK(res, t('map_import_job_get_success', req.lang), data);
};

const importGeoFile = async (req, res) => {
    const payload = validate(geoImportPayload, req.body || {}, req.lang);
    const result  = await geoImportService.enqueueImport({
        file:    req.geoFile,
        payload,
        user:    req.user,
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

