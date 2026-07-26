/**
 * Loads and validates environment variables at startup. If a required
 * var is missing, the process exits immediately with a clear message -
 * same philosophy as the Python service's required (no-default) config
 * fields: fail loud at boot, never limp along with undefined behavior.
 */
require('dotenv').config();

const REQUIRED_VARS = [
  'MONGO_URI',
  'REDIS_URL',
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'PYTHON_AGENT_BASE_URL',
  'PYTHON_AGENT_INTERNAL_SECRET',
];

function validateEnv() {
  const missing = REQUIRED_VARS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    // eslint-disable-next-line no-console
    console.error(`FATAL: missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }
}

validateEnv();

module.exports = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT, 10) || 5000,

  mongoUri: process.env.MONGO_URI,
  mongoDbName: process.env.MONGO_DB_NAME || 'neuro_data_platform',

  redisUrl: process.env.REDIS_URL,

  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET,
    refreshSecret: process.env.JWT_REFRESH_SECRET,
    accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
  },

  // Default to localhost for new deployments — never default to a production URL
  // that could silently whitelist the wrong origin in a development/staging env.
  frontendOrigins: (process.env.FRONTEND_ORIGIN || 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean),

  pythonAgent: {
    baseUrl: process.env.PYTHON_AGENT_BASE_URL,
    internalSecret: process.env.PYTHON_AGENT_INTERNAL_SECRET,
    timeoutMs: parseInt(process.env.PYTHON_AGENT_TIMEOUT_MS, 10) || 65000,
    model: process.env.AGENT_MODEL || 'unknown',
  },

  // Dedicated secret for the third-party email provider webhook. Leave it
  // unset only if email ticket ingestion is intentionally disabled.
  ticketIngestSecret: process.env.TICKET_INGEST_SECRET,

  smtp: {
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT, 10) || 587,
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.SMTP_FROM || 'Neuro Data Platform <no-reply@example.com>',
  },

  googleClientId: process.env.GOOGLE_CLIENT_ID,

  otp: {
    expiryMinutes: parseInt(process.env.OTP_EXPIRY_MINUTES, 10) || 10,
    adminExpiryMinutes: parseInt(process.env.ADMIN_OTP_EXPIRY_MINUTES, 10) || 5,
    passwordResetExpiryMinutes: parseInt(process.env.PASSWORD_RESET_OTP_EXPIRY_MINUTES, 10) || 10,
  },
};
