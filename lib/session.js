'use strict';

/**
 * Parse a stored session. Accepts what the file storage returns (Buffer or string)
 * as well as the legacy `auth.token` state value, which was either the token JSON
 * or, in very old installations, a bare access token.
 *
 * @param {any} raw file content or state value
 * @returns {Record<string, any> | null} session object or null if unusable
 */
function parseSession(raw) {
  if (raw == null) {
    return null;
  }
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  if (!text.trim()) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Legacy: the state held the bare access token
    return { access_token: text };
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.access_token) {
    return parsed;
  }
  return null;
}

module.exports = { parseSession };
