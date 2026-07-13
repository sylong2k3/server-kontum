const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

const { Api400Error } = require('../core/error.response');
const { t } = require('../utils/i18n.util');

const MB = 1024 * 1024;

const FILE_CATEGORIES = {
    image: {
        dir: 'images',
        maxSize: Number(process.env.UPLOAD_IMAGE_MAX_MB || 5) * MB,
        mimeTypes: [
            'image/jpeg',
            'image/png',
            'image/gif',
            'image/webp',
            'image/bmp',
            'image/tiff',
        ],
        extensions: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tif', '.tiff'],
    },
    video: {
        dir: 'videos',
        maxSize: Number(process.env.UPLOAD_VIDEO_MAX_MB || 100) * MB,
        mimeTypes: [
            'video/mp4',
            'video/mpeg',
            'video/quicktime',
            'video/x-msvideo',
            'video/x-matroska',
            'video/webm',
            'video/x-ms-wmv',
            'video/3gpp',
        ],
        extensions: ['.mp4', '.mpeg', '.mpg', '.mov', '.avi', '.mkv', '.webm', '.wmv', '.3gp'],
    },
    document: {
        dir: 'documents',
        maxSize: Number(process.env.UPLOAD_DOCUMENT_MAX_MB || 20) * MB,
        mimeTypes: [
            'application/pdf',
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/vnd.ms-excel',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'application/vnd.ms-powerpoint',
            'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            'text/plain',
            'text/csv',
            'application/zip',
            'application/x-rar-compressed',
            'application/x-7z-compressed',
        ],
        extensions: [
            '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
            '.txt', '.csv', '.zip', '.rar', '.7z',
        ],
    },
    pdf_map: {
        dir: 'pdf-maps',
        maxSize: Number(process.env.UPLOAD_PDF_MAP_MAX_MB || 100) * MB,
        mimeTypes: [
            'application/pdf',
            'image/jpeg', 'image/png', 'image/webp',
            'image/tiff', 'image/bmp', 'image/gif',
        ],
        extensions: ['.pdf', '.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff', '.bmp', '.gif'],
    },
};

const UPLOAD_ROOT = path.join(process.cwd(), 'public', 'uploads');

const ensureDir = (dir) => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
};

const slugifyName = (name) => {
    return name
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/g, 'd')
        .replace(/Đ/g, 'D')
        .replace(/[^a-zA-Z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase()
        .slice(0, 50) || 'file';
};

const generateFilename = (originalname) => {
    const ext = path.extname(originalname).toLowerCase();
    const base = slugifyName(path.basename(originalname, path.extname(originalname)));
    const unique = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
    return `${base}-${unique}${ext}`;
};

const detectCategory = (file, allowedCategories) => {
    const ext = path.extname(file.originalname).toLowerCase();
    for (const category of allowedCategories) {
        const cfg = FILE_CATEGORIES[category];
        if (cfg.mimeTypes.includes(file.mimetype) && cfg.extensions.includes(ext)) {
            return category;
        }
    }
    return null;
};

const createUploader = (allowedCategories) => {
    const maxSize = Math.max(...allowedCategories.map((c) => FILE_CATEGORIES[c].maxSize));

    const storage = multer.diskStorage({
        destination: (req, file, cb) => {
            const category = detectCategory(file, allowedCategories);
            if (!category) {
                return cb(new Api400Error(t('upload_invalid_type', req.lang)));
            }
            const now = new Date();
            const year = String(now.getFullYear());
            const month = String(now.getMonth() + 1).padStart(2, '0');
            const dest = path.join(UPLOAD_ROOT, FILE_CATEGORIES[category].dir, year, month);

            try {
                ensureDir(dest);
                file._relativeDir = `/uploads/${FILE_CATEGORIES[category].dir}/${year}/${month}`;
                file._category = category;
                cb(null, dest);
            } catch (err) {
                cb(err);
            }
        },
        filename: (req, file, cb) => {
            cb(null, generateFilename(file.originalname));
        },
    });

    const fileFilter = (req, file, cb) => {
        const category = detectCategory(file, allowedCategories);
        if (!category) {
            const err = new Api400Error(
                t('upload_invalid_type', req.lang),
                [`INVALID_FILE_TYPE: ${file.originalname} (${file.mimetype})`],
            );
            return cb(err, false);
        }
        cb(null, true);
    };

    return multer({
        storage,
        fileFilter,
        limits: {
            fileSize: maxSize,
            files: Number(process.env.UPLOAD_MAX_FILES || 20),
        },
    });
};

const handleUploadError = (err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        let message;
        switch (err.code) {
            case 'LIMIT_FILE_SIZE':
                message = t('upload_file_too_large', req.lang);
                break;
            case 'LIMIT_FILE_COUNT':
            case 'LIMIT_UNEXPECTED_FILE':
                message = t('upload_too_many_files', req.lang);
                break;
            default:
                message = t('upload_failed', req.lang);
        }
        return next(new Api400Error(message, [err.code, err.field].filter(Boolean)));
    }
    return next(err);
};

