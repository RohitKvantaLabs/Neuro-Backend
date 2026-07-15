const Joi = require('joi');
const { ROLES } = require('./user.model');

// ponytail: schemas only — async email validation (MX) runs inside the controller after Joi passes
const phone = Joi.string()
  .pattern(/^\+?[1-9]\d{6,14}$/)
  .message('Phone must be a valid international number.');

const registerSchema = Joi.object({
  name: Joi.string().trim().min(2).max(100).required(),
  email: Joi.string().email().required(),
  password: Joi.string().min(8).max(128).required(),
  confirmPassword: Joi.valid(Joi.ref('password')).required().messages({ 'any.only': 'Passwords do not match.' }),
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
  newPassword: Joi.string().min(8).max(128).required(),
  confirmNewPassword: Joi.valid(Joi.ref('newPassword')).required().messages({ 'any.only': 'Passwords do not match.' }),
});

// §10.2: institute is conditionally required via Joi — NOT in a Mongoose hook.
// Lesson: model-level hooks fire on every .save(), breaking unrelated saves.
// Joi fires only on this specific request — right place for conditional business logic.
const completeOnboardingSchema = Joi.object({
  name: Joi.string().trim().min(2).max(100).required(),
  role: Joi.string().valid(...ROLES).required(),
  institute: Joi.when('role', {
    is: 'student',
    then: Joi.string().trim().required().messages({ 'any.required': 'institute is required for students.' }),
    otherwise: Joi.string().trim().allow('', null).optional(),
  }),
  // phone optional here — controller enforces it only if user.phone is null (Google accounts)
  phone: phone.optional(),
});

// §10.7 — PUT /users/me (all fields optional, phone cap enforced in controller)
const updateMeSchema = Joi.object({
  name: Joi.string().trim().min(2).max(100),
  role: Joi.string().valid(...ROLES),
  institute: Joi.string().trim().allow('', null),
  phone: phone.optional(),
}).min(1);

// §10.7 — PATCH /users/me/notifications
const updateNotificationsSchema = Joi.object({
  enabled: Joi.boolean().required(),
});

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
