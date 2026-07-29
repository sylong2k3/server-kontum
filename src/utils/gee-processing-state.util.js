'use strict';

const geeQueue = require('../queues/gee-task.queue');

const PIPELINE_LABELS = {
    'fire-risk': 'Cảnh báo cháy rừng',
    'forest-classification': 'Phân loại lớp phủ rừng',
};

const nonNegativeInteger = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
};

const pipelineFromKey = (key) => {
    const value = String(key || '');
    if (value.startsWith('analysis:fire-risk:')) return 'fire-risk';
    if (value.startsWith('analysis:forest-classification:')) {
        return 'forest-classification';
    }
    if (value.startsWith('district-raster:fire-risk:')) return 'fire-risk';
    if (value.startsWith('district-raster:forest-classification:')) {
        return 'forest-classification';
    }
    return null;
};

const normalizeDistrictExport = (summary) => {
    if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
        return {
            status: 'not_started',
            total: 0,
            completed: 0,
            failed: 0,
            skipped: 0,
            pending: 0,
            progressPercent: 0,
        };
    }

    const total = nonNegativeInteger(summary.total);
    const completed = nonNegativeInteger(summary.completed);
    const failed = nonNegativeInteger(summary.failed);
    const skipped = nonNegativeInteger(summary.skipped);
    const settled = Math.min(total, completed + failed + skipped);
    const pending = summary.pending == null
        ? Math.max(0, total - settled)
        : Math.min(total, nonNegativeInteger(summary.pending));
    let status = 'not_started';
    if (total > 0 && pending > 0) status = settled > 0 ? 'running' : 'queued';
    if (total > 0 && pending === 0) {
        status = failed > 0 ? 'completed_with_errors' : 'completed';
    }

    return {
        status,
        total,
        completed,
        failed,
        skipped,
        pending,
        progressPercent: total > 0 ? Math.round((settled / total) * 100) : 0,
    };
};

/**
 * Trả trạng thái runtime an toàn cho UI. Không lộ raw key/label của queue.
 *
 * `taskKey` được truyền ở response POST refresh để xác định chính xác lượt vừa
 * nhận. GET latest không có key thì chọn task đầu tiên thuộc pipeline tương ứng.
 */
const buildGeeProcessingState = ({
    pipeline,
    taskKey = null,
    snapshot = null,
} = {}) => {
    const queue = geeQueue.getState();
    const prefix = `analysis:${pipeline}:`;
    const isTarget = (entry) => Boolean(entry)
        && (taskKey ? entry.key === taskKey : String(entry.key || '').startsWith(prefix));
    const activeIsTarget = isTarget(queue.active);
    const pendingIndex = queue.pending.findIndex(isTarget);
    const targetPending = pendingIndex >= 0 ? queue.pending[pendingIndex] : null;
    const jobsAhead = targetPending
        ? pendingIndex + (queue.active ? 1 : 0)
        : 0;
    const activePipeline = pipelineFromKey(queue.active?.key);
    const snapshotStatus = String(snapshot?.status || '').toLowerCase() || null;
    const districtExport = normalizeDistrictExport(
        snapshot?.district_export_summary || snapshot?.districtExportSummary,
    );

    let state = snapshotStatus || 'idle';
    if (targetPending) state = 'queued';
    else if (
        ['completed', 'published'].includes(snapshotStatus)
        && ['queued', 'running'].includes(districtExport.status)
    ) {
        state = 'exporting';
    } else if (activeIsTarget) state = 'computing';

    return {
        pipeline,
        state,
        queue: {
            status: activeIsTarget ? 'running' : targetPending ? 'queued' : 'idle',
            concurrency: queue.concurrency,
            maxPending: queue.maxPending,
            capacityRemaining: queue.capacityRemaining,
            accepting: queue.accepting,
            position: targetPending ? jobsAhead + 1 : activeIsTarget ? 0 : null,
            jobsAhead,
            waitingCount: queue.pending.length,
            enqueuedAt: targetPending?.enqueuedAt
                || (activeIsTarget ? queue.active?.enqueuedAt : null)
                || null,
            startedAt: activeIsTarget ? queue.active?.startedAt || null : null,
            globalBusy: Boolean(queue.active),
            activePipeline,
            activePipelineLabel: activePipeline
                ? PIPELINE_LABELS[activePipeline] || activePipeline
                : null,
        },
        districtExport,
        retry: {
            count: nonNegativeInteger(snapshot?.retry_count ?? snapshot?.retryCount),
            nextRetryAt: snapshot?.next_retry_at || snapshot?.nextRetryAt || null,
            lastError: snapshot?.last_retry_error
                || snapshot?.lastRetryError
                || snapshot?.error_message
                || snapshot?.errorMessage
                || null,
        },
    };
};

module.exports = {
    buildGeeProcessingState,
    normalizeDistrictExport,
};
