'use strict';

const { expect } = require('chai');
const { AppZones } = require('./appZones');
const { AppApiError, AppApiAuthError } = require('./appApi');

/** A minimal adapter: records states and log lines, keeps timers for the test to fire by hand. */
function fakeAdapter() {
  const adapter = {
    config: {},
    states: /** @type {Record<string, any>} */ ({}),
    logs: /** @type {string[]} */ ([]),
    timers: /** @type {{fn: Function, ms: number, cleared: boolean}[]} */ ([]),
    log: {},
    setState(id, val) {
      adapter.states[id] = val;
    },
    async getStateAsync(id) {
      return id in adapter.states ? { val: adapter.states[id] } : null;
    },
    setTimeout(fn, ms) {
      const t = { fn, ms, cleared: false };
      adapter.timers.push(t);
      return t;
    },
    clearTimeout(t) {
      t.cleared = true;
    },
  };
  for (const level of ['debug', 'info', 'warn', 'error']) {
    adapter.log[level] = (/** @type {string} */ msg) => adapter.logs.push(`${level}: ${msg}`);
  }
  return adapter;
}

/** @param {{status?: any[], send?: any[]}} script answers in order; an Error is thrown */
function fakeClient(script) {
  const client = {
    sent: /** @type {any[]} */ ([]),
    statusCalls: 0,
    async status() {
      const next = (script.status || []).shift() ?? { vehicle_state: '0101', network_status: 1, subType: 'H3000' };
      client.statusCalls++;
      if (next instanceof Error) throw next;
      return next;
    },
    async startZones(sn, ids, opts) {
      const next = (script.send || []).shift();
      if (next instanceof Error) throw next;
      client.sent.push({ ids, ...opts });
      return 1219;
    },
  };
  return client;
}

/**
 * @param {ReturnType<typeof fakeClient>} client
 */
function zonesWith(client) {
  const adapter = fakeAdapter();
  const z = new AppZones(adapter);
  z.deviceId = 'SN1';
  z.sn = 'SN1';
  z.running = true;
  z.client = /** @type {any} */ (client);
  z.mapCache = { at: Date.now(), map: {}, zones: [{ id: 1219, name: 'Hauptzone' }] };
  z.schedule = () => {}; // no polling in the test
  return { adapter, z, result: () => adapter.states['SN1.remote.zoneStartResult'] };
}

const offline = () => new AppApiError('cloud', 600003, 'Mower disconnected, please try later');
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Fires the newest pending timer and waits for its try to finish. */
async function fire(adapter) {
  const t = adapter.timers.filter((x) => !x.cleared).pop();
  t.cleared = true;
  t.fn();
  await flush();
}

describe('appZones zone start retry', () => {
  it('sends at once when the mower is online', async () => {
    const client = fakeClient({});
    const { adapter, z, result } = zonesWith(client);
    z.handleRemote('zoneStart', { val: '{"zones":[1219],"reset":false}' });
    await flush();
    expect(client.sent).to.deep.equal([{ ids: [1219], reset: false, ordered: false }]);
    expect(result()).to.equal('sent: 1219 (continue)');
    expect(adapter.timers).to.have.length(0);
  });

  it('retries on 600003 every 2 minutes and reports the try that went through', async () => {
    const client = fakeClient({ send: [offline(), offline()] });
    const { adapter, z, result } = zonesWith(client);
    z.handleRemote('zoneStart', { val: 'Hauptzone' });
    await flush();
    expect(result()).to.match(/^waiting: 1219 \(continue\) - \[cloud 600003\].*try 1\/15, next in 2 min$/);
    expect(adapter.timers[0].ms).to.equal(120000);
    await fire(adapter);
    expect(result()).to.match(/try 2\/15/);
    await fire(adapter);
    expect(client.sent).to.have.length(1);
    expect(result()).to.equal('sent: 1219 (continue), try 3');
  });

  it('does not send while index2 reports the mower offline', async () => {
    const client = fakeClient({ status: [{ vehicle_state: '0101', network_status: 0 }] });
    const { adapter, z, result } = zonesWith(client);
    z.handleRemote('zoneStart', { val: '1219' });
    await flush();
    expect(client.sent).to.have.length(0);
    expect(result()).to.match(/^waiting: .*mower offline \(network_status 0\)/);
    await fire(adapter);
    expect(client.sent).to.have.length(1);
  });

  it('retries network errors, also from the status read', async () => {
    const client = fakeClient({ status: [new AppApiError('network', 'network', 'host: ETIMEDOUT')] });
    const { adapter, z, result } = zonesWith(client);
    z.handleRemote('zoneStart', { val: '1219' });
    await flush();
    expect(result()).to.match(/^waiting: .*ETIMEDOUT/);
    await fire(adapter);
    expect(result()).to.equal('sent: 1219 (continue), try 2');
  });

  it('gives up after 15 tries', async () => {
    const client = fakeClient({ send: Array.from({ length: 15 }, offline) });
    const { adapter, z, result } = zonesWith(client);
    z.handleRemote('zoneStart', { val: '1219' });
    await flush();
    for (let i = 0; i < 14; i++) await fire(adapter);
    expect(result()).to.match(/^failed: 1219 \(continue\) - gave up after 15 tries/);
    expect(adapter.timers.filter((t) => !t.cleared)).to.have.length(0);
    expect(client.sent).to.have.length(0);
  });

  it('lets a new write replace a waiting start', async () => {
    const client = fakeClient({ send: [offline()] });
    const { adapter, z, result } = zonesWith(client);
    adapter.states['SN1.remote.zoneReset'] = false;
    z.handleRemote('zoneStart', { val: '1219' });
    await flush();
    const first = adapter.timers[0];
    z.handleRemote('zoneStart', { val: '{"zones":[1219],"reset":true}' });
    await flush();
    expect(first.cleared).to.equal(true);
    expect(client.sent).to.deep.equal([{ ids: [1219], reset: true, ordered: false }]);
    expect(result()).to.equal('sent: 1219 (from the start)');
  });

  it('does not retry a refusal (5001), a blocked mower or an auth error', async () => {
    for (const [script, pattern] of [
      [{ send: [new AppApiError('cloud', 5001, 'busy')] }, /^failed: .*5001/],
      [{ status: [{ vehicle_state: '0302', network_status: 1 }] }, /^failed: .*state 0302/],
      [{ send: [new AppApiAuthError('cloud', 1005, 'other device')] }, /^failed: .*1005/],
    ]) {
      const { adapter, z, result } = zonesWith(fakeClient(/** @type {any} */ (script)));
      z.handleRemote('zoneStart', { val: '1219' });
      await flush();
      expect(result()).to.match(/** @type {RegExp} */ (pattern));
      expect(adapter.timers).to.have.length(0);
    }
  });

  it('cancels a waiting start on stop', async () => {
    const { adapter, z } = zonesWith(fakeClient({ send: [offline()] }));
    z.handleRemote('zoneStart', { val: '1219' });
    await flush();
    z.stop();
    expect(adapter.timers[0].cleared).to.equal(true);
  });

  it('reports an unknown zone name without sending', async () => {
    const client = fakeClient({});
    const { z, result } = zonesWith(client);
    z.handleRemote('zoneStart', { val: 'Garage' });
    await flush();
    expect(client.sent).to.have.length(0);
    expect(result()).to.equal('failed: zone name "Garage" is unknown');
  });
});
