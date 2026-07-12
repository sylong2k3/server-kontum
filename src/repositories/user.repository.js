const db = require('../configs/database');
const { versionCondition } = require('../utils/optimistic-lock.util');

const USER_SELECT = `
    SELECT u.id, u.email, u.password_hash, u.full_name, u.phone, u.avatar_url,
           u.role_id, r.code AS role, r.name_vi AS role_name_vi, r.name_en AS role_name_en, r.permissions AS role_permissions,
           u.is_active, u.email_verified, u.email_verified_at, u.login_attempts, u.locked_until,
           u.password_changed_at, u.last_login_at, u.last_login_ip,
           u.must_change_password,
           u.created_at, u.updated_at
    FROM auth.users u
    INNER JOIN auth.roles r ON u.role_id = r.id
`;

const findById = async (id) => {
    const { rows } = await db.query(`${USER_SELECT} WHERE u.id = $1 AND u.deleted_at IS NULL`, [id]);
    return rows[0] || null;
};

const findByEmail = async (email) => {
    const { rows } = await db.query(
        `${USER_SELECT} WHERE LOWER(u.email) = LOWER($1) AND u.deleted_at IS NULL`,
        [email]
    );
    return rows[0] || null;
};

const create = async ({ email, passwordHash, fullName, phone, roleCode = 'citizen', avatarUrl }) => {
    const { rows } = await db.query(
        `INSERT INTO auth.users (email, password_hash, full_name, phone, avatar_url, role_id, email_verified, email_verified_at)
         VALUES ($1, $2, $3, $4, $5, (SELECT id FROM auth.roles WHERE code = $6 AND is_active = true), true, NOW())
         RETURNING id`,
        [email, passwordHash || null, fullName, phone || null, avatarUrl || null, roleCode]
    );
    return rows[0] ? findById(rows[0].id) : null;
};

const updatePassword = async (userId, newPasswordHash) => {
    const { rows } = await db.query(
        `UPDATE auth.users
         SET password_hash = $2, password_changed_at = NOW(), must_change_password = false
         WHERE id = $1
         RETURNING id, email, full_name, password_changed_at, updated_at`,
        [userId, newPasswordHash]
    );
    return rows[0] || null;
};

const updateLoginSuccess = async (userId, ipAddress) => {
    await db.query(
        `UPDATE auth.users
         SET login_attempts = 0, locked_until = NULL, last_login_at = NOW(), last_login_ip = $2
         WHERE id = $1`,
        [userId, ipAddress]
    );
};

const incrementLoginAttempts = async (userId, maxAttempts = 5, lockMinutes = 15) => {
    const { rows } = await db.query(
        `UPDATE auth.users
         SET login_attempts = login_attempts + 1,
             locked_until = CASE
                 WHEN login_attempts + 1 >= $2
                 THEN NOW() + INTERVAL '1 minute' * $3
                 ELSE locked_until
             END
         WHERE id = $1
         RETURNING login_attempts, locked_until`,
        [userId, maxAttempts, lockMinutes]
    );
    return rows[0] || null;
};

const updateAvatar = async (userId, avatarUrl) => {
    await db.query(`UPDATE auth.users SET avatar_url = $2 WHERE id = $1`, [userId, avatarUrl]);
};

const markEmailVerified = async (userId) => {
    await db.query(
        `UPDATE auth.users SET email_verified = true, email_verified_at = NOW()
         WHERE id = $1 AND email_verified = false`,
        [userId]
    );
};

