const userRepository = require('../repositories/user.repository');
const tokenRepository = require('../repositories/token.repository');
const { hashPassword } = require('../utils/cryptoHelper.util');
const { Api400Error, Api403Error, Api404Error, Api409Error } = require('../core/error.response');
const { t } = require('../utils/i18n.util');

const SO_NNMT_ALLOWED_ROLES = ['so_nnmt', 'citizen'];
const PG_UNIQUE_VIOLATION = '23505';

const _assertSoNnmtScope = (actorRole, targetRoleCode, lang) => {
    if (actorRole === 'system_admin') return;
    if (actorRole === 'so_nnmt' && targetRoleCode !== 'citizen') {
        throw new Api403Error(t('no_permission_resource', lang, { resource: 'users', action: 'manage' }));
    }
};

const _assertNotLastActiveSystemAdmin = async (targetUser, lang) => {
    if (targetUser.role !== 'system_admin') return;
    const activeSystemAdmins = await userRepository.countActiveUsersByRole('system_admin');
    if (activeSystemAdmins <= 1) {
        throw new Api400Error(t('invalid_data', lang), [t('cannot_modify_last_admin', lang)]);
    }
};

const _getOrThrow = async (userId, lang) => {
    const user = await userRepository.findById(userId);
    if (!user) throw new Api404Error(t('user_not_found', lang));
    return user;
};

const _sanitize = (user) => {
    if (!user) return null;
    const { password_hash, login_attempts, locked_until, ...safe } = user;
    return safe;
};

const _normalizeNullable = (value) => (value === '' ? null : value);

const _logAdminActivity = async (actor, action, targetUserId, metadata = {}) => {
    try {
        await tokenRepository.logActivity({
            userId: actor.id || null,
            action,
            status: 'success',
            ipAddress: actor.ipAddress,
            userAgent: actor.userAgent,
            metadata: {
                targetUserId,
                actorRole: actor.role,
                ...metadata,
            },
        });
    } catch (err) {
        console.error('[USER] Admin activity log failed:', err.message);
    }
};

const listUsers = async (filter, actor) => {
    const effectiveFilter = { ...filter };
    if (actor.role === 'so_nnmt') {
        if (filter.roleCode && !SO_NNMT_ALLOWED_ROLES.includes(filter.roleCode)) {
            throw new Api403Error(t('no_permission_resource', actor.lang, { resource: 'users', action: 'list' }));
        }
        if (!filter.roleCode) effectiveFilter.roleCodes = SO_NNMT_ALLOWED_ROLES;
    }
    const [items, total] = await Promise.all([
        userRepository.findAll(effectiveFilter),
        userRepository.countAll(effectiveFilter),
    ]);
    return { items: items.map(_sanitize), total };
};

const createUser = async ({ email, password, fullName, phone, roleCode = 'citizen' }, actor) => {
    _assertSoNnmtScope(actor.role, roleCode, actor.lang);
    const existing = await userRepository.findByEmail(email);
    if (existing) throw new Api409Error(t('email_in_use', actor.lang));
    const role = await userRepository.findRoleByCode(roleCode);
    if (!role) throw new Api400Error(t('invalid_data', actor.lang));

    const passwordHash = await hashPassword(password);
    let user;
    try {
        user = await userRepository.create({
            email,
            passwordHash,
            fullName,
            phone: _normalizeNullable(phone),
            roleCode,
        });
    } catch (err) {
        if (err.code === PG_UNIQUE_VIOLATION) {
            throw new Api409Error(t('email_in_use', actor.lang));
        }
        throw err;
    }

    await _logAdminActivity(actor, 'user_create', user.id, { roleCode });
    return _sanitize(user);
};

const changeUserRole = async (userId, roleCode, actor) => {
    _assertSoNnmtScope(actor.role, roleCode, actor.lang);
    const user = await _getOrThrow(userId, actor.lang);
    _assertSoNnmtScope(actor.role, user.role, actor.lang);
    if (actor.id === userId) throw new Api400Error(t('invalid_data', actor.lang), [t('cannot_change_own_role', actor.lang)]);
    if (user.role === 'system_admin' && roleCode !== 'system_admin') {
        await _assertNotLastActiveSystemAdmin(user, actor.lang);
    }
    const role = await userRepository.findRoleByCode(roleCode);
    if (!role) throw new Api400Error(t('invalid_data', actor.lang));
    const updated = await userRepository.updateRole(userId, roleCode);
    await _logAdminActivity(actor, 'user_role_change', userId, { fromRole: user.role, toRole: roleCode });
    return _sanitize(updated);
};

const setUserActive = async (userId, isActive, actor) => {
    const user = await _getOrThrow(userId, actor.lang);
    _assertSoNnmtScope(actor.role, user.role, actor.lang);
    if (actor.id === userId) throw new Api400Error(t('cannot_self_lock', actor.lang));
    if (user.role === 'system_admin' && isActive === false) {
        await _assertNotLastActiveSystemAdmin(user, actor.lang);
    }
    const updated = await userRepository.updateActive(userId, isActive);

    if (!isActive) {
        await tokenRepository.deleteAllUserTokens(userId);
    }

    await _logAdminActivity(actor, 'user_active_change', userId, { fromActive: user.is_active, toActive: isActive });
    return _sanitize(updated);
};

const resetUserPassword = async (userId, newPassword, actor) => {
    const user = await _getOrThrow(userId, actor.lang);
    _assertSoNnmtScope(actor.role, user.role, actor.lang);
    const passwordHash = await hashPassword(newPassword);
    await userRepository.updateTemporaryPassword(userId, passwordHash);
    await tokenRepository.deleteAllUserTokens(userId);
    await _logAdminActivity(actor, 'admin_password_reset', userId, { targetRole: user.role });
    return { message: t('password_reset_admin_success', actor.lang) };
};

const getUserById = async (userId, actor) => {
    const user = await _getOrThrow(userId, actor.lang);
    _assertSoNnmtScope(actor.role, user.role, actor.lang);
    return _sanitize(user);
};

const deleteUser = async (userId, actor) => {
    const user = await _getOrThrow(userId, actor.lang);
    _assertSoNnmtScope(actor.role, user.role, actor.lang);
    if (actor.id === userId) throw new Api400Error(t('cannot_self_delete', actor.lang));
    if (user.role === 'system_admin') {
        await _assertNotLastActiveSystemAdmin(user, actor.lang);
    }
    await userRepository.softDelete(userId);
    await tokenRepository.deleteAllUserTokens(userId);
    await _logAdminActivity(actor, 'user_delete', userId, { targetRole: user.role, targetEmail: user.email });
    return { message: t('user_deleted_success', actor.lang) };
};

const getOwnProfile = async (userId, context) => {
    const user = await userRepository.findByIdSafe(userId);
    if (!user) throw new Api404Error(t('user_not_found', context.lang));
    return _sanitize(user);
};

const updateOwnProfile = async (userId, data, context) => {
    await _getOrThrow(userId, context.lang);
    const normalized = {
        ...data,
        phone: data.phone !== undefined ? _normalizeNullable(data.phone) : undefined,
        avatarUrl: data.avatarUrl !== undefined ? _normalizeNullable(data.avatarUrl) : undefined,
    };
    const updated = await userRepository.updateProfile(userId, normalized);
    return _sanitize(updated);
};

module.exports = {
    listUsers,
    createUser,
    changeUserRole,
    setUserActive,
    resetUserPassword,
    getUserById,
    deleteUser,
    getOwnProfile,
    updateOwnProfile,
};
