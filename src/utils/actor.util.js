const buildActor = (req) => req.user ? ({
    id: req.user.id,
    role: req.user.role,
    lang: req.lang,
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
}) : null;

module.exports = { buildActor };
