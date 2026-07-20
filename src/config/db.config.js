const mongoose = require('mongoose');
const logger = require('../utils/logger');
const env = require('./env.config');

let isConnected = false;

async function connectDB() {
  if (isConnected || mongoose.connection.readyState === 1) {
    isConnected = true;
    return;
  }

  try {
    const db = await mongoose.connect(env.mongoUri, {
      dbName: env.mongoDbName,
      serverSelectionTimeoutMS: 5000,
    });
    isConnected = db.connections[0].readyState === 1;
    logger.info(`MongoDB connected -> db=${env.mongoDbName}`);
  } catch (err) {
    logger.error(`MongoDB connection failed: ${err.message}`);
    throw new Error(`MongoDB connection failed: ${err.message}`);
  }
}

module.exports = connectDB;
