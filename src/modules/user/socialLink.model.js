const mongoose = require('mongoose');

// §10.6: Fixed 4-platform list — matches frontend's hardcoded PLATFORMS constant
const PLATFORMS = ['linkedin', 'github', 'pinterest', 'instagram'];

const socialLinkSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    platform: { type: String, enum: PLATFORMS, required: true },
    url: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// One link per platform per user
socialLinkSchema.index({ userId: 1, platform: 1 }, { unique: true });

module.exports = mongoose.model('SocialLink', socialLinkSchema);
