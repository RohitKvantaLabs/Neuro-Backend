const mongoose = require('mongoose');

const collectionSchema = new mongoose.Schema(
  { userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, trim: true } },
  { timestamps: { createdAt: true, updatedAt: false } }
);

module.exports = mongoose.model('Collection', collectionSchema);
