'use strict';

/**
 * Split an MQTT topic of the shape /downlink/vehicle/{deviceId}/.../{channel}.
 *
 * @param {string} topic raw topic as delivered by the broker
 * @returns {{ deviceId: string, channel: string } | null} null if the topic does not belong to a vehicle
 */
function parseTopic(topic) {
  const parts = String(topic)
    .split('/')
    .filter((p) => p !== '');
  if (parts.length < 4 || parts[0] !== 'downlink' || parts[1] !== 'vehicle') {
    return null;
  }
  return { deviceId: parts[2], channel: parts[parts.length - 1] };
}

/**
 * A mowingPercentage of 0 marks the start of a new mowing session, so the collected path is dropped.
 *
 * @param {any[]} points location payload entries
 * @returns {boolean} true if any entry reports mowingPercentage 0
 */
function hasMowingReset(points) {
  for (const p of points) {
    if (p && p.mowingPercentage != null && Number(p.mowingPercentage) === 0) {
      return true;
    }
  }
  return false;
}

/**
 * Append location points to a path history, skipping unusable and repeated coordinates.
 * The history is capped in place to the newest maxPoints entries.
 *
 * @param {{x: number, y: number}[]} history mutated in place
 * @param {any[]} points location payload entries
 * @param {number} maxPoints upper bound of retained points
 * @returns {number} number of appended points
 */
function appendLocationPoints(history, points, maxPoints) {
  let added = 0;
  for (const p of points) {
    if (!p || p.postureX == null || p.postureY == null) {
      continue;
    }
    const x = parseFloat(p.postureX);
    const y = parseFloat(p.postureY);
    if (isNaN(x) || isNaN(y)) {
      continue;
    }
    const last = history[history.length - 1];
    if (!last || last.x !== x || last.y !== y) {
      history.push({ x, y });
      added++;
    }
  }
  if (history.length > maxPoints) {
    history.splice(0, history.length - maxPoints);
  }
  return added;
}

module.exports = { parseTopic, hasMowingReset, appendLocationPoints };
