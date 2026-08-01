'use strict';

const { expect } = require('chai');
const { normalizeInterval, deriveBattery, activeRemoteCommand } = require('../lib/normalize');

describe('normalize.normalizeInterval', () => {
  it('keeps sane values and the explicit "disabled" value', () => {
    expect(normalizeInterval(5)).to.equal(5);
    expect(normalizeInterval('15')).to.equal(15);
    expect(normalizeInterval(0)).to.equal(0);
  });

  it('lifts sub-minute values that would hammer the cloud API', () => {
    expect(normalizeInterval(0.01)).to.equal(1);
    expect(normalizeInterval(0.6)).to.equal(1);
  });

  it('caps values that would overflow the 32 bit setInterval delay', () => {
    expect(normalizeInterval(999999)).to.equal(1440);
  });

  it('falls back to the default for unusable input', () => {
    expect(normalizeInterval(-1)).to.equal(5);
    expect(normalizeInterval(NaN)).to.equal(5);
    expect(normalizeInterval('abc')).to.equal(5);
    expect(normalizeInterval(undefined)).to.equal(5);
    expect(normalizeInterval(Infinity)).to.equal(5);
  });
});

describe('normalize.deriveBattery', () => {
  it('prefers the entry marked as PERCENTAGE', () => {
    expect(
      deriveBattery({
        capacityRemaining: [
          { unit: 'MINUTES', rawValue: 90 },
          { unit: 'percentage', rawValue: 42 },
        ],
      }),
    ).to.equal(42);
  });

  it('falls back to the first entry', () => {
    expect(deriveBattery({ capacityRemaining: [{ rawValue: '77' }] })).to.equal(77);
  });

  it('returns null when nothing usable is present', () => {
    expect(deriveBattery({ battery: 50, capacityRemaining: [{ rawValue: 10 }] })).to.equal(null);
    expect(deriveBattery({ capacityRemaining: [] })).to.equal(null);
    expect(deriveBattery({ capacityRemaining: [{ rawValue: 'n/a' }] })).to.equal(null);
    expect(deriveBattery({})).to.equal(null);
    expect(deriveBattery(null)).to.equal(null);
  });
});

describe('normalize.activeRemoteCommand', () => {
  it('maps the documented vehicle states', () => {
    expect(activeRemoteCommand('isRunning')).to.equal('start');
    expect(activeRemoteCommand('isPaused')).to.equal('pause');
    expect(activeRemoteCommand('isDocking')).to.equal('dock');
    expect(activeRemoteCommand('isIdle')).to.equal('stop');
  });

  it('maps the isIdel typo the API actually sends', () => {
    expect(activeRemoteCommand('isIdel')).to.equal('stop');
  });

  it('returns null for unmapped states', () => {
    expect(activeRemoteCommand('isMapping')).to.equal(null);
    expect(activeRemoteCommand(undefined)).to.equal(null);
  });
});
