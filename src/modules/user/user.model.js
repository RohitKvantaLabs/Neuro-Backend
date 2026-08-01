const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// Confirmed ROLES enum — backend is the source of truth.
const ROLES = ['academic_researcher', 'industry_researcher', 'healthcare_professional', 'data_ai_engineer', 'other'];

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: {
      type: String,
      select: false,
      // required only for local auth — validated via pre-validate hook below
    },
    isActive: { type: Boolean, default: true },
    isDeleted: { type: Boolean, default: false },
    deletionRequestedAt: { type: Date, default: null },
    scheduledDeletionAt: { type: Date, default: null },
    isEmailVerified: { type: Boolean, default: false },
    phone: { type: String, default: null },
    countryCode: { type: String, default: null }, // E.164 prefix e.g. "+91" — stored separately from digits

    // Google Sign-In
    googleId: { type: String, sparse: true, unique: true },
    authProvider: { type: String, enum: ['local', 'google'], default: 'local' },

    // OTP (cleared after use)
    otp: { type: String, select: false },
    otpExpires: { type: Date },
    otpPurpose: { type: String, enum: ['REGISTRATION', 'LOGIN_2FA', 'PASSWORD_RESET'] },

    // Onboarding profile (set during onboarding, not registration)
    // NOTE: there is no displayName — name is the single field (see CLAUDE.md §10.2).
    // instituteName / organizationName were tried and reverted — do not reintroduce.
    // Conditional "required for students" logic lives in Joi (user.validation.js), not here.
    role: { type: String, enum: ROLES },
    institute: { type: String, default: null }, // §10.2: single field for all roles
    isOnboarded: { type: Boolean, default: false },
    // §10.11a — set by migration script only; never set in normal app flow
    isLegacyUser: { type: Boolean, default: false },

    // §10.7 — notifications toggle & preferences
    notificationsEnabled: { type: Boolean, default: true },
    notificationPreferences: {
      email_notifications: { type: Boolean, default: true },
      in_app_notifications: { type: Boolean, default: true },
      dataset_updates: { type: Boolean, default: true },
      new_matches: { type: Boolean, default: true },
      account_activity: { type: Boolean, default: true },
    },
  },
  { timestamps: true }
);

// ponytail: only passwordHash check remains — role/institute conditional logic
// belongs in Joi at the API boundary, not in a hook that fires on every .save()
// isNew/isModified check prevents validation crashes when saving documents where passwordHash was not selected.
userSchema.pre('validate', async function () {
  if ((this.isNew || this.isModified('passwordHash')) && this.authProvider === 'local' && !this.passwordHash) {
    this.invalidate('passwordHash', 'Password is required for local accounts.');
  }
});

userSchema.methods.comparePassword = async function comparePassword(candidate) {
  return bcrypt.compare(candidate, this.passwordHash);
};

userSchema.statics.hashPassword = async function hashPassword(plain) {
  return bcrypt.hash(plain, 10);
};

module.exports = { User: mongoose.model('User', userSchema), ROLES };
