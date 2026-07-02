const mobileService = require('../services/mobile.service');
const { CREATED, OK } = require('../core/success.response');
const { t } = require('../utils/i18n.util');
const { buildActor } = require('../utils/actor.util');

const createFieldUpdate = async (req, res) => {
    const actor = buildActor(req);
    const result = await mobileService.createFieldUpdate(actor, req.body, req.lang);
    const respond = result.duplicated ? OK : CREATED;
    respond(res, result.message, {
        fieldUpdate: result.fieldUpdate,
        feature: result.feature,
        duplicated: result.duplicated,
    });
};

const sync = async (req, res) => {
    const actor = buildActor(req);
    const result = await mobileService.syncSince(actor, req.query.since);
    OK(res, t('mobile_sync_success', req.lang), result);
};

module.exports = { createFieldUpdate, sync };
