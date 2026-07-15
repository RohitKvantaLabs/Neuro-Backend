const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const adminSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },

    // OTP for 2FA login (cleared after use)
    otp: { type: String, select: false },
    otpExpires: { type: Date },
    otpPurpose: { type: String, enum: ['REGISTRATION', 'LOGIN_2FA', 'PASSWORD_RESET'] },
  },
  { timestamps: true }
);

adminSchema.methods.comparePassword = async function comparePassword(candidate) {
  return bcrypt.compare(candidate, this.passwordHash);
};

adminSchema.statics.hashPassword = async function hashPassword(plain) {
  return bcrypt.hash(plain, 10);
};

module.exports = mongoose.model('Admin', adminSchema);
