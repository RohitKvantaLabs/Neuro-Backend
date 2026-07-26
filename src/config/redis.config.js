/**
 * Single Redis client used for general-purpose commands.  The subscriber
 * connection (redisClient.duplicate()) has been removed because the SSE
 * subscriber was made a no-op (see realtime/redis.subscriber.js).  If you
 * re-enable SSE-based event forwarding, add a lazy getter here:
 *
 *   let _subscriber = null;
 *   function getSubscriber() {
 *     if (!_subscriber) _subscriber = redisClient.duplicate();
 *     return _subscriber;
 *   }
 */
const { createClient } = require('redis');
const logger = require('../utils/logger');
const env = require('./env.config');

const redisClient = createClient({ url: env.redisUrl });

redisClient.on('error', (err) => logger.error(`Redis client error: ${err.message}`));

async function connectRedis() {
  await redisClient.connect();
  logger.info('Redis connected');
}

// No-op subscriber stub — the real subscriber connection was intentionally
// removed because realtime/redis.subscriber.js is a no-op. server.js still
// destructures redisSubscriber for a graceful .quit() call on shutdown.
const redisSubscriber = { quit: async () => {} };

module.exports = { redisClient, redisSubscriber, connectRedis };
