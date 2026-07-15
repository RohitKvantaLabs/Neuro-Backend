/**
 * node-redis v4+ requires a dedicated connection for SUBSCRIBE mode - a
 * client that's subscribing can't also run normal commands. We keep two
 * clients: `redisClient` for everything else, `redisSubscriber` only
 * ever used by realtime/redis.subscriber.js.
 */
const { createClient } = require('redis');
const logger = require('../utils/logger');
const env = require('./env.config');

const redisClient = createClient({ url: env.redisUrl });
const redisSubscriber = redisClient.duplicate();

redisClient.on('error', (err) => logger.error(`Redis client error: ${err.message}`));
redisSubscriber.on('error', (err) => logger.error(`Redis subscriber error: ${err.message}`));

async function connectRedis() {
  await redisClient.connect();
  await redisSubscriber.connect();
  logger.info('Redis connected (client + subscriber)');
}

module.exports = { redisClient, redisSubscriber, connectRedis };
