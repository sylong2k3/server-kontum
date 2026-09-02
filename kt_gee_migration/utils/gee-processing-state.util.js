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

/**
 * Chuyển lỗi kỹ thuật thành lời giải thích an toàn, dễ hiểu cho giao diện/API.
 * Lỗi gốc vẫn được giữ trong DB và log để quản trị viên chẩn đoán.
 */
const toPublicProcessingError = (value) => {
    if (value == null || value === '') return null;
    const message = String(value);

    if (/out of memory|heap|memory limit|rss|oom/i.test(message)) {
        return 'Hệ thống tạm thiếu tài nguyên để xử lý. Yêu cầu sẽ được thử lại tự động.';
    }
    if (/timed?\s*out|timeout|deadline exceeded/i.test(message)) {
        return 'Quá trình xử lý mất nhiều thời gian hơn dự kiến. Yêu cầu sẽ được thử lại tự động.';
    }
    if (/quota|rate.?limit|too many requests|http\s*429|\b429\b/i.test(message)) {
        return 'Nguồn dữ liệu đang bận. Hệ thống sẽ tự thử lại sau.';
    }
    if (
        /permission|credential|unauthori[sz]ed|forbidden|service account|authentication/i
            .test(message)
    ) {
        return 'Nguồn dữ liệu hiện chưa sẵn sàng. Vui lòng liên hệ quản trị viên.';
    }
    if (/network|socket|econn|fetch failed|connection/i.test(message)) {
        return 'Kết nối tới nguồn dữ liệu bị gián đoạn. Hệ thống sẽ tự thử lại.';
    }

    return 'Quá trình xử lý chưa hoàn tất. Hệ thống sẽ tự thử lại; nếu lỗi lặp lại, vui lòng liên hệ quản trị viên.';
};

/**
 * Giữ nguyên nội dung nghiệp vụ của thông báo cũ nhưng thay các thuật ngữ hạ
 * tầng bằng cách diễn đạt dễ hiểu. Dùng ở đầu ra API/realtime/push để các bản
 * ghi đã lưu trước đây cũng được hiển thị đúng mà không cần xóa lịch sử.
 */
const toPublicProcessingText = (value) => {
    if (value == null || value === '') return value;

    return String(value)
        .replace(
            /Raster\s+GeoServer\s+đang\s+được\s+xử\s+lý\s+tự\s+động\.?/gi,
            'Dữ liệu bản đồ chi tiết theo huyện đang được hoàn thiện tự động.',
        )
        .replace(/\braster\s+GeoServer\b/gi, 'dữ liệu bản đồ')
        .replace(/Google\s+Earth\s+Engine/gi, 'hệ thống xử lý')
        .replace(/\bGeoServer\b/gi, 'dịch vụ bản đồ')
        .replace(/\bMinIO\b/gi, 'kho dữ liệu')
        .replace(/\bGeoTIFF\b/gi, 'dữ liệu bản đồ')
        .replace(/\bCOG\b/gi, 'dữ liệu bản đồ')
        .replace(/\bWMS\b/gi, 'dịch vụ bản đồ')
        .replace(/\bWCS\b/gi, 'dịch vụ tải bản đồ')
        .replace(/\braster\b/gi, 'dữ liệu bản đồ')
        .replace(/\bGEE\b/gi, 'hệ thống xử lý')
        .replace(/\bworker\b/gi, 'hệ thống xử lý')
        .replace(/\bpipeline\b/gi, 'quy trình xử lý')
        .replace(/\bingest\b/gi, 'cập nhật')
        .replace(/\bjob\b/gi, 'tiến trình');
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
            lastError: toPublicProcessingError(snapshot?.last_retry_error
                || snapshot?.lastRetryError
                || snapshot?.error_message
                || snapshot?.errorMessage
                || null),
        },
    };
};

module.exports = {
    buildGeeProcessingState,
    normalizeDistrictExport,
    toPublicProcessingError,
    toPublicProcessingText,
};
