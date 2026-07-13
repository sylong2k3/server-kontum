const service = require('../services/field-measurement.service');
const { CREATED, OK, OK_LIST } = require('../core/success.response');
const { Api400Error } = require('../core/error.response');
const { t } = require('../utils/i18n.util');
const { buildActor } = require('../utils/actor.util');

// ── Phiên đo ──────────────────────────────────────────────────────────────────

const createMeasurement = async (req, res) => {
    const measurement = await service.createMeasurement(buildActor(req), req.body, req.lang);
    CREATED(res, t('field_measurement_created_success', req.lang), measurement);
};

const listMeasurements = async (req, res) => {
    const { page, limit } = req.query;
    const { items, total } = await service.listMeasurements(req.query);
    OK_LIST(res, t('get_list_success', req.lang), items, { page, limit, total });
};

const getMeasurementById = async (req, res) => {
    const measurement = await service.getMeasurementById(Number(req.params.id), req.lang);
    OK(res, t('get_success', req.lang), measurement);
};

const updateMeasurement = async (req, res) => {
    const measurement = await service.updateMeasurement(buildActor(req), Number(req.params.id), req.body, req.lang);
    OK(res, t('field_measurement_updated_success', req.lang), measurement);
};

const deleteMeasurement = async (req, res) => {
    await service.deleteMeasurement(buildActor(req), Number(req.params.id), req.lang);
    OK(res, t('field_measurement_deleted_success', req.lang), null);
};

const addPhotos = async (req, res) => {
    const photos = await service.addPhoto(buildActor(req), Number(req.params.id), req.files || [], req.lang);
    CREATED(res, t('field_measurement_photo_uploaded_success', req.lang), { photos });
};

const submitMeasurement = async (req, res) => {
    const measurement = await service.submitMeasurement(buildActor(req), Number(req.params.id), { lang: req.lang });
    OK(res, t('field_measurement_submitted_success', req.lang), measurement);
};

const verifyMeasurement = async (req, res) => {
    const measurement = await service.verifyMeasurement(buildActor(req), Number(req.params.id), { lang: req.lang });
    OK(res, t('field_measurement_verified_success', req.lang), measurement);
};

const rejectMeasurement = async (req, res) => {
    const measurement = await service.rejectMeasurement(buildActor(req), Number(req.params.id), req.body, { lang: req.lang });
    OK(res, t('field_measurement_rejected_success', req.lang), measurement);
};

const exportMeasurements = async (req, res) => {
    if (req.query.format === 'xlsx') {
        const buffer = await service.exportMeasurementsXlsx(req.query);
        res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.set('Content-Disposition', 'attachment; filename="field-measurements.xlsx"');
        return res.send(buffer);
    }
    const geojson = await service.exportMeasurements(req.query);
    return OK(res, t('get_success', req.lang), geojson);
};

// ── Khu vực theo dõi ──────────────────────────────────────────────────────────

const createArea = async (req, res) => {
    const area = await service.createArea(buildActor(req), req.body);
    CREATED(res, t('monitored_area_created_success', req.lang), area);
};

const listAreas = async (req, res) => {
    const { page, limit } = req.query;
    const { items, total } = await service.listAreas(req.query);
    OK_LIST(res, t('get_list_success', req.lang), items, { page, limit, total });
};

const getAreaById = async (req, res) => {
    const area = await service.getAreaWithTimeline(Number(req.params.id), req.lang);
    OK(res, t('get_success', req.lang), area);
};

const suggestAreasByPoint = async (req, res) => {
    const { lng, lat, radius_m } = req.query;
    const suggestions = await service.suggestAreasByPoint(lng, lat, radius_m);
    OK(res, t('get_success', req.lang), suggestions);
};

const suggestAreasByGeom = async (req, res) => {
    let geom;
    try {
        geom = JSON.parse(req.query.geom);
    } catch {
        throw new Api400Error(t('invalid_geometry', req.lang));
    }
    const suggestions = await service.suggestAreasByGeom(geom);
    OK(res, t('get_success', req.lang), suggestions);
};

module.exports = {
    createMeasurement,
    listMeasurements,
    getMeasurementById,
    updateMeasurement,
    deleteMeasurement,
    addPhotos,
    submitMeasurement,
    verifyMeasurement,
    rejectMeasurement,
    exportMeasurements,
    createArea,
    listAreas,
    getAreaById,
    suggestAreasByPoint,
    suggestAreasByGeom,
};
