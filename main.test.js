'use strict';

const { expect } = require('chai');

// @iobroker/adapter-core looks for a js-controller installation while it is being loaded and
// kills the process when there is none, so requiring main.js outside an ioBroker host needs
// the base class handed to it instead. Nothing of it is used here: the tests drive one method
// on a hand-built object, and never construct an adapter.
const Module = /** @type {any} */ (require('module'));
const load = Module._load;
Module._load = function (/** @type {string} */ request, /** @type {any[]} */ ...rest) {
  return request === '@iobroker/adapter-core' ? { Adapter: class {} } : load.call(this, request, ...rest);
};
let Navimow;
try {
  // In a finally, so a main.js that fails to load does not leave every test file after this
  // one requiring through the patch.
  ({ Navimow } = require('./main'));
} finally {
  Module._load = load;
}

const DEVICE = '21EAA2615Y2474';
const TOPIC = `downlink/vehicle/${DEVICE}/realtimeData/location`;

/**
 * A stand-in for the adapter that is just complete enough to run handleMqttMessage:
 * everything the session decision reads is real, everything it only writes to is a stub.
 * @param {object} [seed] the state the mower left the last session in
 * @returns {object} the fake adapter
 */
function adapter(seed = {}) {
  const fake = Object.create(Navimow.prototype);
  Object.assign(fake, {
    log: { debug() {}, info() {}, warn() {}, error() {} },
    deviceArray: [DEVICE],
    // Recorded rather than ignored: a reading that arrived late must not reach the states
    // either, and this is the only place the payload gets written to them.
    parsed: [],
    json2iob: {
      parse(/** @type {string} */ _id, /** @type {any} */ value) {
        fake.parsed.push(value);
      },
    },
    setState() {},
    setStateAsync: () => Promise.resolve(),
    renderMap() {},
    saveMapTrack: () => Promise.resolve(),
    pushTrackPoint(deviceId, point) {
      this.locationHistory[deviceId].push(point);
    },
    lastLocationMessage: {},
    locationMqttStale: {},
    locationHistory: { [DEVICE]: [] },
    lastLocation: {},
    pendingLocation: {},
    trackTolerance: {},
    sessionStart: {},
    lastMowingPercentage: {},
    lastSubtotalArea: {},
    lastLocationAt: {},
  });
  return Object.assign(fake, seed);
}

/**
 * @param {object} fake the adapter under test
 * @param {object[]} points one MQTT location payload
 */
function send(fake, points) {
  fake.handleMqttMessage(TOPIC, Buffer.from(JSON.stringify(points)));
}

// The two messages below are copied from a debug log of a real start (2026-08-11): the mower
// announces the new task with the mowed area already at zero while the percentage still
// reports the 100 % it docked at, and only minutes later does the percentage follow.
const START = {
  action: -1,
  currentMowBoundary: 2,
  currentMowProgress: 10000,
  mowingPercentage: 100,
  mowingWeekArea: '734.08',
  subtotalArea: '0.0',
  time: 1786428235467,
  type: 2,
};
const FIRST_PERCENT = {
  action: 8,
  currentMowBoundary: 2,
  currentMowProgress: 104,
  mowingPercentage: 1,
  mowingWeekArea: '738.24',
  subtotalArea: '4.21',
  time: 1786428451780,
  type: 2,
};

// A session ending at 100 %, and the sample the broker delivered an hour and three quarters
// late on 2026-08-11 - from the resume after a charging break, long since overtaken.
const SESSION_DONE = {
  action: 5,
  currentMowProgress: 10000,
  mowingPercentage: 100,
  mowingWeekArea: '1096.92',
  subtotalArea: '362.91',
  time: 1786447746312,
  type: 2,
};
const LATE_ARRIVAL = {
  action: -1,
  currentMowProgress: 6213,
  mowingPercentage: 62,
  mowingWeekArea: '961.19',
  subtotalArea: '227.18',
  time: 1786441689297,
  type: 2,
};