const findByIdSafe = async (userId) => {
    const { rows } = await db.query(
        `SELECT u.id, u.email, u.full_name, u.phone, u.avatar_url,
                u.role_id, r.code AS role, r.name_vi AS role_name_vi, r.name_en AS role_name_en, r.permissions AS role_permissions,
                u.is_active, u.email_verified, u.email_verified_at, u.last_login_at,
                u.must_change_password, u.created_at, u.updated_at,
                (
                    SELECT json_agg(json_build_object(
                        'provider', sa.provider,
                        'provider_email', sa.provider_email,
                        'linked_at', sa.created_at
                    ))
                    FROM auth.social_accounts sa
                    WHERE sa.user_id = u.id AND sa.is_active = true
                ) AS social_accounts
         FROM auth.users u
         INNER JOIN auth.roles r ON u.role_id = r.id
         WHERE u.id = $1 AND u.deleted_at IS NULL`,
        [userId]
    );
    return rows[0] || null;
};

const _escapeLike = (value) => value.replace(/[\\%_]/g, '\\$&');

const _buildUserFilter = ({ roleCode, roleCodes, isActive, email }, startIdx = 1) => {
    const conditions = ['u.deleted_at IS NULL'];
    const params = [];
    let idx = startIdx;

    if (roleCodes && roleCodes.length) {
        conditions.push(`r.code = ANY($${idx++})`);
        params.push(roleCodes);
    } else if (roleCode !== undefined) {
        conditions.push(`r.code = $${idx++}`);
        params.push(roleCode);
    }
    if (isActive !== undefined) { conditions.push(`u.is_active = $${idx++}`); params.push(isActive); }
    if (email) {
        conditions.push(`LOWER(u.email) LIKE $${idx++} ESCAPE '\\'`);
        params.push(`%${_escapeLike(email.toLowerCase())}%`);
    }

    return {
        where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
        params,
        nextIdx: idx,
    };
};

const USER_SORT_COLUMNS = {
    id: 'u.id',
    created_at: 'u.created_at',
    updated_at: 'u.updated_at',
    email: 'u.email',
    full_name: 'u.full_name',
    phone: 'u.phone',
    last_login_at: 'u.last_login_at',
};

const _normalizeSort = (sortBy = 'created_at', sortOrder = 'DESC') => ({
    sortColumn: USER_SORT_COLUMNS[sortBy] || USER_SORT_COLUMNS.created_at,
    sortDirection: String(sortOrder).toUpperCase() === 'ASC' ? 'ASC' : 'DESC',
});

const findAll = async ({ roleCode, roleCodes, isActive, email, page = 1, limit = 20, sortBy = 'created_at', sortOrder = 'DESC' } = {}) => {
    const filter = { roleCode, roleCodes, isActive, email };
    const { where, params, nextIdx } = _buildUserFilter(filter);
    const offset = (page - 1) * limit;
    const { sortColumn, sortDirection } = _normalizeSort(sortBy, sortOrder);
    params.push(limit, offset);

    const { rows } = await db.query(
        `SELECT u.id, u.email, u.full_name, u.phone, u.avatar_url,
                u.role_id, r.code AS role, r.name_vi AS role_name_vi, r.name_en AS role_name_en,
                u.is_active, u.email_verified, u.last_login_at,
                u.must_change_password, u.created_at, u.updated_at,
                COUNT(*) OVER()::int AS total_count
         FROM auth.users u
         INNER JOIN auth.roles r ON u.role_id = r.id
         ${where}
         ORDER BY ${sortColumn} ${sortDirection}, u.id DESC
         LIMIT $${nextIdx} OFFSET $${nextIdx + 1}`,
        params
    );

    if (rows.length === 0) {
        const total = offset > 0 ? await countAll(filter) : 0;
        return { items: [], total };
    }

    const total = rows[0].total_count;
    const items = rows.map(({ total_count, ...row }) => row);
    return { items, total };
};

const countAll = async ({ roleCode, roleCodes, isActive, email } = {}) => {
    const { where, params } = _buildUserFilter({ roleCode, roleCodes, isActive, email });

    const { rows } = await db.query(
        `SELECT COUNT(u.id)::int AS total
         FROM auth.users u
         INNER JOIN auth.roles r ON u.role_id = r.id
         ${where}`,
        params
    );
    return rows[0]?.total || 0;
};

