'use strict';

const ingestSvc  = require('../services/raster-ingest.service');
const schemas    = require('../validators/raster-ingest.validator');
const { OK, CREATED } = require('../core/success.response');
const { t } = require('../utils/i18n.util');

const DEBUG = process.env.RASTER_INGEST_DEBUG === 'true'
    || process.env.NODE_ENV === 'development';
const dbg = (msg) => { if (DEBUG) console.debug(`[RASTER-INGEST-CTL] ${msg}`); };

const validate = (schema, source, lang = 'vi') => {
    const { value, error } = schema.validate(source, {
        abortEarly: false, stripUnknown: true, convert: true,
    });
    if (error) {
        const err = new Error(t('invalid_data', lang));
        err.status = 400;
        err.errors = error.details.map((d) => d.message);
        throw err;
    }
    return value;
};

// ── POST /api/v1/map/rasters/ingest-gee ──────────────────────────────────────

const enqueueGeeIngest = async (req, res) => {
    const payload = validate(schemas.enqueueGeeIngest, req.body || {}, req.lang);
    dbg(`POST /ingest-gee layer=${payload.layer_code} user=${req.user?.id || 'anon'}`);

    const { job, deduplicated } = await ingestSvc.enqueue({
        sourceUrl:  payload.source_url,
        layerCode:  payload.layer_code,
        nameVi:     payload.name_vi,
        nameEn:     payload.name_en,
        isPublic:   payload.is_public,
        category:   payload.category,
        requestParams: {
            gee_map_id:  payload.gee_map_id,
            gee_task_id: payload.gee_task_id,
            bbox:        payload.bbox,
            epsg_code:   payload.epsg_code,
            scale_m:     payload.scale_m,
            data_year:   payload.data_year,
            layer_group: payload.layer_group,
        },
        user: req.user,
        lang: req.lang,
    });

    // Dedupe → 200 (không phải 201) để client biết là hit cache job cũ.
    const respond = deduplicated ? OK : CREATED;
    return respond(res, t(
        deduplicated ? 'raster_ingest_deduplicated' : 'raster_ingest_accepted',
        req.lang,
    ), {
        job_id:       job.id,
        status:       job.status,
        layer_code:   job.layer_code,
        deduplicated: deduplicated || false,
    });
};

// ── GET /api/v1/map/rasters/ingest-jobs/:id ──────────────────────────────────

const getIngestJob = async (req, res) => {
    const id = Number(req.params.id);
    const job = await ingestSvc.getJobById(id, req.lang);
    dbg(`GET /ingest-jobs/${id} → status=${job.status} progress=${job.progress}`);
    OK(res, t('raster_ingest_job_get_success', req.lang), job);
};

// ── GET /api/v1/map/layers/:code/ingest-jobs ─────────────────────────────────

const listIngestJobsByLayer = async (req, res) => {
    const jobs = await ingestSvc.listJobsByLayer(req.params.code, req.query || {});
    OK(res, t('raster_ingest_jobs_list_success', req.lang), jobs);
};

module.exports = { enqueueGeeIngest, getIngestJob, listIngestJobsByLayer };