describe('mowing session detection', () => {
  it('clears the track on the message announcing the new task, not minutes later', () => {
    const fake = adapter({
      locationHistory: { [DEVICE]: [{ x: 1, y: 1 }, { x: 2, y: 2 }] },
      lastMowingPercentage: { [DEVICE]: 100 },
      lastSubtotalArea: { [DEVICE]: 421 },
      sessionStart: { [DEVICE]: { index: 2, at: Date.now() } },
    });

    send(fake, [START]);
    expect(fake.locationHistory[DEVICE]).to.have.lengthOf(0);
    // Zero, not the stale 100 that rode along in the same message - otherwise the percentage
    // catching up below would ask for a second reset.
    expect(fake.lastMowingPercentage[DEVICE]).to.equal(0);
    expect(fake.lastSubtotalArea[DEVICE]).to.equal(0);

    send(fake, [{ postureX: '0.5', postureY: '0.5', type: 1 }]);
    send(fake, [FIRST_PERCENT]);
    expect(fake.locationHistory[DEVICE]).to.have.lengthOf(1);
    expect(fake.lastMowingPercentage[DEVICE]).to.equal(1);
  });

  it('keeps the track when the mower carries on after a charging break', () => {
    const fake = adapter({
      locationHistory: { [DEVICE]: [{ x: 1, y: 1 }, { x: 2, y: 2 }] },
      lastMowingPercentage: { [DEVICE]: 57 },
      lastSubtotalArea: { [DEVICE]: 240 },
      sessionStart: { [DEVICE]: { index: 2, at: Date.now() } },
    });

    send(fake, [{ ...FIRST_PERCENT, mowingPercentage: 58, subtotalArea: '244.2' }]);
    expect(fake.locationHistory[DEVICE]).to.have.lengthOf(2);
    expect(fake.lastSubtotalArea[DEVICE]).to.equal(244.2);
  });

  it('ignores a progress sample the broker delivered late', () => {
    const fake = adapter({
      locationHistory: { [DEVICE]: [{ x: 1, y: 1 }, { x: 2, y: 2 }] },
    });

    send(fake, [SESSION_DONE]);
    send(fake, [LATE_ARRIVAL]);
    expect(fake.locationHistory[DEVICE]).to.have.lengthOf(2);
    // Neither the percentage nor the area of the stale sample may be remembered - taking
    // either would make the next real sample look like a restart in its own right.
    expect(fake.lastMowingPercentage[DEVICE]).to.equal(100);
    expect(fake.lastSubtotalArea[DEVICE]).to.equal(362.91);
    // And it must not reach the states: only the message that was current was written.
    expect(fake.parsed).to.deep.equal([SESSION_DONE]);
  });

  it('does not let positions push the mark past a progress still on its way', () => {
    const fake = adapter({
      locationHistory: { [DEVICE]: [{ x: 1, y: 1 }, { x: 2, y: 2 }] },
      lastSubtotalArea: { [DEVICE]: 362.91 },
      lastMowingPercentage: { [DEVICE]: 100 },
      lastLocationAt: { [DEVICE]: { 2: SESSION_DONE.time } },
    });

    // A position from after the progress below, arriving before it - routine in this stream.
    send(fake, [{ postureX: '1.0', postureY: '1.0', time: SESSION_DONE.time + 4000, type: 1 }]);
    send(fake, [{ mowingPercentage: 0, subtotalArea: '0.0', time: SESSION_DONE.time + 2000, type: 2 }]);
    expect(fake.locationHistory[DEVICE]).to.have.lengthOf(0);
  });

  it('drops a position the mower sent before one already collected', () => {
    const fake = adapter({ locationHistory: { [DEVICE]: [] } });

    send(fake, [{ postureX: '1.0', postureY: '1.0', time: 1_000_000, type: 1 }]);
    send(fake, [{ postureX: '2.0', postureY: '2.0', time: 1_004_000, type: 1 }]);
    // Reordered by the broker, four seconds behind the one before it.
    send(fake, [{ postureX: '3.0', postureY: '3.0', time: 1_002_000, type: 1 }]);
    expect(fake.locationHistory[DEVICE].map((p) => p.x)).to.deep.equal([1, 2]);
  });

  it('keeps the kinds apart, so a stale position does not silence a fresh progress', () => {
    const fake = adapter({
      locationHistory: { [DEVICE]: [{ x: 1, y: 1 }, { x: 2, y: 2 }] },
      lastSubtotalArea: { [DEVICE]: 362.91 },
      lastMowingPercentage: { [DEVICE]: 100 },
    });

    // One payload holding both: the position is overtaken, the progress is not.
    send(fake, [{ postureX: '9.0', postureY: '9.0', time: 2_000_000, type: 1 }]);
    send(fake, [
      { postureX: '8.0', postureY: '8.0', time: 1_999_000, type: 1 },
      { mowingPercentage: 0, subtotalArea: '0.0', time: 1_999_000, type: 2 },
    ]);
    expect(fake.locationHistory[DEVICE]).to.have.lengthOf(0);
  });

  it('ignores a fall too small to be a new session', () => {
    const fake = adapter({
      locationHistory: { [DEVICE]: [{ x: 1, y: 1 }, { x: 2, y: 2 }] },
      lastSubtotalArea: { [DEVICE]: 240 },
    });

    send(fake, [{ subtotalArea: '239.99', type: 2 }]);
    expect(fake.locationHistory[DEVICE]).to.have.lengthOf(2);
    expect(fake.lastSubtotalArea[DEVICE]).to.equal(239.99);
  });

  it('does not read an empty area as a fresh start', () => {
    const fake = adapter({
      locationHistory: { [DEVICE]: [{ x: 1, y: 1 }, { x: 2, y: 2 }] },
      lastSubtotalArea: { [DEVICE]: 240 },
    });

    send(fake, [{ subtotalArea: '', type: 2 }]);
    expect(fake.locationHistory[DEVICE]).to.have.lengthOf(2);
    expect(fake.lastSubtotalArea[DEVICE]).to.equal(240);
  });

  it('still starts a session on the percentage alone when no area is reported', () => {
    const fake = adapter({
      locationHistory: { [DEVICE]: [{ x: 1, y: 1 }, { x: 2, y: 2 }] },
      lastMowingPercentage: { [DEVICE]: 100 },
    });

    send(fake, [{ mowingPercentage: 2, type: 2 }]);
    expect(fake.locationHistory[DEVICE]).to.have.lengthOf(0);
  });

  it('does not clear again while the area stands at zero through the first percent', () => {
    const fake = adapter({
      locationHistory: { [DEVICE]: [{ x: 1, y: 1 }] },
      lastMowingPercentage: { [DEVICE]: 0 },
      lastSubtotalArea: { [DEVICE]: 0 },
    });

    send(fake, [{ mowingPercentage: 0, subtotalArea: '0.0', type: 2 }]);
    expect(fake.locationHistory[DEVICE]).to.have.lengthOf(1);
  });
});

