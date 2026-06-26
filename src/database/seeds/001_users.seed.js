/**
 * Seed 4 tài khoản mẫu tương ứng 4 vai trò của dự án Kon Tum.
 * Idempotent: nếu email đã tồn tại thì bỏ qua (không tạo trùng).
 *
 * Chạy:  node src/database/seeds/001_users.seed.js
 */
require('dotenv').config();

const db = require('../../configs/database');
const userRepository = require('../../repositories/user.repository');
const { hashPassword } = require('../../utils/cryptoHelper.util');
const { t } = require('../../utils/i18n.util');

const getLang = () => process.env.APP_LANG || process.env.LANG || 'vi';

// Mật khẩu mặc định DÙNG CHUNG cho cả 4 tài khoản (thỏa: >=8 ký tự, có chữ thường, chữ hoa, số).
const DEFAULT_PASSWORD = 'Kontum@2026';

const USERS = [
    {
        email: 'admin@kontum.gov.vn',
        fullName: 'Quản trị hệ thống',
        phone: '0260111111',
        roleCode: 'system_admin',
    },
    {
        email: 'ubnd@kontum.gov.vn',
        fullName: 'UBND tỉnh Kon Tum',
        phone: '0260222222',
        roleCode: 'ubnd_tinh',
    },
    {
        email: 'sonn@kontum.gov.vn',
        fullName: 'Sở Nông nghiệp & Môi trường',
        phone: '0260333333',
        roleCode: 'so_nnmt',
    },
    {
        email: 'citizen@kontum.gov.vn',
        fullName: 'Người dân Kon Tum',
        phone: '0260444444',
        roleCode: 'citizen',
    },
];

(async () => {
    try {
        for (const u of USERS) {
            const passwordHash = await hashPassword(DEFAULT_PASSWORD);
            const existing = await userRepository.findByEmail(u.email);

            if (existing) {
                await userRepository.updatePassword(existing.id, passwordHash);
                console.log(t('seed_user_password_updated', getLang(), {
                    id: existing.id,
                    email: u.email,
                    role: u.roleCode,
                }));
                continue;
            }

            const created = await userRepository.create({
                email: u.email,
                passwordHash,
                fullName: u.fullName,
                phone: u.phone,
                roleCode: u.roleCode,
            });

            console.log(t('seed_user_created', getLang(), {
                id: created.id,
                email: u.email,
                role: u.roleCode,
            }));
        }

        console.log(`\n${t('seed_user_completed', getLang(), { password: DEFAULT_PASSWORD })}`);
        await db.pool.end();
        process.exit(0);
    } catch (e) {
        console.error('SEED FAILED:', e.message);
        await db.pool.end().catch(() => {});
        process.exit(1);
    }
})();
