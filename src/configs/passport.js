const passport = require('passport');
const { Strategy: JwtStrategy, ExtractJwt } = require('passport-jwt');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const { JWT_SECRET, JWT_ALGORITHM } = require('../utils/tokenManager');
const userRepository = require('../repositories/user.repository');
const tokenRepository = require('../repositories/token.repository');
require('dotenv').config();

const initPassport = () => {
    // ── JWT Strategy ─────────────────────────────────────────────────────
    const jwtOptions = {
        jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
        secretOrKey: JWT_SECRET,
        algorithms: [JWT_ALGORITHM],
        passReqToCallback: true,
    };

    passport.use(
        'jwt',
        new JwtStrategy(jwtOptions, async (req, payload, done) => {
            try {
                if (payload.jti) {
                    const blacklisted = await tokenRepository.isBlacklisted(payload.jti);
                    if (blacklisted) {
                        return done(null, false, { message: 'Token đã bị thu hồi' });
                    }
                }
                const user = await userRepository.findById(payload.userId);
                if (!user) {
                    return done(null, false, { message: 'User không tồn tại' });
                }
                if (!user.is_active) {
                    return done(null, false, { message: 'Tài khoản đã bị vô hiệu hóa' });
                }
                return done(null, {
                    ...user,
                    jti: payload.jti,
                });
            } catch (error) {
                return done(error, false);
            }
        })
    );
    const googleClientId = process.env.GOOGLE_CLIENT_ID;
    const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const googleCallbackUrl = process.env.GOOGLE_CALLBACK_URL || '/api/v1/auth/google/callback';

    if (googleClientId && googleClientId !== 'your_google_client_id') {
        passport.use(
            'google',
            new GoogleStrategy(
                {
                    clientID: googleClientId,
                    clientSecret: googleClientSecret,
                    callbackURL: googleCallbackUrl,
                    scope: ['profile', 'email'],
                },
                async (accessToken, refreshToken, profile, done) => {
                    try {
                        // Trả về Google profile để auth.service xử lý tiếp
                        // (tìm/tạo user, generate tokens)
                        const googleProfile = {
                            googleId: profile.id,
                            email: profile.emails?.[0]?.value,
                            fullName: profile.displayName,
                            avatarUrl: profile.photos?.[0]?.value,
                        };

                        return done(null, googleProfile);
                    } catch (error) {
                        return done(error, false);
                    }
                }
            )
        );
        console.log('  ✓ Google OAuth2 strategy initialized');
    } else {
        console.log('  ⚠ Google OAuth2 not configured — skipping strategy');
    }

    console.log('  ✓ JWT strategy initialized');
};

module.exports = { initPassport };
