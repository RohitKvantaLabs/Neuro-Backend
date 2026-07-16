const AuditLog = require('../modules/admin/auditLog.model');
const logger = require('./logger');

/**
 * §11.6 — Single call site for all admin mutations.
 * Fire-and-forget: errors are logged, never thrown — audit failure must not block the response.
 *
 * @param {string|ObjectId} adminId
 * @param {string} action  dot-namespaced: repo.create, user.delete, moderation.approve, etc.
 * @param {string|null} targetType  'user' | 'dataset' | 'repository' | null
 * @param {string|null} targetId   plain string
 * @param {object} metadata  any extra context
 */
async function logAdminAction(adminId, action, targetType = null, targetId = null, metadata = {}) {
  try {
    await AuditLog.create({ adminId, action, targetType, targetId, metadata });
  } catch (err) {
    // ponytail: audit failure must never surface to the caller
    logger.error('auditLog.util: failed to write audit entry', { action, targetId, err: err.message });
  }
}

module.exports = { logAdminAction };
