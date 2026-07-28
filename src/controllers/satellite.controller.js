'use strict';

const svc       = require('../services/satellite.service');
const repo      = require('../repositories/satellite.repository');
const ingestSvc = require('../services/raster-ingest.service');
const { OK, CREATED } = require('../core/success.response');
const { Api400Error, Api404Error } = require('../core/error.response');
const { t } = require('../utils/i18n.util');

// ── POST /satellite/rgb ───────────────────────────────────────────────────────
const getRgb = async (req, res) => {
    const result = await svc.getRgb(req.body);
    OK(res, t('get_detail_success', req.lang), result);
};

// ── POST /satellite/ndvi ──────────────────────────────────────────────────────
const getNdvi = async (req, res) => {
    const result = await svc.getNdvi(req.body);
    OK(res, t('get_detail_success', req.lang), result);
};

// ── POST /satellite/heat-map ──────────────────────────────────────────────────
const getHeatmap = async (req, res) => {
    const result = await svc.getHeatmap(req.body);
    OK(res, t('get_detail_success', req.lang), result);
};

// ── POST /satellite/classified ────────────────────────────────────────────────
const getClassified = async (req, res) => {
    const result = await svc.getClassified(req.body);
    OK(res, t('get_detail_success', req.lang), result);
};

// ── POST /satellite/fire-risk ────────────────────────────────────────────────
// On-demand fire warning tile (v8.1). Body accepts:
//   analysisDate | endDate  — anchor date (required)
//   geometry                — optional custom ROI
//   enableRf                — override cfg.ENABLE_RF
//   inputFireAssetId        — override cfg.INPUT_FIRE_ASSET_ID
//   fireLayer               — 'riskLevel' | 'score' | 'priorityWarning' | 'confidence'
const getFireRisk = async (req, res) => {
    const result = await svc.getFireRisk(req.body);
    OK(res, t('get_detail_success', req.lang), result);
};

// ── POST /satellite/publish ───────────────────────────────────────────────────
// Submit async GEE export task → GeoServer. Body: { resultId }
// LEGACY path — dùng GCS batch export. Chỉ hoạt động khi GEE_GCS_BUCKET được
// cấu hình. Nếu không, dùng /results/:id/publish-raster (raster-ingest queue).
const publishToGeoServer = async (req, res) => {
    const { resultId } = req.body;
    if (!resultId) {
        return res.status(400).json({ message: 'resultId là bắt buộc.' });
    }
    const updated = await svc.publishResult(resultId);
    CREATED(res, 'Đã gửi tác vụ xuất GeoTIFF.', { result: updated });
};

// ── POST /satellite/results/:id/publish-raster ───────────────────────────────
// Path MỚI — chạy cùng cơ chế raster-ingest queue với fire-risk + forest-
// classification. Không cần GCS bucket. Tận dụng `metadata.downloadUrl` đã
// được lưu khi user chạy on-demand (POST /satellite/rgb|ndvi|heat-map|classified).
//
// Flow:
//   1. Load satellite.image_results[id] → lấy metadata.downloadUrl (GEE, TTL ~24h)
//   2. Enqueue raster-ingest job → download → MinIO → GeoServer publish
//   3. Job worker back-link geoserver_layer vào satellite.image_results khi xong
//
// Idempotent: nếu đã có geoserver_layer trả `alreadyPublished: true`.
// Force re-publish qua ?force=1.
const publishToRaster = async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
        throw new Api400Error('ID kết quả không hợp lệ.', ['INVALID_ID']);
    }
    const force = req.query.force === '1';

    const result = await repo.getById(id);
    if (!result) {
        throw new Api404Error('Kết quả không tồn tại hoặc đã hết hạn cache.', ['NOT_FOUND']);
    }

    if (result.geoserver_layer && !force) {
        return OK(res, 'Ảnh đã được công bố lên bản đồ.', {
            resultId:       id,
            geoserverLayer: result.geoserver_layer,
            alreadyPublished: true,
        });
    }

    const downloadUrl = result.metadata?.downloadUrl || null;
    if (!downloadUrl) {
        throw new Api400Error(
            'Ảnh chưa có URL tải xuống (chạy lại yêu cầu on-demand để tạo).',
            ['NO_DOWNLOAD_URL'],
        );
    }

    // Layer code chuẩn: satellite_<image_type>_<startDate>_<id>. Regex
    // gis.layer_registry yêu cầu `[a-z][a-z0-9_-]{1,58}` — normalize để
    // không lộn với gạch dưới/ngang.
    const startTag = String(result.start_date || '').slice(0, 10).replace(/-/g, '');
    const layerCode = `satellite_${result.image_type}_${startTag}_${id}`
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '_')
        .slice(0, 60);

    const { job, deduplicated } = await ingestSvc.enqueue({
        sourceUrl:  downloadUrl,
        layerCode,
        nameVi:     `Ảnh vệ tinh ${result.image_type} ${result.start_date || ''}`.trim(),
        isPublic:   true,
        category:   'satellite',
        requestParams: {
            // linkedResource type='satellite' đã được whitelist trong
            // raster-ingest.service._backLinkResource → sẽ tự update
            // satellite.image_results.geoserver_layer khi job xong.
            linkedResource: { type: 'satellite', id },
            image_type:     result.image_type,
            start_date:     result.start_date,
            end_date:       result.end_date,
            requestedBy:    req.user?.id || null,
        },
        user: req.user || null,
        lang: req.lang,
    });

    return CREATED(res, deduplicated
        ? 'Đang có job publish cho ảnh này — trả về job cũ.'
        : 'Đã tiếp nhận yêu cầu publish ảnh vệ tinh lên bản đồ.',
    {
        resultId:      id,
        jobId:         job.id,
        status:        job.status,
        layerCode,
        deduplicated:  Boolean(deduplicated),
    });
};

module.exports = { getRgb, getNdvi, getHeatmap, getClassified, getFireRisk, publishToGeoServer, publishToRaster };
