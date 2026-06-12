/**
 * pushProvider — Lớp đẩy push notification qua Firebase Cloud Messaging (FCM).
 *
 * FCM phủ cả 3 nền tảng: Android (native), iOS (qua APNs), và Web Push.
 * Nhờ vậy chỉ cần MỘT tích hợp cho web + android + ios.
 *
 * Thiết kế "degrade an toàn": nếu chưa cài firebase-admin hoặc chưa cấu hình
 * credentials, toàn bộ hàm push trở thành no-op (chỉ log cảnh báo 1 lần) để
 * server vẫn chạy bình thường — giống cách mailer bọc try/catch.
 *
 * Cấu hình (chọn 1 trong các cách, theo thứ tự ưu tiên):
 *   - FIREBASE_SERVICE_ACCOUNT_BASE64 : nội dung JSON service account đã base64
 *   - FIREBASE_SERVICE_ACCOUNT        : đường dẫn tới file service account JSON
 *   - GOOGLE_APPLICATION_CREDENTIALS  : đường dẫn (firebase-admin tự nhận diện)
 *   - PUSH_ENABLED=false              : tắt cứng dù đã có credentials
 */

let admin = null;            // module firebase-admin (lazy)
let messaging = null;        // instance messaging
let initialized = false;     // đã thử init chưa
let available = false;       // FCM dùng được không
let warnedUnavailable = false;

const isExplicitlyDisabled = () => process.env.PUSH_ENABLED === 'false';

const loadServiceAccount = () => {
    if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
        const json = Buffer
            .from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64')
            .toString('utf8');
        return JSON.parse(json);
    }
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        // Đường dẫn resolve theo thư mục chạy server (process.cwd()) cho ổn định,
        // hỗ trợ cả đường dẫn tương đối lẫn tuyệt đối.
        const path = require('path');
        const filePath = path.resolve(process.cwd(), process.env.FIREBASE_SERVICE_ACCOUNT);
        const raw = require('fs').readFileSync(filePath, 'utf8');
        return JSON.parse(raw);
    }
    return null; // dựa vào GOOGLE_APPLICATION_CREDENTIALS (applicationDefault)
};

const warnOnce = (message) => {
    if (!warnedUnavailable) {
        console.warn(`[PUSH] ${message} — push notifications disabled (WebSocket + DB vẫn hoạt động).`);
        warnedUnavailable = true;
    }
};

const init = () => {
    if (initialized) {return available;}
    initialized = true;

    if (isExplicitlyDisabled()) {
        warnOnce('PUSH_ENABLED=false');
        return false;
    }

    try {
        // eslint-disable-next-line global-require
        admin = require('firebase-admin');
    } catch (_) {
        warnOnce('Chưa cài đặt package "firebase-admin"');
        return false;
    }

    try {
        const serviceAccount = loadServiceAccount();
        const hasDefault = !!process.env.GOOGLE_APPLICATION_CREDENTIALS;

        if (!serviceAccount && !hasDefault) {
            warnOnce('Chưa cấu hình FIREBASE_SERVICE_ACCOUNT / GOOGLE_APPLICATION_CREDENTIALS');
            return false;
        }

        if (!admin.apps.length) {
            admin.initializeApp({
                credential: serviceAccount
                    ? admin.credential.cert(serviceAccount)
                    : admin.credential.applicationDefault(),
            });
        }

        messaging = admin.messaging();
        available = true;
        console.log('  ✓ Push provider (FCM) initialized');
    } catch (err) {
        warnOnce(`Khởi tạo FCM thất bại: ${err.message}`);
        available = false;
    }

    return available;
};

const isAvailable = () => init();

/**
 * Gửi push tới một danh sách token thiết bị.
 * @returns {Promise<{ successCount, failureCount, invalidTokens: string[] }>}
 *   invalidTokens: token không còn hợp lệ → caller nên gỡ khỏi DB.
 */
const sendToTokens = async (tokens, { title, body, data = {} }) => {
    const result = { successCount: 0, failureCount: 0, invalidTokens: [] };
    if (!isAvailable() || !Array.isArray(tokens) || tokens.length === 0) {
        return result;
    }

    // FCM giới hạn 500 token mỗi lần gọi sendEachForMulticast.
    const BATCH_SIZE = 500;
    const stringData = _stringifyData(data);

    for (let i = 0; i < tokens.length; i += BATCH_SIZE) {
        const batch = tokens.slice(i, i + BATCH_SIZE);
        try {
            const resp = await messaging.sendEachForMulticast({
                tokens: batch,
                notification: { title, body: body || '' },
                data: stringData,
            });

            result.successCount += resp.successCount;
            result.failureCount += resp.failureCount;

            resp.responses.forEach((r, idx) => {
                if (!r.success && _isInvalidTokenError(r.error)) {
                    result.invalidTokens.push(batch[idx]);
                }
            });
        } catch (err) {
            console.error('[PUSH] sendToTokens batch failed:', err.message);
            result.failureCount += batch.length;
        }
    }

    return result;
};

/**
 * Gửi push tới một topic (dùng cho broadcast: 'all', 'role_citizen'...).
 */
const sendToTopic = async (topic, { title, body, data = {} }) => {
    if (!isAvailable() || !topic) {return false;}
    try {
        await messaging.send({
            topic,
            notification: { title, body: body || '' },
            data: _stringifyData(data),
        });
        return true;
    } catch (err) {
        console.error(`[PUSH] sendToTopic(${topic}) failed:`, err.message);
        return false;
    }
};

/** Đăng ký token vào topic (gọi khi register device). Best-effort. */
const subscribeToTopic = async (tokens, topic) => {
    if (!isAvailable() || !topic) {return;}
    const list = Array.isArray(tokens) ? tokens : [tokens];
    if (list.length === 0) {return;}
    try {
        await messaging.subscribeToTopic(list, topic);
    } catch (err) {
        console.error(`[PUSH] subscribeToTopic(${topic}) failed:`, err.message);
    }
};

/** Hủy đăng ký token khỏi topic (gọi khi gỡ device). Best-effort. */
const unsubscribeFromTopic = async (tokens, topic) => {
    if (!isAvailable() || !topic) {return;}
    const list = Array.isArray(tokens) ? tokens : [tokens];
    if (list.length === 0) {return;}
    try {
        await messaging.unsubscribeFromTopic(list, topic);
    } catch (err) {
        console.error(`[PUSH] unsubscribeFromTopic(${topic}) failed:`, err.message);
    }
};

// FCM data payload chỉ nhận string → ép kiểu toàn bộ value.
const _stringifyData = (data) => {
    const out = {};
    Object.keys(data || {}).forEach((key) => {
        const value = data[key];
        out[key] = typeof value === 'string' ? value : JSON.stringify(value);
    });
    return out;
};

const _isInvalidTokenError = (error) => {
    if (!error || !error.code) {return false;}
    return (
        error.code === 'messaging/registration-token-not-registered' ||
        error.code === 'messaging/invalid-registration-token' ||
        error.code === 'messaging/invalid-argument'
    );
};

module.exports = {
    isAvailable,
    sendToTokens,
    sendToTopic,
    subscribeToTopic,
    unsubscribeFromTopic,
};
