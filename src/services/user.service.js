const userRepository = require('../repositories/user.repository');
const tokenRepository = require('../repositories/token.repository');
const { hashPassword } = require('../utils/cryptoHelper');
const { Api400Error, Api403Error, Api404Error, Api409Error } = require('../core/error.response');
const { t } = require('../utils/i18n');

const SO_NNMT_ALLOWED_ROLES = ['so_nnmt', 'citizen'];

const _assertSoNnmtScope = (actorRole, targetRoleCode, lang) => {
    if (actorRole === 'system_admin') return;
    if (actorRole === 'so_nnmt' && !SO_NNMT_ALLOWED_ROLES.includes(targetRoleCode)) {
        throw new Api403Error(t('no_permission_resource', lang, { resource: 'users', action: 'manage' }));
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

const listUsers = async (filter, actor) => {
    let effectiveFilter = { ...filter };
    if (actor.role === 'so_nnmt') {
        if (filter.roleCode && !SO_NNMT_ALLOWED_ROLES.includes(filter.roleCode)) {
            return { items: [], total: 0 };
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
    const user = await userRepository.create({ email, passwordHash, fullName, phone, roleCode });
    return _sanitize(user);
};

const changeUserRole = async (userId, roleCode, actor) => {
    _assertSoNnmtScope(actor.role, roleCode, actor.lang);
    const user = await _getOrThrow(userId, actor.lang);
    _assertSoNnmtScope(actor.role, user.role, actor.lang);
    const role = await userRepository.findRoleByCode(roleCode);
    if (!role) throw new Api400Error(t('invalid_data', actor.lang));
    const updated = await userRepository.updateRole(userId, roleCode);
    return _sanitize(updated);
};

const setUserActive = async (userId, isActive, actor) => {
    const user = await _getOrThrow(userId, actor.lang);
    _assertSoNnmtScope(actor.role, user.role, actor.lang);
    if (actor.id === userId) throw new Api400Error(t('cannot_self_lock', actor.lang));
    const updated = await userRepository.updateActive(userId, isActive);
    return _sanitize(updated);
};

const resetUserPassword = async (userId, newPassword, actor) => {
    const user = await _getOrThrow(userId, actor.lang);
    _assertSoNnmtScope(actor.role, user.role, actor.lang);
    const passwordHash = await hashPassword(newPassword);
    await userRepository.updateTemporaryPassword(userId, passwordHash);
    await tokenRepository.deleteAllUserTokens(userId);
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
    await userRepository.softDelete(userId);
    await tokenRepository.deleteAllUserTokens(userId);
    return { message: t('user_deleted_success', actor.lang) };
};

const getOwnProfile = async (userId, context) => {
    const user = await userRepository.findByIdSafe(userId);
    if (!user) throw new Api404Error(t('user_not_found', context.lang));
    return _sanitize(user);
};

const updateOwnProfile = async (userId, data, context) => {
    await _getOrThrow(userId, context.lang);
    const updated = await userRepository.updateProfile(userId, data);
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
