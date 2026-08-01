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

/**
 * File name of the rendered map inside the adapter file storage.
 *
 * @param {string} deviceId sanitized device id
 * @returns {string} path relative to the adapter file storage
 */
function mapFileName(deviceId) {
  return 'map/' + deviceId + '.png';
}

/**
 * URL of the rendered map, as served by admin and web.
 *
 * @param {string} namespace adapter namespace, e.g. navimow.0
 * @param {string} deviceId sanitized device id
 * @returns {string} URL for the map state
 */
function mapUrl(namespace, deviceId) {
  return '/files/' + namespace + '/' + mapFileName(deviceId);
}

module.exports = { parseSession, mapFileName, mapUrl };
