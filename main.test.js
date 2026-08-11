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
    json2iob: { parse() {} },
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
  type: 2,
};
const FIRST_PERCENT = {
  action: 8,
  currentMowBoundary: 2,
  currentMowProgress: 104,
  mowingPercentage: 1,
  mowingWeekArea: '738.24',
  subtotalArea: '4.21',
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
