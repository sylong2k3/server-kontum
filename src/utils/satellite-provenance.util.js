'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const fc = require('../configs/forest-classification');
const fr = require('../configs/fire-risk');
const { NDVI_PROCESSING_VERSION, effectiveNdviThreshold } = require('./satellite-identity.util');
function effectiveRequest(input) {
    const p = { ...input };
    const type = p.imageType;
    if (type === 'ndvi') p.ndviMinThresh = effectiveNdviThreshold(p.ndviMinThresh);
    // These flags were previously ignored by normalization: retain actual defaults.
    if (type === 'classified') { p.liteMode = true; p.computeArea = true; }
    if (type === 'fire-risk') {
        p.enableRf = p.enableRf ?? fr.ENABLE_RF;
        p.analysisDate = p.analysisDate || p.endDate;
    }
    const versions = { ndvi: NDVI_PROCESSING_VERSION, heatmap: 'mod11-mean-nullable-v2',
        classified: 'v5.3-f01-seasonal-window-v1', rgb: 'rgb-current-v1', 'fire-risk': 'fire-v8.1-provenance-v1' };
    const boundarySha256 = p.geometry ? null : crypto.createHash('sha256').update(fs.readFileSync(
        path.resolve(__dirname, '../../data/RanhGioiTinh_Polygon.geojson'))).digest('hex');
    const algorithmConfig = type === 'classified' ? fc : type === 'fire-risk' ? fr : {};
    const safeConfig = Object.fromEntries(Object.entries(algorithmConfig).filter(([key, value]) =>
        typeof value !== 'function' && !/KEY|BUCKET|CRON|TTL|TIMEOUT|POLL|GRACE|URL|CONFIGURED/.test(key)));
    const sourceFiles = ['gee-satellite.util.js', ...(type === 'classified' ? ['../services/forest-classification.pipeline.js'] : type === 'fire-risk' ? ['../services/fire-risk.pipeline.js'] : [])];
    const algorithmSha256 = crypto.createHash('sha256').update(JSON.stringify(stable(safeConfig)))
        .update(sourceFiles.map(file => fs.readFileSync(path.resolve(__dirname, file))).join('')).digest('hex');
    return { schemaVersion: 1, algorithmSha256, processingVersion: versions[type], params: p, boundarySha256,
        outputType: 'raw-scientific-raster',
        products: { preview: 'visualized-rgb-tiles', download: 'visualized-rgb-tiff-zip',
            publication: 'raw-float-geotiff-cog', exportScaleM: parseInt(process.env.SATELLITE_EXPORT_SCALE_M, 10) || 30,
            gridParity: 'UNVERIFIED' },
        policy: type === 'classified' ? { skipStats: true, liteMode: true, computeArea: true,
            classNames: fc.CLASS_NAMES, areaScaleM: 200 }
            : type === 'heatmap' ? { dataset: 'MODIS/061/MOD11A1', composite: 'mean', scaleFactor: 0.02, offset: -273.15, qc: 'existing-product-mask' }
                : type === 'fire-risk' ? { featureWindowDays: fr.FEATURE_WINDOW_DAYS, nesterovLookbackDays: fr.NESTEROV_LOOKBACK_DAYS }
                    : { composite: 'median', masks: 'gee-satellite-current-v1' } };
}
function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
    return value;
}
function scientificSignature(effective) {
    return crypto.createHash('sha256').update(JSON.stringify(stable(effective))).digest('hex');
}
// Shared guard for GCS rebuild and cached-download raster ingest.
function publicationProvenance(result) {
    const { BusinessLogicError } = require('../core/error.response');
    const meta = result.metadata || {};
    if (!meta.effectiveRequest || !meta.scientificSignature) {
        throw new BusinessLogicError('Tạo lại bản xem trước trước khi xuất bản kết quả cũ.', ['PUBLICATION_PROVENANCE_REQUIRED'], 409);
    }
    const provenance = effectiveRequest(meta.effectiveRequest.params);
    if (provenance.params.imageType !== result.image_type || scientificSignature(provenance) !== meta.scientificSignature) {
        throw new BusinessLogicError('Quy trình xử lý đã thay đổi. Hãy tạo lại bản xem trước.', ['PUBLICATION_SIGNATURE_MISMATCH'], 409);
    }
    return provenance;
}
module.exports = { effectiveRequest, scientificSignature, publicationProvenance };
