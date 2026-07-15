/**
 * In-memory map of open SSE connections, keyed by query_id. Works for a
 * single Node instance; if you ever scale Node horizontally, this needs
 * to move to a shared store (e.g. sticky sessions, or fan out via Redis
 * itself) since a connection opened on instance A can't be written to
 * from instance B.
 */
const connections = new Map();

function addConnection(queryId, res) {
  connections.set(queryId, res);
}

function removeConnection(queryId) {
  connections.delete(queryId);
}

function sendToConnection(queryId, payload) {
  const res = connections.get(queryId);
  if (!res) return false; // client disconnected or never connected - not an error, just log-worthy upstream
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
  return true;
}

function closeConnection(queryId) {
  const res = connections.get(queryId);
  if (res) res.end();
  connections.delete(queryId);
}

module.exports = { addConnection, removeConnection, sendToConnection, closeConnection };
