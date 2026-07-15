const express = require('express');
const logger = require('../../utils/logger');
const { addConnection, closeConnection } = require('./sse.manager');

const router = express.Router();

const SSE_TIMEOUT_MS = 90_000; // ponytail: 90s max — if Python never publishes, clean up the connection

/**
 * Frontend opens this immediately after receiving a query_id from
 * POST /datasets/search. Stays open until the Redis message arrives
 * (redis.subscriber.js writes then closes it), the client disconnects,
 * or the 90s timeout fires.
 */
router.get('/:queryId', (req, res) => {
  const { queryId } = req.params;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(`data: ${JSON.stringify({ status: 'connected', queryId })}\n\n`);

  addConnection(queryId, res);
  logger.info(`SSE connection opened for query_id=${queryId}`);

  // Guard against Python crash/timeout: if no result arrives, clean up and notify client
  const timeout = setTimeout(() => {
    res.write(`data: ${JSON.stringify({ status: 'timeout' })}\n\n`);
    closeConnection(queryId);
    logger.warn(`SSE timeout for query_id=${queryId} — no result after ${SSE_TIMEOUT_MS / 1000}s`);
  }, SSE_TIMEOUT_MS);

  req.on('close', () => {
    clearTimeout(timeout); // don't fire after the client already left
    closeConnection(queryId);
    logger.info(`SSE connection closed for query_id=${queryId}`);
  });
});

module.exports = router;
