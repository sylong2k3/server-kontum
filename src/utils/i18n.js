/**
 * Translation Utility for Multilingual Support (vi / en)
 */

const locales = {
    vi: {
        email_in_use: 'Email đã được sử dụng',
        incorrect_credentials: 'Email hoặc mật khẩu không đúng',
        account_disabled: 'Tài khoản đã bị vô hiệu hóa. Vui lòng liên hệ quản trị viên',
        account_locked_mins: 'Tài khoản tạm khóa do đăng nhập sai quá nhiều lần. Vui lòng thử lại sau {mins} phút',
        google_only: 'Tài khoản này chỉ đăng nhập qua Google. Vui lòng sử dụng đăng nhập Google',
        account_locked_limit: 'Tài khoản đã bị khóa tạm {mins} phút do đăng nhập sai quá {attempts} lần',
        incorrect_credentials_attempts: 'Email hoặc mật khẩu không đúng. Còn {attempts} lần thử',
        invalid_refresh_token: 'Refresh token không hợp lệ hoặc đã hết hạn',
        refresh_token_revoked: 'Refresh token không tồn tại hoặc đã bị thu hồi',
        user_not_found: 'User không tồn tại',
        google_no_password: 'Tài khoản này đăng nhập qua Google và chưa có mật khẩu. Vui lòng liên kết mật khẩu trước',
        incorrect_old_password: 'Mật khẩu cũ không đúng',
        same_password: 'Mật khẩu mới phải khác mật khẩu cũ',
        password_changed_success: 'Đổi mật khẩu thành công. Vui lòng đăng nhập lại',
        please_login: 'Vui lòng đăng nhập',
        no_permission: 'Bạn không có quyền thực hiện thao tác này. Yêu cầu role: {roles}',
        register_success: 'Đăng ký thành công',
        login_success: 'Đăng nhập thành công',
        refresh_success: 'Gia hạn token thành công',
        logout_success: 'Đăng xuất thành công',
        get_me_success: 'Lấy thông tin thành công',
        invalid_data: 'Dữ liệu không hợp lệ',
        invalid_token: 'Token không hợp lệ',
        token_expired: 'Token đã hết hạn',

        // Joi Validation errors
        'any.required': 'Trường này là bắt buộc',
        'string.empty': 'Trường này không được để trống',
        'string.email': 'Email không hợp lệ',
        'string.min': 'Trường này phải có ít nhất {limit} ký tự',
        'string.max': 'Trường này không được vượt quá {limit} ký tự',
        'string.pattern.base': 'Định dạng dữ liệu không hợp lệ',
        'newPassword.any.invalid': 'Mật khẩu mới phải khác mật khẩu cũ',
        'email.any.required': 'Email là bắt buộc',
        'password.any.required': 'Mật khẩu là bắt buộc',
        'fullName.any.required': 'Họ tên là bắt buộc',
        'oldPassword.any.required': 'Mật khẩu cũ là bắt buộc',
        'newPassword.any.required': 'Mật khẩu mới là bắt buộc',
        'phone.string.pattern.base': 'Số điện thoại không hợp lệ',
    },
    en: {
        email_in_use: 'Email is already in use',
        incorrect_credentials: 'Incorrect email or password',
        account_disabled: 'Account has been disabled. Please contact the administrator',
        account_locked_mins: 'Account temporarily locked due to too many failed login attempts. Please try again after {mins} minutes',
        google_only: 'This account only logs in via Google. Please use Google login',
        account_locked_limit: 'Account has been temporarily locked for {mins} minutes due to more than {attempts} failed login attempts',
        incorrect_credentials_attempts: 'Incorrect email or password. {attempts} attempts left',
        invalid_refresh_token: 'Invalid or expired refresh token',
        refresh_token_revoked: 'Refresh token does not exist or has been revoked',
        user_not_found: 'User does not exist',
        google_no_password: 'This account logs in via Google and does not have a password. Please link a password first',
        incorrect_old_password: 'Incorrect old password',
        same_password: 'New password must be different from the old password',
        password_changed_success: 'Password changed successfully. Please log in again',
        please_login: 'Please log in',
        no_permission: 'You do not have permission to perform this action. Required role: {roles}',
        register_success: 'Registration successful',
        login_success: 'Login successful',
        refresh_success: 'Token refreshed successfully',
        logout_success: 'Logout successful',
        get_me_success: 'Get profile successful',
        invalid_data: 'Invalid data',
        invalid_token: 'Invalid token',
        token_expired: 'Token expired',

        // Joi Validation errors
        'any.required': 'This field is required',
        'string.empty': 'This field cannot be empty',
        'string.email': 'Invalid email address',
        'string.min': 'This field must be at least {limit} characters',
        'string.max': 'This field cannot exceed {limit} characters',
        'string.pattern.base': 'Invalid format',
        'newPassword.any.invalid': 'New password must be different from the old password',
        'email.any.required': 'Email is required',
        'password.any.required': 'Password is required',
        'fullName.any.required': 'Full name is required',
        'oldPassword.any.required': 'Old password is required',
        'newPassword.any.required': 'New password is required',
        'phone.string.pattern.base': 'Invalid phone number',
    }
};

const t = (key, lang = 'vi', params = {}) => {
    const locale = locales[lang] || locales.vi;
    let message = locale[key] || key;

    Object.keys(params).forEach(param => {
        message = message.replace(`{${param}}`, params[param]);
    });

    return message;
};

module.exports = { t };
