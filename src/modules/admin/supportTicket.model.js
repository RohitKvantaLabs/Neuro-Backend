const mongoose = require('mongoose');

const supportTicketSchema = new mongoose.Schema(
  {
    subject: { type: String, required: true, trim: true },
    message: { type: String, required: true },
    email: { type: String, default: null },
    name: { type: String, default: null },
    status: {
      type: String,
      enum: ['open', 'in_progress', 'resolved'],
      default: 'open',
    },
    source: {
      type: String,
      enum: ['email', 'web', 'api'],
      default: 'email',
    },
    resolved_at: { type: Date, default: null },
  },
  { timestamps: true }
);

supportTicketSchema.index({ status: 1 });
supportTicketSchema.index({ createdAt: -1 });

module.exports = mongoose.model('SupportTicket', supportTicketSchema);
