const { redisSubscriber } = require('../../config/redis.config');
const logger = require('../../utils/logger');
const { sendToConnection, closeConnection } = require('./sse.manager');

const CHANNEL_PREFIX = 'fallback-result:'; // MUST match Python's REDIS_RESULT_CHANNEL_PREFIX

/**
 * Subscribes to every channel matching fallback-result:* using Redis
 * pattern subscribe (PSUBSCRIBE), since query_id (and therefore the
 * channel name) is only known at request time, not startup time.
 */
async function startRedisSubscriber() {
  await redisSubscriber.pSubscribe(`${CHANNEL_PREFIX}*`, (message, channel) => {
    const queryId = channel.slice(CHANNEL_PREFIX.length);
    logger.info(`Received fallback result on channel=${channel}`);

    let payload;
    try {
      payload = JSON.parse(message);
    } catch (err) {
      logger.error(`Failed to parse Redis message on channel=${channel}: ${err.message}`);
      return;
    }

    const delivered = sendToConnection(queryId, { status: 'done', ...payload });
    if (!delivered) {
      logger.warn(`No open SSE connection for query_id=${queryId} - frontend may have disconnected`);
    }
    closeConnection(queryId); // one-shot: this channel only ever publishes once per query_id, so end the stream
  });

  logger.info(`Redis subscriber listening on pattern "${CHANNEL_PREFIX}*"`);
}

module.exports = { startRedisSubscriber };
