const db = require('../configs/database');

// ════════════════════════════════════════════════════════════════════════════
//  NOTIFICATIONS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Tạo 1 thông báo (cá nhân hoặc broadcast).
 * @param {object} p
 * @param {number|null} p.userId      null = broadcast
 * @param {string} p.audience         'user' | 'all' | 'role'
 * @param {string|null} p.audienceRole
 * @param {string} p.channel
 * @param {string} p.type
 * @param {string} p.title
 * @param {string} p.body
 * @param {object} p.data
 * @param {Date|null} p.expiresAt
 */
const create = async ({
    userId = null,
    audience = 'user',
    audienceRole = null,
    channel = 'system',
    type,
    title,
    body = null,
    data = {},
    expiresAt = null,
}) => {
    const { rows } = await db.query(
        `INSERT INTO core.notifications
            (user_id, audience, audience_role, channel, type, title, body, data, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, user_id, audience, audience_role, channel, type, title, body, data, expires_at, created_at`,
        [userId, audience, audienceRole, channel, type, title, body, JSON.stringify(data || {}), expiresAt]
    );
    return rows[0];
};

/**
 * Liệt kê thông báo của 1 user: gồm thông báo cá nhân + broadcast khớp vai trò,
 * kèm trạng thái đã đọc. Phân trang bằng limit/offset.
 */
const _escapeLike = (value) => value.replace(/[\\%_]/g, '\\$&');

const _buildVisibleNotificationFilter = ({ userId, roleCode, filter = {} }) => {
    const conditions = [
        '(n.expires_at IS NULL OR n.expires_at > NOW())',
        `(
                 n.user_id = $1
                 OR (n.user_id IS NULL AND n.audience = 'all')
                 OR (n.user_id IS NULL AND n.audience = 'role' AND n.audience_role = $2)
            )`,
    ];
    const params = [userId, roleCode];
    let idx = 3;

    if (filter.isRead !== undefined) {
        conditions.push(filter.isRead ? 'r.read_at IS NOT NULL' : 'r.read_at IS NULL');
    }
    if (filter.channel) {
        conditions.push(`LOWER(n.channel) LIKE $${idx++} ESCAPE '\\'`);
        params.push(`%${_escapeLike(filter.channel.toLowerCase())}%`);
    }
    if (filter.type) {
        conditions.push(`LOWER(n.type) LIKE $${idx++} ESCAPE '\\'`);
        params.push(`%${_escapeLike(filter.type.toLowerCase())}%`);
    }
    if (filter.audience) {
        conditions.push(`n.audience = $${idx++}`);
        params.push(filter.audience);
    }

    return {
        where: `WHERE ${conditions.join(' AND ')}`,
        params,
        nextIdx: idx,
    };
};

const NOTIFICATION_SORT_COLUMNS = {
    id: 'n.id',
    created_at: 'n.created_at',
    expires_at: 'n.expires_at',
    channel: 'n.channel',
    type: 'n.type',
    audience: 'n.audience',
    read_at: 'r.read_at',
};

const _normalizeSort = (sortBy = 'created_at', sortOrder = 'DESC') => {
    const nullableSorts = ['read_at', 'expires_at'];
    return {
        sortColumn: NOTIFICATION_SORT_COLUMNS[sortBy] || NOTIFICATION_SORT_COLUMNS.created_at,
        sortDirection: String(sortOrder).toUpperCase() === 'ASC' ? 'ASC' : 'DESC',
        nullsOrder: nullableSorts.includes(sortBy) ? 'NULLS LAST' : '',
    };
};

const listForUser = async ({ userId, roleCode, limit = 20, offset = 0, filter = {} }) => {
    const { where, params, nextIdx } = _buildVisibleNotificationFilter({ userId, roleCode, filter });
    const { sortColumn, sortDirection, nullsOrder } = _normalizeSort(filter.sortBy, filter.sortOrder);
    params.push(limit, offset);

    const { rows } = await db.query(
        `SELECT n.id, n.user_id, n.audience, n.audience_role, n.channel, n.type,
                n.title, n.body, n.data, n.expires_at, n.created_at,
                (r.read_at IS NOT NULL) AS is_read,
                r.read_at
         FROM core.notifications n
         LEFT JOIN core.notification_reads r
                ON r.notification_id = n.id AND r.user_id = $1
         ${where}
         ORDER BY ${sortColumn} ${sortDirection} ${nullsOrder}, n.id DESC
         LIMIT $${nextIdx} OFFSET $${nextIdx + 1}`,
        params
    );
    return rows;
};

/** Đếm tổng số thông báo (cho phân trang). */
const countForUser = async ({ userId, roleCode, onlyUnread = false, filter = {} }) => {
    const normalizedFilter = onlyUnread ? { ...filter, isRead: false } : filter;
    const { where, params } = _buildVisibleNotificationFilter({
        userId,
        roleCode,
        filter: normalizedFilter,
    });

    const { rows } = await db.query(
        `SELECT COUNT(*)::int AS count
         FROM core.notifications n
         LEFT JOIN core.notification_reads r
                ON r.notification_id = n.id AND r.user_id = $1
         ${where}`,
        params
    );
    return rows[0]?.count || 0;
};

/** Đếm số thông báo chưa đọc. */
const countUnread = async ({ userId, roleCode }) => {
    return countForUser({ userId, roleCode, onlyUnread: true });
};

