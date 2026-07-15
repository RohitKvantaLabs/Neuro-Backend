const mongoose = require('mongoose');
const logger = require('../utils/logger');
const env = require('./env.config');

async function connectDB() {
  try {
    await mongoose.connect(env.mongoUri, { dbName: env.mongoDbName });
    logger.info(`MongoDB connected -> db=${env.mongoDbName}`);
  } catch (err) {
    logger.error(`MongoDB connection failed: ${err.message}`);
    process.exit(1); // fail loud at startup rather than run against a broken DB
  }
}

module.exports = connectDB;
