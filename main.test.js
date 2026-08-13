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
    config: { mapEnabled: true },
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
    lastVehicleState: {},
    dockPosition: {},
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

// The message the mower sent from the dock on 2026-08-13 at 03:14, hours after it had
// stopped: no task, and the broken-off session booked into the week total.
const NO_TASK = {
  action: -1,
  currentMowBoundary: 0,
  currentMowProgress: 0,
  mapWorkPosition: 'FFFFFFFF' + '0'.repeat(248),
  mowStartType: 0,
  mowingPercentage: 0,
  mowingWeekArea: '1477.67',
  subtotalArea: '0.0',
  time: 1786583683024,
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

  it('keeps the track when the mower reports no task at all', () => {
    const fake = adapter({
      locationHistory: { [DEVICE]: [{ x: 1, y: 1 }, { x: 2, y: 2 }] },
      lastSubtotalArea: { [DEVICE]: 4.08 },
      lastMowingPercentage: { [DEVICE]: 1 },
      lastVehicleState: { [DEVICE]: 'isDocked' },
    });

    send(fake, [NO_TASK]);
    expect(fake.locationHistory[DEVICE]).to.have.lengthOf(2);
    // Neither zero may be remembered: taken for the truth, the next real sample would look
    // like a rise out of nothing and the session before it would never be closed.
    expect(fake.lastSubtotalArea[DEVICE]).to.equal(4.08);
    expect(fake.lastMowingPercentage[DEVICE]).to.equal(1);
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

describe('the map switched off', () => {
  it('collects nothing and draws nothing, but still fills the location states', () => {
    const fake = adapter({ config: { mapEnabled: false } });
    let rendered = 0;
    fake.renderMap = () => rendered++;

    send(fake, [{ postureX: '1.0', postureY: '1.0', time: 1_000_000, type: 1 }]);
    send(fake, [START]);
    expect(fake.locationHistory[DEVICE]).to.have.lengthOf(0);
    expect(rendered).to.equal(0);
    // The states are the part that has nothing to do with the map.
    expect(fake.parsed).to.have.lengthOf(2);
  });

  it('still drops a reading the broker delivered late', () => {
    const fake = adapter({ config: { mapEnabled: false } });

    send(fake, [SESSION_DONE]);
    send(fake, [LATE_ARRIVAL]);
    expect(fake.parsed).to.deep.equal([SESSION_DONE]);
  });
});

describe('the placeholder posture of a standing mower', () => {
  // Copied from a debug log of 2026-08-12: the mower stood in the dock all night and sent this
  // every five minutes.
  const DOCKED = { postureTheta: '0.0', postureX: '0.0', postureY: '0.0', time: 1786509405725, type: 1, vehicleState: 1 };

  it('neither moves the marker onto the origin nor turns it', () => {
    const fake = adapter({
      locationHistory: { [DEVICE]: [{ x: 0.155, y: -0.002, theta: 1.9 }] },
      lastLocation: { [DEVICE]: { x: 0.155, y: -0.002 } },
    });

    send(fake, [DOCKED]);
    expect(fake.locationHistory[DEVICE]).to.deep.equal([{ x: 0.155, y: -0.002, theta: 1.9 }]);
    // And nothing of it reaches the location states either.
    expect(fake.parsed).to.have.lengthOf(0);
  });

  it('keeps a real position that happens to sit on an axis', () => {
    const fake = adapter({ locationHistory: { [DEVICE]: [] } });

    send(fake, [{ postureX: '0.0', postureY: '2.5', postureTheta: '0.0', time: 1_000_000, type: 1 }]);
    expect(fake.locationHistory[DEVICE]).to.deep.equal([{ x: 0, y: 2.5, theta: 0 }]);
  });

  it('does not let a placeholder behind another reading reach the states', () => {
    const fake = adapter({ locationHistory: { [DEVICE]: [] } });

    send(fake, [{ partitionIds: [1], time: 1_000_000, type: 3 }, DOCKED]);
    expect(fake.parsed).to.deep.equal([{ partitionIds: [1], time: 1_000_000, type: 3 }]);
  });
});

describe('what a failed API call says in the log', () => {
  /**
   * @param {any} error the rejection to log
   * @returns {string} the one line it produced
   */
  function logged(error) {
    const lines = [];
    const fake = Object.assign(Object.create(Navimow.prototype), {
      log: { error: (/** @type {string} */ m) => lines.push(m), warn: (/** @type {string} */ m) => lines.push(m) },
    });
    fake.logApiError('updateDevices error', error);
    expect(lines).to.have.lengthOf(1);
    return lines[0];
  }

  // The body the Azure gateway in front of the API answered with on 2026-08-12.
  const GATEWAY_502 =
    '<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body>\r\n<center><h1>502 Bad Gateway</h1></center>\r\n' +
    '<hr><center>Microsoft-Azure-Application-Gateway/v2</center>\r\n</body>\r\n</html>\r\n';

  it('boils an HTML error page down to its title', () => {
    const line = logged({ message: 'Request failed with status code 502', response: { status: 502, data: GATEWAY_502 } });
    expect(line).to.equal('updateDevices error: Request failed with status code 502 - HTTP 502: 502 Bad Gateway');
  });

  it('keeps a JSON body, which carries the API reason', () => {
    const line = logged({ message: 'Request failed with status code 400', response: { status: 400, data: { code: 5, desc: 'no' } } });
    expect(line).to.contain('HTTP 400: {"code":5,"desc":"no"}');
  });

  it('caps a body long enough to bury the log', () => {
    const line = logged({ message: 'boom', response: { status: 500, data: 'x'.repeat(5000) } });
    expect(line).to.have.length.below(260);
    expect(line).to.contain('...');
  });

  it('says the status alone when there is no body, and nothing extra without a response', () => {
    expect(logged({ message: 'boom', response: { status: 503, data: '' } })).to.equal('updateDevices error: boom - HTTP 503');
    expect(logged({ message: 'connect ETIMEDOUT' })).to.equal('updateDevices error: connect ETIMEDOUT');
  });
});

describe('the map reset', () => {
  it('redraws with the charging station instead of blanking the picture', () => {
    const fake = adapter({
      locationHistory: { [DEVICE]: [{ x: 1, y: 1 }, { x: 2, y: 2 }] },
      dockPosition: { [DEVICE]: { x: 0.2, y: 0 } },
    });
    let rendered = 0;
    fake.renderMapNow = () => rendered++;
    let blanked = false;
    fake.setState = (/** @type {string} */ id, /** @type {any} */ val) => {
      if (id.endsWith('.map') && val === '') blanked = true;
    };

    fake.resetMap(DEVICE, 'test');
    expect(fake.locationHistory[DEVICE]).to.have.lengthOf(0);
    expect(rendered).to.equal(1);
    expect(blanked).to.equal(false);
  });

  it('clears the picture when there is no station to show', () => {
    const fake = adapter({ locationHistory: { [DEVICE]: [{ x: 1, y: 1 }] }, dockPosition: {} });
    let blanked = false;
    fake.setState = (/** @type {string} */ id, /** @type {any} */ val) => {
      if (id.endsWith('.map') && val === '') blanked = true;
    };

    fake.resetMap(DEVICE, 'test');
    expect(blanked).to.equal(true);
  });
});

describe('a mower standing in the dock', () => {
  // Three readings of one docked morning (2026-08-12). The mower did not move; its own pose
  // estimate did.
  const DRIFT = [
    { postureX: '0.329', postureY: '0.042', postureTheta: '-2.859', time: 1_000_000, type: 1 },
    { postureX: '0.551', postureY: '-0.252', postureTheta: '-2.86', time: 1_300_000, type: 1 },
    { postureX: '0.911', postureY: '-0.707', postureTheta: '-2.859', time: 1_600_000, type: 1 },
  ];

  it('does not grow the track while it stands there', () => {
    const fake = adapter({
      locationHistory: { [DEVICE]: [{ x: 0.2, y: 0.05, theta: -2.85 }] },
      lastVehicleState: { [DEVICE]: 'isDocked' },
    });

    for (const p of DRIFT) send(fake, [p]);
    expect(fake.locationHistory[DEVICE]).to.have.lengthOf(1);
    // The states still see every one of them - only the track is spared.
    expect(fake.parsed).to.have.lengthOf(3);
  });

  it('still takes the position it arrives with, which is reported while docking', () => {
    const fake = adapter({
      locationHistory: { [DEVICE]: [] },
      lastVehicleState: { [DEVICE]: 'isDocking' },
    });

    send(fake, [DRIFT[0]]);
    expect(fake.locationHistory[DEVICE]).to.deep.equal([{ x: 0.329, y: 0.042, theta: -2.859 }]);
  });

  it('collects again as soon as the mower drives out', () => {
    const fake = adapter({
      locationHistory: { [DEVICE]: [] },
      lastVehicleState: { [DEVICE]: 'isDocked' },
    });

    send(fake, [DRIFT[0]]);
    fake.lastVehicleState[DEVICE] = 'isRunning';
    send(fake, [DRIFT[1]]);
    expect(fake.locationHistory[DEVICE].map((p) => p.x)).to.deep.equal([0.551]);
  });
});

describe('poll with no devices known', () => {
  /**
   * @param {object} [seed] what the poll finds when it runs
   * @returns {any} an adapter carrying the poll and stubs for what it reaches out to
   */
  function polling(seed = {}) {
    const fake = Object.assign(Object.create(Navimow.prototype), {
      log: { debug() {}, info() {}, warn() {}, error() {} },
      deviceArray: [],
      mqttClient: null,
      httpPollRunning: false,
      httpPollStartedAt: 0,
      httpPollToken: 0,
      calls: [],
      getDeviceList() {
        fake.calls.push('getDeviceList');
        return Promise.resolve();
      },
      connectMqtt() {
        fake.calls.push('connectMqtt');
        return Promise.resolve();
      },
      updateDevices() {
        fake.calls.push('updateDevices');
        return Promise.resolve();
      },
    });
    return Object.assign(fake, seed);
  }

  it('looks for devices again, so a failed discovery is not the end of it', async () => {
    const fake = polling();
    // The network is there this time.
    fake.getDeviceList = () => {
      fake.calls.push('getDeviceList');
      fake.deviceArray = ['21EAA2615Y2474'];
      return Promise.resolve();
    };

    await fake.pollDevices('interval');
    expect(fake.calls).to.deep.equal(['getDeviceList', 'connectMqtt', 'updateDevices']);
  });

  it('does not build a second MQTT client when one is already there', async () => {
    const fake = polling({ mqttClient: {} });
    fake.getDeviceList = () => {
      fake.calls.push('getDeviceList');
      fake.deviceArray = ['21EAA2615Y2474'];
      return Promise.resolve();
    };

    await fake.pollDevices('interval');
    expect(fake.calls).to.deep.equal(['getDeviceList', 'updateDevices']);
  });

  it('leaves a poll that knows its devices alone', async () => {
    const fake = polling({ deviceArray: ['21EAA2615Y2474'] });

    await fake.pollDevices('interval');
    expect(fake.calls).to.deep.equal(['updateDevices']);
  });
});

describe('token refresh retry', () => {
  /**
   * @returns {any} an adapter carrying the retry and a setTimeout that only records
   */
  function refreshing() {
    return Object.assign(Object.create(Navimow.prototype), {
      log: { debug() {}, info() {}, warn() {}, error() {} },
      tokenRefreshFailures: 0,
      refreshTokenTimeout: null,
      cleared: 0,
      waits: /** @type {number[]} */ ([]),
      setTimeout(/** @type {Function} */ _fn, /** @type {number} */ ms) {
        this.waits.push(ms);
        return { armed: ms };
      },
      clearTimeout() {
        this.cleared++;
      },
    });
  }

  it('waits longer the more refreshes have failed, and stops growing at the last step', () => {
    const fake = refreshing();
    for (let i = 0; i < 6; i++) fake.scheduleTokenRefreshRetry();
    expect(fake.waits).to.deep.equal([60_000, 300_000, 900_000, 3_600_000, 3_600_000, 3_600_000]);
  });

  it('drops the pending attempt before arming the next, so the chain stays one timer', () => {
    const fake = refreshing();
    fake.scheduleTokenRefreshRetry();
    fake.scheduleTokenRefreshRetry();
    // Nothing to clear on the first call, one to clear on the second.
    expect(fake.cleared).to.equal(1);
    expect(fake.refreshTokenTimeout).to.deep.equal({ armed: 300_000 });
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

// Last on purpose: the adapter remembers the outcome of loading the canvas library, so making
// it fail here would make it fail for every test after this one. Nothing else renders.
describe('a host without the canvas library', () => {
  it('leaves the adapter running and says so once', () => {
    const warnings = [];
    const fake = Object.assign(Object.create(Navimow.prototype), {
      log: { debug() {}, info() {}, warn: (/** @type {string} */ m) => warnings.push(m), error() {} },
      locationHistory: { [DEVICE]: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
      dockPosition: {},
      canvasWarned: false,
    });

    const failing = Module._load;
    Module._load = function (/** @type {string} */ request, /** @type {any[]} */ ...rest) {
      if (request === '@napi-rs/canvas') throw new Error('no prebuild for this platform');
      return failing.call(this, request, ...rest);
    };
    try {
      fake.renderMap(DEVICE);
      fake.renderMap(DEVICE);
    } finally {
      Module._load = failing;
    }

    expect(warnings).to.have.lengthOf(1);
    expect(warnings[0]).to.contain('no prebuild for this platform');
  });
});
