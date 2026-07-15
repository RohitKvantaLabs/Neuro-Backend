/**
 * Run once to create the first admin account: npm run seed:admin
 * There is deliberately no public /admin/register endpoint.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const env = require('../src/config/env.config');
const Admin = require('../src/modules/admin/admin.model');

async function seedAdmin() {
  const email = process.env.SEED_ADMIN_EMAIL;
  const password = process.env.SEED_ADMIN_PASSWORD;

  if (!email || !password) {
    console.error('Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD in .env before running this script.');
    process.exit(1);
  }

  await mongoose.connect(env.mongoUri, { dbName: env.mongoDbName });

  const existing = await Admin.findOne({ email });
  if (existing) {
    console.log(`Admin with email ${email} already exists - skipping.`);
    await mongoose.disconnect();
    return;
  }

  const passwordHash = await Admin.hashPassword(password);
  await Admin.create({ name: 'Platform Admin', email, passwordHash });
  console.log(`Admin account created for ${email}. Change SEED_ADMIN_PASSWORD or rotate this password soon.`);

  await mongoose.disconnect();
}

seedAdmin().catch((err) => {
  console.error('Failed to seed admin:', err.message);
  process.exit(1);
});
