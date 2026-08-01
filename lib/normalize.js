'use strict';

const INTERVAL_DEFAULT_MIN = 5;
const INTERVAL_MIN = 1;
const INTERVAL_MAX = 1440;

/**
 * Normalize the configured HTTP polling interval.
 * Values below one minute would hammer the cloud API, values above ~24.8 days
 * overflow the 32 bit delay of setInterval and fire in an endless loop.
 *
 * @param {any} value raw native config value
 * @returns {number} whole minutes, 0 meaning "polling disabled"
 */
function normalizeInterval(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    return INTERVAL_DEFAULT_MIN;
  }
  if (n === 0) {
    return 0;
  }
  return Math.min(INTERVAL_MAX, Math.max(INTERVAL_MIN, Math.round(n)));
}

/**
 * getVehicleStatus carries no direct battery field, the percentage is hidden in
 * capacityRemaining. Entries marked PERCENTAGE win, otherwise the first entry is
 * used (Segway's API only returns the battery percentage there in practice).
 *
 * @param {any} deviceData single device entry of the status payload
 * @returns {number | null} battery percentage or null if it cannot be derived
 */
function deriveBattery(deviceData) {
  if (!deviceData || deviceData.battery != null || !Array.isArray(deviceData.capacityRemaining)) {
    return null;
  }
  for (const item of deviceData.capacityRemaining) {
    if (item && String(item.unit || '').toUpperCase() === 'PERCENTAGE') {
      const n = Number(item.rawValue);
      if (Number.isFinite(n)) {
        return n;
      }
    }
  }
  const first = deviceData.capacityRemaining[0];
  if (first) {
    const n = Number(first.rawValue);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  return null;
}

const STATE_TO_REMOTE = {
  isRunning: 'start',
  mowing: 'start',
  isPaused: 'pause',
  paused: 'pause',
  isDocking: 'dock',
  returning: 'dock',
  isDocked: 'dock',
  docked: 'dock',
  charging: 'dock',
  isIdle: 'stop',
  isIdel: 'stop',
  idle: 'stop',
};

/**
 * Map a reported vehicle state to the remote button that represents it.
 *
 * @param {any} vehicleState value of status.vehicleState
 * @returns {string | null} remote command name or null for unmapped states
 */
function activeRemoteCommand(vehicleState) {
  return STATE_TO_REMOTE[String(vehicleState)] || null;
}

module.exports = { normalizeInterval, deriveBattery, activeRemoteCommand };
