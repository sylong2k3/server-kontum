const feedbackRepository = require('../repositories/feedback.repository');
const notificationService = require('./notification.service');
const { Api400Error, Api403Error, Api404Error } = require('../core/error.response');
const { t } = require('../utils/i18n.util');
const { stripTags } = require('../utils/cms.util');

const STAFF_ROLES = ['system_admin', 'so_nnmt', 'ubnd_tinh'];
const STATUS_TRANSITIONS = {
    new: ['in_progress', 'rejected'],
    in_progress: ['resolved', 'rejected'],
    resolved: [],
    rejected: [],
};

const isStaff = (actor) => actor && STAFF_ROLES.includes(actor.role);

const toMediaUrls = (files = []) => files.map((file) => `${file._relativeDir}/${file.filename}`);

const parseBbox = (bbox) => {
    if (!bbox) {return null;}
    const values = String(bbox).split(',').map(Number);
    if (values.length !== 4 || values.some(Number.isNaN)) {return null;}
    const [minLng, minLat, maxLng, maxLat] = values;
    if (minLng >= maxLng || minLat >= maxLat) {return null;}
    return values;
};

const toFeedbackItem = (row) => ({
    id: row.id,
    userId: row.user_id,
    anonymousId: row.anonymous_id,
    clientUuid: row.client_uuid,
    category: row.category,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    mediaUrls: row.media_urls || [],
    lng: row.lng,
    lat: row.lat,
    userName: row.user_name,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    updatedBy: row.updated_by,
    updatedByName: row.updated_by_name,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
});

const toStatusLog = (row) => ({
    id: row.id,
    feedbackId: row.feedback_id,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    note: row.note,
    changedBy: row.changed_by,
    changedByName: row.changed_by_name,
    changedAt: row.changed_at,
});

const ensureOwnerIdentity = (actor, anonymousId, lang) => {
    if (actor?.id) {return { userId: actor.id, anonymousId: null };}
    if (!anonymousId) {throw new Api400Error(t('feedback_anonymous_required', lang));}
    return { userId: null, anonymousId };
};

const canAccessOwn = (actor, feedback, anonymousId) => {
    if (actor?.id && Number(feedback.user_id) === Number(actor.id)) {return true;}
    return Boolean(anonymousId && feedback.anonymous_id === anonymousId);
};

// Gửi realtime/push best-effort — lỗi notification không được làm hỏng luồng chính.
const dispatchSafe = (fn) => {
    try {
        const result = fn();
        if (result && typeof result.catch === 'function') {
            result.catch((err) => console.error('[FEEDBACK] notify error:', err.message));
        }
    } catch (err) {
        console.error('[FEEDBACK] notify error:', err.message);
    }
};

const createFeedback = async (actor, payload, files = [], context = {}) => {
    const identity = ensureOwnerIdentity(actor, context.anonymousId, context.lang);
    const clientUuid = payload.clientUuid || null;

    const duplicate = await feedbackRepository.findDuplicate({
        userId: identity.userId,
        anonymousId: identity.anonymousId,
        clientUuid,
    });
    if (duplicate) {
        return {
            message: t('feedback_created_success', context.lang),
            feedback: toFeedbackItem(duplicate),
            duplicated: true,
        };
    }

    const feedback = await feedbackRepository.create({
        ...identity,
        clientUuid,
        category: payload.category,
        title: stripTags(payload.title),
        description: payload.description ? stripTags(payload.description) : null,
        priority: payload.priority || 'normal',
        mediaUrls: toMediaUrls(files),
        lng: payload.lng,
        lat: payload.lat,
        createdBy: actor?.id || null,
    });

    // Doc 14 §I1 — phản ánh cháy rừng broadcast ngay cho so_nnmt (WS + FCM topic role).
    // Đối chiếu "gần vùng nguy cơ ≥ cấp 4" để nâng priority sẽ bổ sung khi EP-06 có dữ liệu fire.*.
    if (feedback.category === 'chay_rung') {
        dispatchSafe(() => notificationService.broadcastToRole('so_nnmt', {
            channel: 'feedback',
            type: 'feedback_fire_report',
            title: t('feedback_notify_fire_title', context.lang),
            body: t('feedback_notify_fire_body', context.lang, { title: feedback.title }),
            data: {
                feedbackId: feedback.id,
                category: feedback.category,
                priority: feedback.priority,
                lng: feedback.lng,
                lat: feedback.lat,
            },
        }, context));
    }

    return {
        message: t('feedback_created_success', context.lang),
        feedback: toFeedbackItem(feedback),
        duplicated: false,
    };
};

