const mongoose = require('mongoose');
const logger = require('../utils/logger');
const env = require('./env.config');

async function connectDB() {
  // Rely on mongoose.connection.readyState instead of an in-memory flag so that
  // a dropped connection (readyState 0) is automatically re-established on the
  // next call rather than being skipped due to a stale isConnected = true.
  if (mongoose.connection.readyState === 1 || mongoose.connection.readyState === 2) {
    return;
  }

  try {
    const db = await mongoose.connect(env.mongoUri, {
      dbName: env.mongoDbName,
      serverSelectionTimeoutMS: 5000,
    });
    logger.info(`MongoDB connected -> db=${env.mongoDbName}`);
  } catch (err) {
    logger.error(`MongoDB connection failed: ${err.message}`);
    throw new Error(`MongoDB connection failed: ${err.message}`);
  }
}

module.exports = connectDB;
