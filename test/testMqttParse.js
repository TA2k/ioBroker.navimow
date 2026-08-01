'use strict';

const { expect } = require('chai');
const { parseTopic, hasMowingReset, appendLocationPoints } = require('../lib/mqttParse');

describe('mqttParse.parseTopic', () => {
  it('extracts device id and channel from a realtime topic', () => {
    expect(parseTopic('/downlink/vehicle/DEV1/realtimeDate/location')).to.deep.equal({
      deviceId: 'DEV1',
      channel: 'location',
    });
  });

  it('works without the leading slash', () => {
    expect(parseTopic('downlink/vehicle/DEV1/realtimeDate/state')).to.deep.equal({
      deviceId: 'DEV1',
      channel: 'state',
    });
  });

  it('rejects foreign and truncated topics', () => {
    expect(parseTopic('/uplink/vehicle/DEV1/realtimeDate/state')).to.equal(null);
    expect(parseTopic('/downlink/robot/DEV1/realtimeDate/state')).to.equal(null);
    expect(parseTopic('/downlink/vehicle/DEV1')).to.equal(null);
    expect(parseTopic('')).to.equal(null);
  });
});

describe('mqttParse.hasMowingReset', () => {
  it('detects mowingPercentage 0 anywhere in the payload', () => {
    expect(hasMowingReset([{ mowingPercentage: 12 }, { mowingPercentage: 0 }])).to.equal(true);
    expect(hasMowingReset([{ mowingPercentage: '0' }])).to.equal(true);
  });

  it('ignores missing and non-zero values', () => {
    expect(hasMowingReset([{ mowingPercentage: 12 }])).to.equal(false);
    expect(hasMowingReset([{}, null])).to.equal(false);
    expect(hasMowingReset([])).to.equal(false);
  });
});

describe('mqttParse.appendLocationPoints', () => {
  it('appends valid points and reports the count', () => {
    const history = [];
    const added = appendLocationPoints(history, [{ postureX: 1, postureY: 2 }, { postureX: '3', postureY: '4' }], 100);
    expect(added).to.equal(2);
    expect(history).to.deep.equal([
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ]);
  });

  it('skips repeated coordinates and unusable entries', () => {
    const history = [{ x: 1, y: 2 }];
    const added = appendLocationPoints(
      history,
      [{ postureX: 1, postureY: 2 }, { postureX: 'abc', postureY: 5 }, { postureX: null, postureY: 5 }, null],
      100,
    );
    expect(added).to.equal(0);
    expect(history).to.deep.equal([{ x: 1, y: 2 }]);
  });

  it('caps the history to the newest points', () => {
    const history = [];
    appendLocationPoints(
      history,
      Array.from({ length: 10 }, (_, i) => ({ postureX: i, postureY: i })),
      4,
    );
    expect(history).to.deep.equal([
      { x: 6, y: 6 },
      { x: 7, y: 7 },
      { x: 8, y: 8 },
      { x: 9, y: 9 },
    ]);
  });
});
