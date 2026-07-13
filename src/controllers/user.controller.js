const userService = require('../services/user.service');
const { OK, CREATED, OK_LIST } = require('../core/success.response');
const { t } = require('../utils/i18n.util');
const { buildActor } = require('../utils/actor.util');

const listUsers = async (req, res) => {
    const { page, limit, roleCode, isActive, q, email, sortBy, sortOrder } = req.query;
    const actor = buildActor(req);
    const filter = { page, limit, roleCode, isActive, q, email, sortBy, sortOrder };
    const { items, total } = await userService.listUsers(filter, actor);
    OK_LIST(res, t('get_list_success', req.lang), items, {
        page: filter.page,
        limit: filter.limit,
        total,
        totalPages: Math.ceil(total / filter.limit),
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


module.exports = { listUsers, createUser, getUserById, changeUserRole, setUserActive, resetUserPassword, deleteUser };