const listFeedback = async (actor, query = {}, context = {}) => {
    if (!isStaff(actor)) {throw new Api403Error(t('no_permission', context.lang));}

    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;
    const offset = (page - 1) * limit;
    const filter = {
        status: query.status,
        category: query.category,
        priority: query.priority,
        q: query.q,
        from: query.from,
        to: query.to,
    };

    const { items, total } = await feedbackRepository.findAll({ limit, offset, filter });

    return { items: items.map(toFeedbackItem), total };
};

const listMine = async (actor, query = {}, context = {}) => {
    const identity = ensureOwnerIdentity(actor, context.anonymousId, context.lang);
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;
    const offset = (page - 1) * limit;
    const filter = {
        userId: identity.userId,
        anonymousId: identity.anonymousId,
        status: query.status,
        category: query.category,
        priority: query.priority,
        q: query.q,
        from: query.from,
        to: query.to,
    };

    const { items, total } = await feedbackRepository.findAll({ limit, offset, filter });

    return { items: items.map(toFeedbackItem), total };
};

const getFeedbackById = async (actor, id, context = {}) => {
    const feedback = await feedbackRepository.findById(id);
    if (!feedback) {throw new Api404Error(t('feedback_not_found', context.lang));}

    if (!isStaff(actor) && !canAccessOwn(actor, feedback, context.anonymousId)) {
        throw new Api403Error(t('no_permission', context.lang));
    }

    // Doc 14 §I4 — chủ phản ánh cũng thấy lịch sử trạng thái + phản hồi cơ quan.
    const logs = await feedbackRepository.findStatusLogs(id);
    return { ...toFeedbackItem(feedback), statusLogs: logs.map(toStatusLog) };
};

const updateStatus = async (actor, id, payload, context = {}) => {
    if (!actor) {throw new Api403Error(t('no_permission', context.lang));}

    const existing = await feedbackRepository.findById(id);
    if (!existing) {throw new Api404Error(t('feedback_not_found', context.lang));}

    if (actor.role !== 'system_admin') {
        const allowed = STATUS_TRANSITIONS[existing.status] || [];
        if (!allowed.includes(payload.toStatus)) {
            throw new Api400Error(t('feedback_invalid_transition', context.lang));
        }
    }

    const note = payload.note ? stripTags(payload.note) : null;
    const updated = await feedbackRepository.updateStatus(id, {
        toStatus: payload.toStatus,
        note,
        changedBy: actor.id,
    });
    if (!updated) {throw new Api404Error(t('feedback_not_found', context.lang));}

    // Doc 14 §I2 — thông báo người gửi khi trạng thái thay đổi (chỉ user đăng nhập,
    // phản ánh ẩn danh không có kênh nhận).
    if (existing.user_id) {
        dispatchSafe(() => notificationService.sendToUser(existing.user_id, {
            channel: 'feedback',
            type: 'feedback_status_changed',
            title: t('feedback_notify_status_title', context.lang),
            body: t('feedback_notify_status_body', context.lang, {
                title: existing.title,
                status: t(`feedback_status_${payload.toStatus}`, context.lang),
            }),
            data: {
                feedbackId: Number(id),
                fromStatus: existing.status,
                toStatus: payload.toStatus,
                note,
            },
        }, context));
    }

    return {
        message: t('feedback_updated_success', context.lang),
        feedback: toFeedbackItem(updated),
    };
};

const getMap = async (actor, query = {}, context = {}) => {
    if (!isStaff(actor)) {throw new Api403Error(t('no_permission', context.lang));}
    const bbox = parseBbox(query.bbox);
    if (query.bbox && !bbox) {throw new Api400Error(t('feedback_invalid_bbox', context.lang));}

    return feedbackRepository.findGeoJson({
        filter: {
            status: query.status,
            category: query.category,
            priority: query.priority,
            bbox,
        },
    });
};

module.exports = {
    createFeedback,
    listFeedback,
    listMine,
    getFeedbackById,
    updateStatus,
    getMap,
};
