const mobileService = require('../services/mobile.service');
const { CREATED, OK, OK_LIST } = require('../core/success.response');
const { t } = require('../utils/i18n.util');
const { buildActor } = require('../utils/actor.util');

const createFieldUpdate = async (req, res) => {
    const actor = buildActor(req);
    const result = await mobileService.createFieldUpdate(actor, req.body, req.files || [], req.lang);
    const respond = result.duplicated ? OK : CREATED;
    respond(res, result.message, {
        fieldUpdate: result.fieldUpdate,
        feature: result.feature,
        duplicated: result.duplicated,
    });
};

const sync = async (req, res) => {
    const actor = buildActor(req);
    const result = await mobileService.syncSince(actor, req.query.since, req.query.limit);
    OK(res, t('mobile_sync_success', req.lang), result);
};

const adminListFieldUpdates = async (req, res) => {
    const { page, limit } = req.query;
    const { items, total } = await mobileService.adminListFieldUpdates(req.query);
    OK_LIST(res, t('get_list_success', req.lang), items, { page, limit, total });
};

module.exports = { createFieldUpdate, sync, adminListFieldUpdates };
