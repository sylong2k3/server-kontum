const { Api400Error } = require('../core/error.response');
const { t } = require('../utils/i18n');

const validate = (schema, source = 'body') => {
    return (req, res, next) => {
        const data = req[source];
        const { error, value } = schema.validate(data, {
            stripUnknown: true,
            abortEarly: false,
            convert: true,
        });

        if (error) {
            const messages = error.details.map((detail) => {
                const path = detail.path.join('.');
                const type = detail.type;
                const context = detail.context || {};
                const lang = req.lang || 'vi';

                const specificKey = `${path}.${type}`;
                const generalKey = type;

                let translated = t(specificKey, lang, context);
                if (translated === specificKey) {
                    translated = t(generalKey, lang, context);
                }
                return translated === generalKey ? detail.message : translated;
            });

            throw new Api400Error(t('invalid_data', req.lang), messages);
        }

        if (source === 'query') {
            Object.defineProperty(req, 'query', { value, writable: true, configurable: true });
        } else {
            req[source] = value;
        }
        next();
    };
};

module.exports = { validate };
