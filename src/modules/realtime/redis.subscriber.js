/**
 * ponytail: SSE route is unmounted — this subscriber had no consumer.
 * Keeping the module so imports don't break, but pSubscribe is removed
 * to stop the idle Redis connection overhead.
 */
async function startRedisSubscriber() {
  // No-op: SSE/realtime route is not active. Remove this stub when SSE is re-enabled.
}

module.exports = { startRedisSubscriber };