/** Kiểm tra 1 notification có thuộc về user không (cá nhân hoặc broadcast khớp). */
const isVisibleToUser = async ({ notificationId, userId, roleCode }) => {
    const { rows } = await db.query(
        `SELECT 1
         FROM core.notifications n
         WHERE n.id = $1
           AND (n.expires_at IS NULL OR n.expires_at > NOW())
           AND (
                n.user_id = $2
                OR (n.user_id IS NULL AND n.audience = 'all')
                OR (n.user_id IS NULL AND n.audience = 'role' AND n.audience_role = $3)
           )`,
        [notificationId, userId, roleCode]
    );
    return rows.length > 0;
};

/** Đánh dấu 1 thông báo đã đọc (idempotent). */
const markRead = async ({ notificationId, userId }) => {
    await db.query(
        `INSERT INTO core.notification_reads (notification_id, user_id)
         VALUES ($1, $2)
         ON CONFLICT (notification_id, user_id) DO NOTHING`,
        [notificationId, userId]
    );
};

/** Đánh dấu tất cả thông báo (đang hiển thị, chưa đọc) của user là đã đọc. */
const markAllRead = async ({ userId, roleCode }) => {
    const { rowCount } = await db.query(
        `INSERT INTO core.notification_reads (notification_id, user_id)
         SELECT n.id, $1
         FROM core.notifications n
         WHERE (n.expires_at IS NULL OR n.expires_at > NOW())
           AND (
                n.user_id = $1
                OR (n.user_id IS NULL AND n.audience = 'all')
                OR (n.user_id IS NULL AND n.audience = 'role' AND n.audience_role = $2)
           )
         ON CONFLICT (notification_id, user_id) DO NOTHING`,
        [userId, roleCode]
    );
    return rowCount;
};

/** Xóa thông báo cá nhân của chính user (không cho xóa broadcast của người khác). */
const deletePersonal = async ({ notificationId, userId }) => {
    const { rowCount } = await db.query(
        `DELETE FROM core.notifications WHERE id = $1 AND user_id = $2`,
        [notificationId, userId]
    );
    return rowCount > 0;
};

// ════════════════════════════════════════════════════════════════════════════
//  DEVICE TOKENS
// ════════════════════════════════════════════════════════════════════════════

/** Lưu/cập nhật token thiết bị (token là unique toàn hệ thống). */
const upsertDeviceToken = async ({ userId, token, platform, deviceInfo = {} }) => {
    const { rows } = await db.query(
        `INSERT INTO core.device_tokens (user_id, token, platform, device_info, is_active, last_used_at)
         VALUES ($1, $2, $3, $4, true, NOW())
         ON CONFLICT (token) DO UPDATE
            SET user_id      = EXCLUDED.user_id,
                platform     = EXCLUDED.platform,
                device_info  = EXCLUDED.device_info,
                is_active    = true,
                last_used_at = NOW(),
                updated_at   = NOW()
         RETURNING id, user_id, token, platform, created_at`,
        [userId, token, platform, JSON.stringify(deviceInfo || {})]
    );
    return rows[0];
};

/** Gỡ (vô hiệu hóa) một token thiết bị của user. */
const removeDeviceToken = async ({ userId, token }) => {
    const { rowCount } = await db.query(
        `DELETE FROM core.device_tokens WHERE token = $1 AND user_id = $2`,
        [token, userId]
    );
    return rowCount > 0;
};

/** Lấy danh sách token đang hoạt động của 1 user. */
const getActiveTokensByUser = async (userId) => {
    const { rows } = await db.query(
        `SELECT token FROM core.device_tokens
         WHERE user_id = $1 AND is_active = true`,
        [userId]
    );
    return rows.map((r) => r.token);
};

/** Xóa các token không còn hợp lệ (FCM báo unregistered/invalid). */
const deleteTokens = async (tokens) => {
    if (!Array.isArray(tokens) || tokens.length === 0) {return 0;}
    const { rowCount } = await db.query(
        `DELETE FROM core.device_tokens WHERE token = ANY($1::text[])`,
        [tokens]
    );
    return rowCount;
};

// ════════════════════════════════════════════════════════════════════════════
//  CLEANUP (job định kỳ)
// ════════════════════════════════════════════════════════════════════════════

const cleanupExpired = async ({ retentionDays = 90, staleTokenDays = 60 } = {}) => {
    const expiredResult = await db.query(
        `DELETE FROM core.notifications
         WHERE expires_at IS NOT NULL AND expires_at < NOW()`
    );

    const oldResult = await db.query(
        `DELETE FROM core.notifications
         WHERE created_at < NOW() - INTERVAL '1 day' * $1`,
        [retentionDays]
    );

    const staleTokenResult = await db.query(
        `DELETE FROM core.device_tokens
         WHERE last_used_at < NOW() - INTERVAL '1 day' * $1`,
        [staleTokenDays]
    );

    return {
        expiredDeleted: expiredResult.rowCount,
        oldDeleted: oldResult.rowCount,
        staleTokenDeleted: staleTokenResult.rowCount,
    };
};

module.exports = {
    create,
    listForUser,
    countForUser,
    countUnread,
    isVisibleToUser,
    markRead,
    markAllRead,
    deletePersonal,

    upsertDeviceToken,
    removeDeviceToken,
    getActiveTokensByUser,
    deleteTokens,

    cleanupExpired,
};
