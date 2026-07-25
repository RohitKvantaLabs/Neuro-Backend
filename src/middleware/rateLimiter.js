const rateLimit = require('express-rate-limit');

// General API traffic
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please try again later.' },
});

// Stricter limit for the search endpoint — a cache miss triggers a real LLM + Tavily call
const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many search requests - please slow down.' },
});

// OTP verification — keyed by email to prevent distributed brute-force across IPs
const otpVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => req.body?.email || req.ip,
  validate: { keyGeneratorIpFallback: false },
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many OTP attempts. Try again in 15 minutes.' },
});

// Resend OTP — stricter to prevent email-bombing
const resendOtpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  keyGenerator: (req) => req.body?.email || req.ip,
  validate: { keyGeneratorIpFallback: false },
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many resend requests. Try again in an hour.' },
});

// Password-reset endpoints — public, unauthenticated, prime abuse target
const passwordResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => req.body?.email || req.ip,
  validate: { keyGeneratorIpFallback: false },
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many password-reset requests. Try again later.' },
});

// Login — keyed by email to prevent credential-stuffing across IPs (5 attempts / 15 min)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => req.body?.email || req.ip,
  validate: { keyGeneratorIpFallback: false },
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many login attempts. Try again in 15 minutes.' },
});

// Email webhooks should be low-volume. This limits retries/abuse even when
// the provider credential is compromised.
const ticketIngestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many ticket ingestion requests. Please try again later.' },
});

module.exports = { generalLimiter, searchLimiter, otpVerifyLimiter, resendOtpLimiter, passwordResetLimiter, loginLimiter, ticketIngestLimiter };