const updateRole = async (userId, roleCode) => {
    const { rows } = await db.query(
        `UPDATE auth.users
         SET role_id = (SELECT id FROM auth.roles WHERE code = $2 AND is_active = true)
         WHERE id = $1 AND deleted_at IS NULL
         RETURNING id`,
        [userId, roleCode]
    );
    return rows[0] ? findById(rows[0].id) : null;
};

const updateActive = async (userId, isActive) => {
    const { rows } = await db.query(
         `UPDATE auth.users SET is_active = $2 WHERE id = $1 AND deleted_at IS NULL
         RETURNING id, email, is_active, updated_at`,
        [userId, isActive]
    );
    return rows[0] || null;
};

const updateTemporaryPassword = async (userId, passwordHash) => {
    const { rows } = await db.query(
        `UPDATE auth.users
         SET password_hash = $2, must_change_password = true, password_changed_at = NOW()
         WHERE id = $1 AND deleted_at IS NULL
         RETURNING id, email, must_change_password, updated_at`,
        [userId, passwordHash]
    );
    return rows[0] || null;
};

const updateProfile = async (userId, { fullName, phone, avatarUrl, expectedUpdatedAt }) => {
    const sets = [];
    const params = [];
    let idx = 1;

    if (fullName !== undefined)  { sets.push(`full_name = $${idx++}`);  params.push(fullName); }
    if (phone !== undefined)     { sets.push(`phone = $${idx++}`);      params.push(phone); }
    if (avatarUrl !== undefined) { sets.push(`avatar_url = $${idx++}`); params.push(avatarUrl); }

    if (!sets.length) {return findByIdSafe(userId);}

    params.push(userId);
    const idIdx = params.length;
    // auth.users có trigger trigger_users_updated_at tự set updated_at = NOW() mỗi lần UPDATE.
    let lockSql = '';
    if (expectedUpdatedAt) {
        params.push(expectedUpdatedAt);
        lockSql = versionCondition(params.length);
    }
    const { rows } = await db.query(
        `UPDATE auth.users SET ${sets.join(', ')} WHERE id = $${idIdx} AND deleted_at IS NULL${lockSql} RETURNING id`,
        params
    );
    return rows[0] ? findByIdSafe(rows[0].id) : null;
};

const softDelete = async (userId) => {
    const { rows } = await db.query(
        `UPDATE auth.users
         SET deleted_at = NOW(), is_active = false
         WHERE id = $1 AND deleted_at IS NULL
         RETURNING id, email, deleted_at`,
        [userId]
    );
    return rows[0] || null;
};

const countActiveUsersByRole = async (roleCode) => {
    const { rows } = await db.query(
        `SELECT COUNT(u.id)::int AS total
         FROM auth.users u
         INNER JOIN auth.roles r ON u.role_id = r.id
         WHERE r.code = $1 AND u.deleted_at IS NULL AND u.is_active = true`,
        [roleCode]
    );
    return rows[0]?.total || 0;
};

const findRoleByCode = async (code) => {
    const { rows } = await db.query(
        `SELECT id, code, name_vi, name_en, description_vi, description_en, permissions, sort_order, is_active
         FROM auth.roles WHERE code = $1 AND is_active = true`,
        [code]
    );
    return rows[0] || null;
};

const findAllRoles = async () => {
    const { rows } = await db.query(
        `SELECT id, code, name_vi, name_en, description_vi, description_en, permissions, sort_order, is_active
         FROM auth.roles WHERE is_active = true ORDER BY sort_order ASC`
    );
    return rows;
};

module.exports = {
    findById,
    findByEmail,
    create,
    updatePassword,
    updateLoginSuccess,
    incrementLoginAttempts,
    updateAvatar,
    markEmailVerified,
    findByIdSafe,
    findAll,
    countAll,
    updateRole,
    updateActive,
    updateTemporaryPassword,
    updateProfile,
    softDelete,
    countActiveUsersByRole,
    findRoleByCode,
    findAllRoles,
};
