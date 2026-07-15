const env = require('./config/env.config');
const connectDB = require('./config/db.config');
const { connectRedis } = require('./config/redis.config');
const { startRedisSubscriber } = require('./modules/realtime/redis.subscriber');
const logger = require('./utils/logger');
const app = require('./app');

async function start() {
  await connectDB();
  await connectRedis();
  await startRedisSubscriber();

  app.listen(env.port, () => {
    logger.info(`Server listening on port ${env.port} (${env.nodeEnv})`);
  });
}

start().catch((err) => {
  logger.error(`Fatal startup error: ${err.stack || err.message}`);
  process.exit(1);
});
