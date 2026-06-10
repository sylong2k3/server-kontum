const { Api400Error } = require('../core/error.response');
const validate = (schema, source = 'body') => {
    return (req, res, next) => {
        const data = req[source];

        const { error, value } = schema.validate(data, {
            // Xóa các field không có trong schema
            stripUnknown: true,
            // Trả về TẤT CẢ lỗi, không chỉ lỗi đầu tiên
            abortEarly: false,
            // Cho phép convert type (string "123" → number 123)
            convert: true,
        });

        if (error) {
            const { t } = require('../utils/i18n');
            const messages = error.details.map((detail) => {
                const path = detail.path.join('.');
                const type = detail.type;
                const context = detail.context || {};
                const lang = req.lang || 'vi';

                const specificKey = `${path}.${type}`;
                const generalKey = type;

                // 1. Try to translate using field-specific key (e.g. 'phone.string.pattern.base')
                let translated = t(specificKey, lang, context);

                // 2. Try general error type key (e.g. 'any.required')
                if (translated === specificKey) {
                    translated = t(generalKey, lang, context);
                }

                // 3. Fallback to default Joi error message
                return translated === generalKey ? detail.message : translated;
            });

            throw new Api400Error(t('invalid_data', req.lang), messages);
        }

        // Gán lại giá trị đã validate (đã stripUnknown + convert)
        req[source] = value;
        next();
    };
};

module.exports = { validate };
