const nodemailer = require('nodemailer');
const logger = require('./logger');

// ponytail: Gmail SMTP transporter — credentials from env, never hardcoded
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

async function sendOtpEmail(to, otp, purpose) {
  const subjects = {
    REGISTRATION: 'Your Neuro Platform verification code',
    LOGIN_2FA: 'Your Neuro Platform admin login code',
    PASSWORD_RESET: 'Your Neuro Platform password reset code',
  };
  const subject = subjects[purpose] || 'Your Neuro Platform code';

  try {
    await transporter.sendMail({
      from: process.env.SMTP_USER,
      to,
      subject,
      html: `<p>Your OTP code is: <strong>${otp}</strong></p>`,
    });
    logger.info(`OTP email sent to ${to} for purpose=${purpose}`);
  } catch (err) {
    logger.error(`Failed to send OTP email to ${to}: ${err.message}`);
    throw err;
  }
}

module.exports = { sendOtpEmail };
