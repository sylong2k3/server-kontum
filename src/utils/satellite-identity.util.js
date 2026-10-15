'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { BusinessLogicError } = require('../core/error.response');

const NDVI_PROCESSING_VERSION = 'ndvi-bundle-v2-valid-support';
function effectiveNdviThreshold(value) {
    if (value == null) return 0.3;
    if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '' || !Number.isFinite(Number(value))) {
        throw new BusinessLogicError('ndviMinThresh phải là số hữu hạn.', ['INVALID_NDVI_THRESHOLD'], 400);
    }
    // No new range restriction: the existing route did not enforce one.
    return Number(value);
}
function ndviSignature(params, version = NDVI_PROCESSING_VERSION) {
    return {
        outputType: 'ndvi-bundle', processingVersion: version,
        collection: params.collection ? String(params.collection).toUpperCase() : 'AUTO',
        startDate: params.startDate, endDate: params.endDate, cloudCover: params.cloudCover,
        geometry: params.geometry || { boundarySha256: crypto.createHash('sha256').update(
            fs.readFileSync(path.resolve(__dirname, '../../data/RanhGioiTinh_Polygon.geojson'))).digest('hex') },
        ndviMinThresh: effectiveNdviThreshold(params.ndviMinThresh),
        policy: { composite: 'median', mask: 'gee-satellite-current-v1', areaScaleM: 100, bestEffort: true, tileScale: 8 },
    };
}
function ndviCacheHash(params, version) {
    const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
    return crypto.createHash('sha256').update(JSON.stringify(stable(ndviSignature(params, version)))).digest('hex');
}
module.exports = { effectiveNdviThreshold, ndviSignature, ndviCacheHash, NDVI_PROCESSING_VERSION };
