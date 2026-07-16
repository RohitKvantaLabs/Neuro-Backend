const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema(
  {
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', required: true },
    action: { type: String, required: true }, // dot-namespaced: repo.create, user.delete, moderation.approve, etc.
    targetType: { type: String, default: null }, // 'user' | 'dataset' | 'repository' | null
    targetId: { type: String, default: null },   // plain string, not ObjectId — targets span collections
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

module.exports = mongoose.model('AuditLog', auditLogSchema);
