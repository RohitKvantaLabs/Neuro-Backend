const Joi = require('joi');
const { ROLES } = require('./user.model');
const { PASSWORD_REGEX, PASSWORD_MESSAGE } = require('../../utils/passwordPolicy');

// ponytail: schemas only — async email validation (MX) runs inside the controller after Joi passes
// countryCode: E.164 prefix e.g. "+91", stored separately from digit-only phone
const countryCode = Joi.string()
  .pattern(/^\+[1-9]\d{0,2}$/)
  .message('countryCode must be a valid E.164 prefix (e.g. "+91").');

const phone = Joi.string()
  .pattern(/^\d{6,14}$/)
  .message('Phone must contain 6–14 digits (no country code prefix).');

const registerSchema = Joi.object({
  name: Joi.string().trim().min(2).max(100).required(),
  email: Joi.string().email().required(),
  password: Joi.string().pattern(PASSWORD_REGEX).message(PASSWORD_MESSAGE).required(),
  confirmPassword: Joi.valid(Joi.ref('password')).required().messages({ 'any.only': 'Passwords do not match.' }),
  countryCode: countryCode.required(),
  phone: phone.required(),
});

const loginSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().required(),
});

const verifyOtpSchema = Joi.object({
  email: Joi.string().email().required(),
  otp: Joi.string().length(6).pattern(/^\d+$/).required(),
});

const resendOtpSchema = Joi.object({
  email: Joi.string().email().required(),
});

const forgotPasswordSchema = Joi.object({
  email: Joi.string().email().required(),
});

const resetPasswordSchema = Joi.object({
  email: Joi.string().email().required(),
  otp: Joi.string().length(6).pattern(/^\d+$/).required(),
  newPassword: Joi.string().pattern(PASSWORD_REGEX).message(PASSWORD_MESSAGE).required(),
  confirmNewPassword: Joi.valid(Joi.ref('newPassword')).required().messages({ 'any.only': 'Passwords do not match.' }),
});

// §10.2: Onboarding — phone optional here (controller enforces it only if user.phone is null)
const completeOnboardingSchema = Joi.object({
  name: Joi.string().trim().min(2).max(100).required(),
  role: Joi.string().valid(...ROLES).required(),
  institute: Joi.string().trim().when('role', {
    is: 'academic_researcher',
    then: Joi.required().messages({ 'any.required': 'Organization/Institute Name is required.' }),
    otherwise: Joi.optional().allow('', null),
  }),
  // phone optional here — controller enforces it only if user.phone is null (Google accounts)
  countryCode: countryCode.optional(),
  phone: phone.optional(),
});

// §10.7 — PUT /users/me (all fields optional, phone cap enforced in controller)
const updateMeSchema = Joi.object({
  name: Joi.string().trim().min(2).max(100),
  institute: Joi.string().trim().allow('', null),
  countryCode: countryCode.optional(),
  phone: phone.optional(),
  role: Joi.string().valid(...ROLES).optional(),
}).min(1);

// §10.7 — PATCH /users/me/notifications
const updateNotificationsSchema = Joi.object({
  enabled: Joi.boolean().optional(),
  email_notifications: Joi.boolean().optional(),
  in_app_notifications: Joi.boolean().optional(),
  dataset_updates: Joi.boolean().optional(),
  new_matches: Joi.boolean().optional(),
  account_activity: Joi.boolean().optional(),
  notificationPreferences: Joi.object({
    email_notifications: Joi.boolean().optional(),
    in_app_notifications: Joi.boolean().optional(),
    dataset_updates: Joi.boolean().optional(),
    new_matches: Joi.boolean().optional(),
    account_activity: Joi.boolean().optional(),
  }).optional(),
}).min(1);

module.exports = {
  registerSchema,
  loginSchema,
  verifyOtpSchema,
  resendOtpSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  completeOnboardingSchema,
  updateMeSchema,
  updateNotificationsSchema,
};
