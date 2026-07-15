/**
 * CLI-only admin password reset. Not an API route — no endpoint exists for this.
 * Usage: node scripts/reset-admin.js <email> <newPassword>
 */
require('dotenv').config();
const mongoose = require('mongoose');
const env = require('../src/config/env.config');
const Admin = require('../src/modules/admin/admin.model');

async function resetAdmin() {
  const [, , email, newPassword] = process.argv;

  if (!email || !newPassword) {
    console.error('Usage: node scripts/reset-admin.js <email> <newPassword>');
    process.exit(1);
  }

  await mongoose.connect(env.mongoUri, { dbName: env.mongoDbName });

  const admin = await Admin.findOne({ email });
  if (!admin) {
    console.error(`No admin found with email: ${email}`);
    await mongoose.disconnect();
    process.exit(1);
  }

  admin.passwordHash = await Admin.hashPassword(newPassword);
  // Clear any stale pending OTP so the admin lands on a clean state
  admin.otp = undefined;
  admin.otpExpires = undefined;
  admin.otpPurpose = undefined;
  await admin.save();

  console.log(`Password reset for ${email}. The admin can now log in with the new password.`);
  await mongoose.disconnect();
}

resetAdmin().catch((err) => {
  console.error('Failed to reset admin:', err.message);
  process.exit(1);
});
