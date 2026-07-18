const env = require('./config/env.config');
const connectDB = require('./config/db.config');
const { redisClient, redisSubscriber, connectRedis } = require('./config/redis.config');
const { startRedisSubscriber } = require('./modules/realtime/redis.subscriber');
const logger = require('./utils/logger');
const mongoose = require('mongoose');
const app = require('./app');

let server;

// Ordered shutdown: log → close Redis → close HTTP server → disconnect Mongo → exit
async function shutdown(signal, err) {
  if (err) {
    logger.error(`${signal}: ${err.stack || err.message}`);
  } else {
    logger.info(`${signal} received — shutting down gracefully`);
  }

  try {
    // 1. Drain Redis connections (node-redis v4 uses .quit())
    await Promise.allSettled([
      redisClient.quit(),
      redisSubscriber.quit(),
    ]);
  } catch (redisErr) {
    logger.warn(`Redis shutdown error: ${redisErr.message}`);
  }

  // 2. Stop accepting new HTTP connections
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }

  // 3. Close Mongoose connection
  try {
    await mongoose.disconnect();
  } catch (mongoErr) {
    logger.warn(`Mongoose disconnect error: ${mongoErr.message}`);
  }

  process.exit(err ? 1 : 0);
}

// Process-level crash handlers — catches anything asyncHandler didn't catch
process.on('uncaughtException', (err) => shutdown('uncaughtException', err));
process.on('unhandledRejection', (err) => shutdown('unhandledRejection', err));

// Graceful OS signals (e.g. Docker SIGTERM, Ctrl-C SIGINT)
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

async function start() {
  await connectDB();
  await connectRedis();
  await startRedisSubscriber();

  server = app.listen(env.port, () => {
    logger.info(`Server listening on port ${env.port} (${env.nodeEnv})`);
  });
}

start().catch((err) => {
  logger.error(`Fatal startup error: ${err.stack || err.message}`);
  process.exit(1);
});
