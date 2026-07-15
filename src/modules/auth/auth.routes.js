const express = require('express');
const {
  register, login, refresh, logout, getProfile,
  verifyOtp, resendOtp, forgotPassword, resetPassword,
  completeOnboarding, googleLogin,
} = require('../user/user.controller');
const { requireAuth } = require('./auth.middleware');
const { otpVerifyLimiter, resendOtpLimiter, passwordResetLimiter } = require('../../middleware/rateLimiter');

const router = express.Router();

// Local auth
router.post('/register', register);
router.post('/login', login);
router.post('/refresh', refresh);
router.post('/logout', logout);

// OTP verification & resend
router.post('/verify-otp', otpVerifyLimiter, verifyOtp);
router.post('/resend-otp', resendOtpLimiter, resendOtp);

// Password reset (public, unauthenticated)
router.post('/forgot-password', passwordResetLimiter, forgotPassword);
router.post('/reset-password', passwordResetLimiter, otpVerifyLimiter, resetPassword);

// Google Sign-In
router.post('/google', googleLogin);

// §10.2: Onboarding uses requireAuth (full token). No scope-restricted token.
router.post('/complete-onboarding', requireAuth, completeOnboarding);

// Protected
router.get('/me', requireAuth, getProfile);

module.exports = router;
