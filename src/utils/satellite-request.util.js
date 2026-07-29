'use strict';

const { BusinessLogicError } = require('../core/error.response');
const { StatusCodes } = require('../core/http-status-code');

function normalizeParams(raw) {
    const endDate = raw.endDate || null;
    const parsedEndDate = endDate ? new Date(endDate) : null;
    const endDateMonth = parsedEndDate && Number.isFinite(parsedEndDate.getTime())
        ? parsedEndDate.getUTCMonth() + 1
        : null;
    const requestedMonth = raw.month != null && raw.month !== ''
        ? Number(raw.month)
        : null;

    return {
        imageType:   raw.imageType   || 'rgb',
        collection:  raw.collection  || null,
        cloudCover:  raw.cloudCover  != null ? Number(raw.cloudCover) : 50,
        startDate:   raw.startDate   || null,
        endDate,
        // Mặc định neo phân loại theo tháng của endDate. Caller có thể ghi đè
        // bằng month=1..12; giữ lại giá trị này xuyên suốt cache/publish.
        month:       requestedMonth ?? endDateMonth,
        geometry:    raw.geometry    || null,
        ndviMinThresh: raw.ndviMinThresh != null ? Number(raw.ndviMinThresh) : null,
        // Forest classification v3 ground-truth params (used by /classified).
        groundTruthAssetId: raw.groundTruthAssetId ? String(raw.groundTruthAssetId).trim() : '',
        gtBufferM:          raw.gtBufferM != null ? Number(raw.gtBufferM) : 60,
        minFieldTest:       raw.minFieldTest != null ? Number(raw.minFieldTest) : 10,
        // Fire warning v8.1 params (used by /fire-risk). analysisDate falls
        // back to endDate so a single date field works for both.
        analysisDate:       raw.analysisDate || raw.endDate || null,
        enableRf:           raw.enableRf !== undefined ? Boolean(raw.enableRf) : null,
        inputFireAssetId:   raw.inputFireAssetId ? String(raw.inputFireAssetId).trim() : '',
        // Which fire-risk layer to visualise: 'riskLevel' (default), 'score',
        // 'priorityWarning', 'confidence'.
        fireLayer:          raw.fireLayer || 'riskLevel',
    };
}

function resolveClassifiedAnchor(params) {
    const endDate = new Date(params.endDate);
    if (!Number.isFinite(endDate.getTime())) {
        throw new BusinessLogicError(
            'endDate không hợp lệ.',
            ['INVALID_END_DATE'],
            StatusCodes.BAD_REQUEST,
        );
    }
    const month = Number(params.month);
    if (!Number.isInteger(month) || month < 1 || month > 12) {
        throw new BusinessLogicError(
            'month phải là số nguyên từ 1 đến 12.',
            ['INVALID_MONTH'],
            StatusCodes.BAD_REQUEST,
        );
    }
    return {
        year: endDate.getUTCFullYear(),
        month,
    };
}

module.exports = {
    normalizeParams,
    resolveClassifiedAnchor,
};
