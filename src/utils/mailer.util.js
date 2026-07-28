const nodemailer = require('nodemailer');
require('dotenv').config({ quiet: true });

let transporter = null;
let isConfigured = false;

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT, 10) || 587;
const SMTP_SECURE = process.env.SMTP_SECURE === 'true';
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const MAIL_FROM = process.env.MAIL_FROM || process.env.SMTP_USER;
const APP_NAME = process.env.APP_NAME || 'App';

if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
    transporter = nodemailer.createTransport({
        host: SMTP_HOST,
        port: SMTP_PORT,
        secure: SMTP_SECURE,
        auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
    isConfigured = true;
    console.log('  ✓ Mailer (SMTP) initialized');
} else {
    console.log('  ⚠ Mailer not configured — emails will be logged to console (dev only)');
}

const sendMail = async ({ to, subject, html, text }) => {
    if (!isConfigured) {
        if (process.env.NODE_ENV === 'production') {
            throw new Error('SMTP is not configured');
        }
        console.log('\n──────────── [DEV EMAIL] ────────────');
        console.log(`To:      ${to}`);
        console.log(`Subject: ${subject}`);
        console.log(`Body:\n${text || html}`);
        console.log('─────────────────────────────────────\n');
        return;
    }

    await transporter.sendMail({ from: `"${APP_NAME}" <${MAIL_FROM}>`, to, subject, text, html });
};

const sendPasswordResetEmail = async ({ to, fullName, resetUrl, expiresMinutes, lang = 'vi' }) => {
    const name = fullName || (lang === 'en' ? 'there' : 'bạn');

    const subject = lang === 'en'
        ? `[${APP_NAME}] Reset your password`
        : `[${APP_NAME}] Đặt lại mật khẩu`;

    const text = lang === 'en'
        ? `Hi ${name},\n\nYou requested to reset your password. Open the link below (valid for ${expiresMinutes} minutes):\n${resetUrl}\n\nIf you did not request this, please ignore this email.`
        : `Xin chào ${name},\n\nBạn vừa yêu cầu đặt lại mật khẩu. Mở liên kết dưới đây (hiệu lực ${expiresMinutes} phút):\n${resetUrl}\n\nNếu bạn không yêu cầu, vui lòng bỏ qua email này.`;

    const html = `
        <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto;">
            <h2 style="color:#1a73e8;">${lang === 'en' ? 'Reset your password' : 'Đặt lại mật khẩu'}</h2>
            <p>${lang === 'en' ? `Hi ${name},` : `Xin chào ${name},`}</p>
            <p>${lang === 'en'
                ? 'You requested to reset your password. Click the button below to continue:'
                : 'Bạn vừa yêu cầu đặt lại mật khẩu. Nhấn nút bên dưới để tiếp tục:'}</p>
            <p style="text-align:center; margin:28px 0;">
                <a href="${resetUrl}"
                   style="background:#1a73e8;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;">
                    ${lang === 'en' ? 'Reset password' : 'Đặt lại mật khẩu'}
                </a>
            </p>
            <p style="color:#666;font-size:13px;">
                ${lang === 'en'
                    ? `This link is valid for ${expiresMinutes} minutes. If you did not request this, please ignore this email.`
                    : `Liên kết có hiệu lực trong ${expiresMinutes} phút. Nếu bạn không yêu cầu, vui lòng bỏ qua email này.`}
            </p>
            <p style="color:#999;font-size:12px;word-break:break-all;">${resetUrl}</p>
        </div>
    `;

    await sendMail({ to, subject, html, text });
};

const sendVerificationEmail = async ({ to, fullName, verifyUrl, expiresMinutes, lang = 'vi' }) => {
    const name = fullName || (lang === 'en' ? 'there' : 'bạn');

    const subject = lang === 'en'
        ? `[${APP_NAME}] Verify your email`
        : `[${APP_NAME}] Xác minh email của bạn`;

    const text = lang === 'en'
        ? `Hi ${name},\n\nThanks for registering. Please verify your email by opening the link below (valid for ${expiresMinutes} minutes):\n${verifyUrl}\n\nIf you did not create this account, please ignore this email.`
        : `Xin chào ${name},\n\nCảm ơn bạn đã đăng ký. Vui lòng xác minh email bằng cách mở liên kết dưới đây (hiệu lực ${expiresMinutes} phút):\n${verifyUrl}\n\nNếu bạn không tạo tài khoản này, vui lòng bỏ qua email.`;

    const html = `
        <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto;">
            <h2 style="color:#1a73e8;">${lang === 'en' ? 'Verify your email' : 'Xác minh email'}</h2>
            <p>${lang === 'en' ? `Hi ${name},` : `Xin chào ${name},`}</p>
            <p>${lang === 'en'
                ? 'Thanks for registering. Please confirm your email address to activate your account:'
                : 'Cảm ơn bạn đã đăng ký. Vui lòng xác nhận địa chỉ email để kích hoạt tài khoản:'}</p>
            <p style="text-align:center; margin:28px 0;">
                <a href="${verifyUrl}"
                   style="background:#1a73e8;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;">
                    ${lang === 'en' ? 'Verify email' : 'Xác minh email'}
                </a>
            </p>
            <p style="color:#666;font-size:13px;">
                ${lang === 'en'
                    ? `This link is valid for ${expiresMinutes} minutes. If you did not create this account, please ignore this email.`
                    : `Liên kết có hiệu lực trong ${expiresMinutes} phút. Nếu bạn không tạo tài khoản này, vui lòng bỏ qua email.`}
            </p>
            <p style="color:#999;font-size:12px;word-break:break-all;">${verifyUrl}</p>
        </div>
    `;

    await sendMail({ to, subject, html, text });
};

module.exports = {
    sendMail,
    sendPasswordResetEmail,
    sendVerificationEmail,
};