// createFieldsUploader — multer.fields() với mỗi field một category riêng.
// fieldCategoryMap: { fieldName: 'category_key', … }
const createFieldsUploader = (fieldCategoryMap) => {
    const maxSize = Math.max(...Object.values(fieldCategoryMap).map((c) => FILE_CATEGORIES[c].maxSize));

    const storage = multer.diskStorage({
        destination: (req, file, cb) => {
            const categoryKey = fieldCategoryMap[file.fieldname];
            const cfg = FILE_CATEGORIES[categoryKey];
            const now = new Date();
            const year = String(now.getFullYear());
            const month = String(now.getMonth() + 1).padStart(2, '0');
            const dest = path.join(UPLOAD_ROOT, cfg.dir, year, month);
            try {
                ensureDir(dest);
                file._relativeDir = `/uploads/${cfg.dir}/${year}/${month}`;
                file._category = categoryKey;
                cb(null, dest);
            } catch (err) {
                cb(err);
            }
        },
        filename: (req, file, cb) => {
            cb(null, generateFilename(file.originalname));
        },
    });

    const fileFilter = (req, file, cb) => {
        const categoryKey = fieldCategoryMap[file.fieldname];
        if (!categoryKey) {
            return cb(new Api400Error(t('upload_invalid_type', req.lang), [`UNEXPECTED_FIELD: ${file.fieldname}`]), false);
        }
        const cfg = FILE_CATEGORIES[categoryKey];
        const ext = path.extname(file.originalname).toLowerCase();
        if (cfg.mimeTypes.includes(file.mimetype) && cfg.extensions.includes(ext)) {
            return cb(null, true);
        }
        return cb(new Api400Error(
            t('upload_invalid_type', req.lang),
            [`INVALID_FILE_TYPE: ${file.originalname} (${file.mimetype}) for field "${file.fieldname}"`],
        ), false);
    };

    const fields = Object.keys(fieldCategoryMap).map((name) => ({ name, maxCount: 1 }));

    return multer({ storage, fileFilter, limits: { fileSize: maxSize, files: fields.length } }).fields(fields);
};

const uploadImage = createUploader(['image']);
const uploadVideo = createUploader(['video']);
const uploadDocument = createUploader(['document']);
const uploadPdfMap = createUploader(['pdf_map']);
// file=PDF bản đồ (bắt buộc), thumbnail=ảnh preview (tuỳ chọn)
const uploadPdfMapFields = createFieldsUploader({ file: 'pdf_map', thumbnail: 'image' });
const uploadMedia = createUploader(['image', 'video']);
const uploadAny = createUploader(['image', 'video', 'document']);

// uploadFieldPhotos — memory storage (buffer đi thẳng lên MinIO, không ghi đĩa cục bộ).
// Dùng cho ảnh hiện trường của phiên đo đạc (field-measurement).
const uploadFieldPhotos = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: FILE_CATEGORIES.image.maxSize,
        files: Number(process.env.FIELD_MEASUREMENT_MAX_PHOTOS || 10),
    },
    fileFilter: (req, file, cb) => {
        const cfg = FILE_CATEGORIES.image;
        const ext = path.extname(file.originalname).toLowerCase();
        if (cfg.mimeTypes.includes(file.mimetype) && cfg.extensions.includes(ext)) {
            return cb(null, true);
        }
        return cb(new Api400Error(
            t('upload_invalid_type', req.lang),
            [`INVALID_FILE_TYPE: ${file.originalname} (${file.mimetype})`],
        ), false);
    },
});

module.exports = {
    uploadImage,
    uploadVideo,
    uploadDocument,
    uploadPdfMap,
    uploadPdfMapFields,
    uploadMedia,
    uploadFieldPhotos,
    uploadAny,
    handleUploadError,
    createUploader,
    createFieldsUploader,
    FILE_CATEGORIES,
};
