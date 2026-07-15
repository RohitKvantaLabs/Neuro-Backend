/**
 * One-time migration: sets isOnboarded: true AND isLegacyUser: true on all existing User documents.
 * Run ONCE per environment (dev/staging/prod) before deploying the onboarding feature
 * so existing users aren't locked out. isLegacyUser flags them for a non-blocking
 * "complete your profile" nudge on the frontend — see CLAUDE.md §10.11a.
 * Usage: node scripts/migrateIsOnboarded.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const env = require('../src/config/env.config');
const { User } = require('../src/modules/user/user.model');

async function migrate() {
  await mongoose.connect(env.mongoUri, { dbName: env.mongoDbName });

  // ponytail: bulk write — $ne: true filter makes this idempotent (safe to re-run)
  const result = await User.updateMany(
    { isOnboarded: { $ne: true } },
    { $set: { isOnboarded: true, isLegacyUser: true } }
  );

  console.log(`Migration complete: ${result.modifiedCount} user(s) updated (isOnboarded: true, isLegacyUser: true).`);
  await mongoose.disconnect();
}

migrate().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
