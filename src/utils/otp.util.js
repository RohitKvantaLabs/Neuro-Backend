const crypto = require('crypto');
const bcrypt = require('bcryptjs');

// ponytail: shared constants — every OTP-issuing/verifying controller imports from here
const OTP_PURPOSES = Object.freeze({
  REGISTRATION: 'REGISTRATION',
  LOGIN_2FA: 'LOGIN_2FA',
  PASSWORD_RESET: 'PASSWORD_RESET',
});

function generateOtp() {
  // 6-digit numeric OTP using Node's built-in crypto — no new dependency
  return String(crypto.randomInt(100000, 999999));
}

async function hashOtp(otp) {
  return bcrypt.hash(otp, 10);
}

async function compareOtp(candidate, hash) {
  return bcrypt.compare(candidate, hash);
}

module.exports = { OTP_PURPOSES, generateOtp, hashOtp, compareOtp };
