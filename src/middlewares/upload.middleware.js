const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

const { Api400Error } = require('../core/error.response');
const { t } = require('../utils/i18n');

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
            'image/svg+xml',
            'image/tiff',
        ],
        extensions: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.tif', '.tiff'],
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

const uploadImage = createUploader(['image']);
const uploadVideo = createUploader(['video']);
const uploadDocument = createUploader(['document']);
const uploadMedia = createUploader(['image', 'video']);
const uploadAny = createUploader(['image', 'video', 'document']);

module.exports = {
    uploadImage,
    uploadVideo,
    uploadDocument,
    uploadMedia,
    uploadAny,
    handleUploadError,
    createUploader,
    FILE_CATEGORIES,
};
