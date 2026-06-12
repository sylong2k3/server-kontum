const userService = require('../services/user.service');
const { OK, CREATED, OK_LIST } = require('../core/success.response');
const { t } = require('../utils/i18n.util');

const buildActor = (req) => ({
    id: req.user.id,
    role: req.user.role,
    lang: req.lang,
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
});

const listUsers = async (req, res) => {
    const { page, pageSize, roleCode, isActive, email } = req.query;
    const actor = buildActor(req);
    const filter = { page, pageSize, roleCode, isActive, email };
    const { items, total } = await userService.listUsers(filter, actor);
    OK_LIST(res, t('get_list_success', req.lang), items, {
        page: filter.page,
        limit: filter.pageSize,
        total,
        totalPages: Math.ceil(total / filter.pageSize),
    });
};

const createUser = async (req, res) => {
    const user = await userService.createUser(req.body, buildActor(req));
    CREATED(res, t('user_created_success', req.lang), user);
};

const getUserById = async (req, res) => {
    const user = await userService.getUserById(Number(req.params.id), buildActor(req));
    OK(res, t('get_success', req.lang), user);
};

const changeUserRole = async (req, res) => {
    const user = await userService.changeUserRole(
        Number(req.params.id), req.body.roleCode, buildActor(req)
    );
    OK(res, t('user_role_updated', req.lang), user);
};

const setUserActive = async (req, res) => {
    const result = await userService.setUserActive(
        Number(req.params.id), req.body.isActive, buildActor(req)
    );
    OK(res, req.body.isActive ? t('user_unlocked', req.lang) : t('user_locked', req.lang), result);
};

const resetUserPassword = async (req, res) => {
    const result = await userService.resetUserPassword(
        Number(req.params.id), req.body.newPassword, buildActor(req)
    );
    OK(res, result.message, {});
};

const deleteUser = async (req, res) => {
    const result = await userService.deleteUser(
        Number(req.params.id), buildActor(req)
    );
    OK(res, result.message, {});
};

const getOwnProfile = async (req, res) => {
    const user = await userService.getOwnProfile(req.user.id, { lang: req.lang });
    OK(res, t('get_me_success', req.lang), user);
};

const updateOwnProfile = async (req, res) => {
    const user = await userService.updateOwnProfile(req.user.id, req.body, { lang: req.lang });
    OK(res, t('profile_updated', req.lang), user);
};

module.exports = { listUsers, createUser, getUserById, changeUserRole, setUserActive, resetUserPassword, deleteUser, getOwnProfile, updateOwnProfile };
