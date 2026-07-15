const { OAuth2Client } = require('google-auth-library');
const env = require('../../config/env.config');

// ponytail: single client instance, reused across requests
const client = new OAuth2Client(env.googleClientId);

async function verifyGoogleIdToken(idToken) {
  const ticket = await client.verifyIdToken({
    idToken,
    audience: env.googleClientId,
  });
  const payload = ticket.getPayload();
  return { email: payload.email, googleId: payload.sub, name: payload.name };
}

module.exports = { verifyGoogleIdToken };