describe('MQTT credential refresh on close', () => {
  /**
   * @param {object} [seed] the adapter state the close handler would read
   * @returns {any} an object carrying just the method under test
   */
  function closing(seed = {}) {
    return Object.assign(Object.create(Navimow.prototype), {
      mqttRefreshing: false,
      lastMqttCredentialRefresh: 0,
      ...seed,
    });
  }

  it('refreshes at once when a connection that was up goes down', () => {
    // Even right after a refresh: a rotated token is the usual reason it dropped.
    const fake = closing({ lastMqttCredentialRefresh: Date.now() });
    expect(fake.shouldRefreshMqttCredentials(true)).to.equal(true);
  });

  it('does not refresh per attempt while a connect keeps failing', () => {
    const fake = closing({ lastMqttCredentialRefresh: Date.now() - 1000 });
    expect(fake.shouldRefreshMqttCredentials(false)).to.equal(false);
  });

  it('still refreshes eventually, so an expired token is not retried for ever', () => {
    const fake = closing({ lastMqttCredentialRefresh: Date.now() - 11 * 60 * 1000 });
    expect(fake.shouldRefreshMqttCredentials(false)).to.equal(true);
  });

  it('never starts a second refresh on top of one already running', () => {
    const fake = closing({ mqttRefreshing: true });
    expect(fake.shouldRefreshMqttCredentials(true)).to.equal(false);
  });
});
