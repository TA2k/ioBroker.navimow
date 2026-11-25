'use strict';

/*
 * Zone control through the Navimow app cloud (the unofficial API in lib/appApi.js).
 *
 * The official Smart Home API this adapter is built on cannot start a single zone or report the
 * progress per zone. This optional module adds that, for people who want it and accept an
 * unofficial API: it logs in to the app cloud with its own account, reads the zones and their
 * progress, and starts the zones the user asks for. It is self-contained - main.js only starts it,
 * forwards two remote writes to it and stops it - so the adapter runs exactly as before when the
 * feature is off, and a failure in here never touches the official connection or info.connection.
 *
 * Objects created under each mower device (only while the feature is on):
 *   appStatus.appConnection  boolean  the app-cloud connection (separate from info.connection)
 *   appStatus.stateCode      string   the app-cloud state code (0101 docked, 0210 mowing, ...)
 *   appStatus.lastUpdate     number   when the zone data was last read
 *   zones.<id>.name          string   zone name from the map
 *   zones.<id>.area          number   zone area (m2)
 *   zones.<id>.coverage      number   progress of the zone (%, vendor value)
 *   zones.<id>.selected      boolean  zone is part of the current/last task
 *   zones.<id>.active        boolean  zone is being mowed right now
 *   remote.zoneStart         string   write zone ids/names or {"zones":[..],"reset":false} to start
 *   remote.zoneReset         boolean  default false = continue; read by zoneStart when it gets no reset
 *   remote.zoneStartResult   string   outcome of the last zoneStart: "sent: …", "waiting: …" or "failed: …"
 */

const {
  AppApiClient,
  AppApiError,
  AppApiAuthError,
  CODE_REFUSED,
  CODE_MOWER_OFFLINE,
  isH1Generation,
  decodePartitionIdList,
  newDeviceId,
} = require('./appApi');

const SESSION_STATE = 'auth.appSession';
// Idle and active poll cadence. The app itself polls index2 about every 15 s while mowing.
const IDLE_POLL_MS = 60 * 1000;
const ACTIVE_POLL_MS = 20 * 1000;
// Map and zone names change rarely; the map detail is only re-read this often.
const MAP_TTL_MS = 60 * 60 * 1000;
const ACTIVE_STATES = new Set(['0210', '0212', '0220']); // mowing, manual mowing, returning
// States in which a zone start is not sent: a reported error, lifted (0302), stuck (0301).
const BLOCKING_STATES = new Set(['0301', '0302']);
// A zone start that fails for a passing reason (mower offline at the cloud, network) is sent again
// this often, at most this many times in all: 15 tries 2 min apart cover about 30 minutes.
const START_RETRY_MS = 2 * 60 * 1000;
const START_MAX_ATTEMPTS = 15;

class AppZones {
  /**
   * @param {any} adapter the ioBroker adapter instance
   */
  constructor(adapter) {
    this.adapter = adapter;
    /** @type {InstanceType<typeof import('./appApi').AppApiClient>|null} */
    this.client = null;
    /** @type {string} */
    this.sn = '';
    /** @type {string} the device id in the object tree (navimow.0.<id>) */
    this.deviceId = '';
    this.pollTimer = null;
    /** pending zone-start retry */
    this.startTimer = null;
    /** bumped by every zoneStart write; a retry of an older write sees the change and drops out */
    this.startSeq = 0;
    this.running = false;
    this.stopped = false;
    /** @type {{at: number, map: any, zones: any[]}|null} map cache */
    this.mapCache = null;
    this.knownZoneIds = new Set();
    this.busy = false;
    // After the credentials are refused there is no point trying again until the settings change.
    this.disabledUntilRestart = false;
  }

  /**
   * @returns {{email: string, password: string}|null} the configured login, or null
   */
  credentials() {
    const email = String(this.adapter.config.appEmail || '').trim();
    const password = String(this.adapter.config.appPassword || '');
    return email && password ? { email, password } : null;
  }

  /**
   * Starts the feature: restores the session, creates the base objects and begins polling. Called
   * from onReady only when appEnabled is set and a mower is known. Never throws into onReady.
   *
   * @param {string} deviceId the mower's id in the object tree (its serial number)
   * @returns {Promise<void>}
   */
  async start(deviceId) {
    try {
      if (!this.credentials()) {
        this.adapter.log.info('App zone control is on but no app e-mail/password is set - skipping it.');
        return;
      }
      this.deviceId = deviceId;
      this.sn = deviceId; // the object id is the serial number, which the app API also uses
      const session = await this.loadSession();
      this.client = new AppApiClient({
        session,
        credentials: () => this.credentials(),
        log: this.adapter.log,
        onSessionChange: (snap) => this.saveSession(snap),
      });
      await this.createBaseObjects();
      this.running = true;
      this.adapter.log.info('App zone control active (unofficial API).');
      await this.poll('startup');
    } catch (error) {
      this.adapter.log.warn(`App zone control could not start: ${this.describe(error)}`);
    }
  }

  /**
   * The persisted session, or a fresh one. The device id is kept for good once made: a new one
   * registers a new client with the cloud and can push the app's own session out.
   *
   * @returns {Promise<{deviceId: string, tokens: object, uid: string, host: string}>}
   */
  async loadSession() {
    try {
      const state = await this.adapter.getStateAsync(SESSION_STATE);
      if (state && state.val) {
        const parsed = JSON.parse(String(state.val));
        if (parsed && /^[0-9a-f]{32}$/.test(parsed.deviceId || '')) return parsed;
      }
    } catch (error) {
      this.adapter.log.debug(`App session not restored: ${error.message}`);
    }
    return {
      deviceId: newDeviceId(),
      tokens: { access_token: '', refresh_token: '', uuid: '', region: '' },
      uid: '',
      host: '',
    };
  }

  /**
   * @param {object} snapshot the session to store (holds tokens - encrypted/protected in io-package)
   */
  saveSession(snapshot) {
    this.adapter.setState(SESSION_STATE, JSON.stringify(snapshot), true);
  }

  /**
   * Creates the objects that exist regardless of the zones: the session store, the app status
   * channel and the two remote commands.
   *
   * @returns {Promise<void>}
   */
  async createBaseObjects() {
    const a = this.adapter;
    await a.setObjectNotExistsAsync(SESSION_STATE, {
      type: 'state',
      common: { name: 'App session (tokens, kept internally)', type: 'string', role: 'json', read: true, write: false },
      native: {},
    });
    const id = this.deviceId;
    await a.setObjectNotExistsAsync(id + '.appStatus', {
      type: 'channel',
      common: { name: 'App cloud status (zones)' },
      native: {},
    });
    await a.setObjectNotExistsAsync(id + '.appStatus.appConnection', {
      type: 'state',
      common: {
        name: 'App cloud connected',
        type: 'boolean',
        role: 'indicator.connected',
        read: true,
        write: false,
        def: false,
      },
      native: {},
    });
    await a.setObjectNotExistsAsync(id + '.appStatus.stateCode', {
      type: 'state',
      common: { name: 'App cloud state code', type: 'string', role: 'text', read: true, write: false },
      native: {},
    });
    await a.setObjectNotExistsAsync(id + '.appStatus.lastUpdate', {
      type: 'state',
      common: { name: 'App zone data last updated', type: 'number', role: 'date', read: true, write: false },
      native: {},
    });
    await a.setObjectNotExistsAsync(id + '.zones', { type: 'channel', common: { name: 'Mowing zones' }, native: {} });
    await a.setObjectNotExistsAsync(id + '.remote.zoneStart', {
      type: 'state',
      common: {
        name: 'Start zones (ids/names, comma-separated, or JSON {"zones":[..],"reset":false})',
        type: 'string',
        role: 'text',
        read: false,
        write: true,
      },
      native: {},
    });
    await a.setObjectNotExistsAsync(id + '.remote.zoneReset', {
      type: 'state',
      common: {
        name: 'Zone start resets progress (false = continue where it stopped)',
        type: 'boolean',
        role: 'switch',
        read: true,
        write: true,
        def: false,
      },
      native: {},
    });
    await a.setObjectNotExistsAsync(id + '.remote.zoneStartResult', {
      type: 'state',
      common: {
        name: 'Outcome of the last zone start (sent / waiting / failed)',
        type: 'string',
        role: 'text',
        read: true,
        write: false,
      },
      native: {},
    });
  }

  /**
   * @param {boolean} connected the new connection state
   */
  setConnection(connected) {
    this.adapter.setState(this.deviceId + '.appStatus.appConnection', !!connected, true);
  }

  /**
   * Arms the next poll. A failure disarms nothing: the next poll is the retry.
   *
   * @param {number} ms delay
   */
  schedule(ms) {
    if (this.stopped || this.disabledUntilRestart) return;
    this.pollTimer && this.adapter.clearTimeout(this.pollTimer);
    this.pollTimer = this.adapter.setTimeout(() => this.poll('interval'), ms);
  }

  /**
   * One read cycle: status, zones, progress -> objects. Isolated from everything else; on an
   * auth failure that proves the credentials wrong it stops until the settings change.
   *
   * @param {string} reason for the log
   * @returns {Promise<void>}
   */
  async poll(reason) {
    if (this.stopped || !this.client || this.busy) return;
    this.busy = true;
    let stateCode = '';
    try {
      const status = await this.client.status(this.sn);
      stateCode = String(status.vehicle_state || '');
      const map = await this.readMap();
      const progress = await this.client.progress(this.sn).catch((error) => {
        if (error instanceof AppApiAuthError) throw error;
        this.adapter.log.debug(`App progress read failed: ${this.describe(error)}`);
        return [];
      });
      await this.writeZones(status, map, progress);
      await this.adapter.setStateAsync(this.deviceId + '.appStatus.stateCode', stateCode, true);
      await this.adapter.setStateAsync(this.deviceId + '.appStatus.lastUpdate', Date.now(), true);
      this.setConnection(true);
      if (reason === 'startup') this.adapter.log.debug('App zone data read for the first time.');
    } catch (error) {
      this.setConnection(false);
      if (
        error instanceof AppApiAuthError &&
        (error.fatal || error.code === 'no_credentials' || error.code === 'reauth_loop')
      ) {
        this.disabledUntilRestart = true;
        this.adapter.log.error(
          `App zone control stopped: ${this.describe(error)}. It stays off until the adapter restarts; check the app e-mail/password in the settings.`,
        );
        return;
      }
      this.adapter.log.warn(`App zone poll failed (${reason}): ${this.describe(error)}`);
    } finally {
      this.busy = false;
    }
    this.schedule(ACTIVE_STATES.has(stateCode) ? ACTIVE_POLL_MS : IDLE_POLL_MS);
  }

  /**
   * The map and its zones, re-read only past the TTL (names/areas barely change).
   *
   * @returns {Promise<{map: any, zones: any[]}>} the cached or freshly read map; zones may be []
   */
  async readMap() {
    if (this.mapCache && Date.now() - this.mapCache.at < MAP_TTL_MS) return this.mapCache;
    const client = this.client;
    if (!client) return this.mapCache || { at: Date.now(), map: null, zones: [] };
    try {
      const map = await client.currentMap(this.sn);
      const zones = map ? (await client.zones(this.sn, map)) || [] : [];
      this.mapCache = { at: Date.now(), map, zones };
    } catch (error) {
      if (error instanceof AppApiAuthError) throw error;
      this.adapter.log.debug(`App map read failed: ${this.describe(error)}`);
      this.mapCache = this.mapCache || { at: Date.now(), map: null, zones: [] };
    }
    return this.mapCache;
  }

  /**
   * Writes the per-zone objects. The zone set comes from the map; progress fills coverage, and
   * partitionIdList marks which zones belong to the current task.
   *
   * @param {any} status index2
   * @param {{zones: any[]}} map the map cache
   * @param {any[]} progress get-path-info-time
   * @returns {Promise<void>}
   */
  async writeZones(status, map, progress) {
    const stateCode = String(status.vehicle_state || '');
    const selected = new Set(decodePartitionIdList(status.partitionIdList));
    const byId = new Map();
    for (const zone of map.zones || [])
      byId.set(zone.id, { id: zone.id, name: zone.name, area: zone.area, coverage: null });
    for (const row of progress) {
      const zid = Number(row?.partitionId);
      if (!Number.isFinite(zid)) continue;
      const entry = byId.get(zid) || { id: zid, name: `Zone ${zid}`, area: Number(row.area) || null, coverage: null };
      entry.coverage = Number(row.partitionPercentage);
      if (entry.area == null && Number.isFinite(Number(row.area))) entry.area = Number(row.area);
      byId.set(zid, entry);
    }
    // While mowing exactly one zone is named by the task, that one counts as active. The app shows
    // the same: the mower picks the order, so only the zone currently under the blades is active.
    const activeId = ACTIVE_STATES.has(stateCode) && selected.size === 1 ? [...selected][0] : null;
    for (const zone of [...byId.values()].sort((x, y) => x.id - y.id)) {
      await this.ensureZoneObjects(zone.id);
      const base = `${this.deviceId}.zones.${zone.id}`;
      await this.adapter.setStateAsync(`${base}.name`, zone.name, true);
      await this.adapter.setStateAsync(`${base}.area`, zone.area == null ? null : Number(zone.area), true);
      await this.adapter.setStateAsync(`${base}.coverage`, zone.coverage == null ? null : Number(zone.coverage), true);
      await this.adapter.setStateAsync(`${base}.selected`, selected.has(zone.id), true);
      await this.adapter.setStateAsync(`${base}.active`, zone.id === activeId, true);
    }
  }

  /**
   * Creates the five objects of one zone, once.
   *
   * @param {number} zoneId the zone id
   * @returns {Promise<void>}
   */
  async ensureZoneObjects(zoneId) {
    if (this.knownZoneIds.has(zoneId)) return;
    this.knownZoneIds.add(zoneId);
    const a = this.adapter;
    const base = `${this.deviceId}.zones.${zoneId}`;
    await a.setObjectNotExistsAsync(base, { type: 'channel', common: { name: `Zone ${zoneId}` }, native: {} });
    const defs = [
      ['name', { name: 'Zone name', type: 'string', role: 'text', read: true, write: false }],
      ['area', { name: 'Zone area', type: 'number', role: 'value', unit: 'm²', read: true, write: false }],
      ['coverage', { name: 'Zone progress', type: 'number', role: 'value', unit: '%', read: true, write: false }],
      ['selected', { name: 'Zone in current task', type: 'boolean', role: 'indicator', read: true, write: false }],
      ['active', { name: 'Zone being mowed now', type: 'boolean', role: 'indicator', read: true, write: false }],
    ];
    for (const [key, common] of defs) {
      await a.setObjectNotExistsAsync(`${base}.${key}`, { type: 'state', common, native: {} });
    }
  }

  /**
   * Handles a write to remote.zoneStart or remote.zoneReset. Called from onStateChange for the
   * remote channel; returns false when the command is not one of ours, so main.js carries on.
   *
   * @param {string} command the last id segment, e.g. 'zoneStart'
   * @param {any} state the ioBroker state object
   * @returns {boolean} true if this module handled it
   */
  handleRemote(command, state) {
    if (command === 'zoneReset') return true; // a stored flag zoneStart reads; nothing to do on write
    if (command !== 'zoneStart') return false;
    // A new write replaces a start that is still waiting for its next try.
    this.cancelStartRetry();
    const seq = ++this.startSeq;
    if (!this.running || this.disabledUntilRestart || !this.client) {
      this.adapter.log.warn('remote.zoneStart written but app zone control is not running.');
      this.setStartResult('failed: app zone control is not running');
      return true;
    }
    // Not awaited: onStateChange is synchronous. Errors are logged inside.
    this.startZones(state && state.val, seq).catch((error) => {
      this.adapter.log.error(`Zone start failed: ${this.describe(error)}`);
      this.setStartResult(`failed: ${this.describe(error)}`);
    });
    return true;
  }

  /**
   * @param {string} text the outcome for remote.zoneStartResult
   */
  setStartResult(text) {
    if (!this.deviceId) return;
    this.adapter.setState(this.deviceId + '.remote.zoneStartResult', text, true);
  }

  cancelStartRetry() {
    this.startTimer && this.adapter.clearTimeout(this.startTimer);
    this.startTimer = null;
  }

  /**
   * Parses the zoneStart value and resolves names to ids, then makes the first try.
   *
   * @param {any} value the written value: ids/names string, or JSON {zones, reset}
   * @param {number} seq the startSeq of this write
   * @returns {Promise<void>}
   */
  async startZones(value, seq) {
    /** @type {boolean|null} */
    let wantedReset = null;
    let spec = value;
    if (typeof value === 'string' && value.trim().startsWith('{')) {
      const parsed = JSON.parse(value);
      spec = parsed.zones;
      if (typeof parsed.reset === 'boolean') wantedReset = parsed.reset;
    }
    const tokens = (Array.isArray(spec) ? spec : String(spec ?? '').split(','))
      .map((t) => String(t).trim())
      .filter(Boolean);
    if (!tokens.length) {
      this.adapter.log.warn('remote.zoneStart: no zones given.');
      this.setStartResult('failed: no zones given');
      return;
    }
    const known = (this.mapCache && this.mapCache.zones) || [];
    const ids = [];
    for (const token of tokens) {
      /** @type {number} */
      let id;
      if (/^\d+$/.test(token)) id = Number(token);
      else {
        const match = known.filter((z) => z.name.toLowerCase() === token.toLowerCase());
        if (match.length !== 1) {
          const why = `zone name "${token}" ${match.length ? 'is ambiguous' : 'is unknown'}`;
          this.adapter.log.error(`remote.zoneStart: ${why}.`);
          this.setStartResult(`failed: ${why}`);
          return;
        }
        id = match[0].id;
      }
      if (!(id >= 1 && id <= 0xffff)) {
        this.adapter.log.error(`remote.zoneStart: zone id ${id} out of range 1..65535.`);
        this.setStartResult(`failed: zone id ${id} out of range`);
        return;
      }
      /** @type {number} */
      const zoneId = id;
      if (known.length && !known.some((z) => z.id === zoneId)) {
        this.adapter.log.error(
          `remote.zoneStart: zone ${zoneId} is not on the map (known: ${known.map((z) => z.id).join(', ')}).`,
        );
        this.setStartResult(`failed: zone ${zoneId} is not on the map`);
        return;
      }
      if (!ids.includes(zoneId)) ids.push(zoneId);
    }

    // The reset flag is read once, at the write: a retry sends what was asked for then.
    let reset = wantedReset;
    if (reset === null) {
      const resetState = await this.adapter.getStateAsync(this.deviceId + '.remote.zoneReset');
      reset = !!(resetState && resetState.val);
    }
    await this.tryStart({ ids, reset, seq }, 1);
  }

  /**
   * One try of a zone start: checks the mower, sends the command, and on a passing failure
   * (mower offline at the cloud, network) arms the next try.
   *
   * @param {{ids: number[], reset: boolean, seq: number}} job what to start
   * @param {number} attempt 1-based number of this try
   * @returns {Promise<void>}
   */
  async tryStart(job, attempt) {
    if (this.stopped || job.seq !== this.startSeq) return; // replaced by a newer write, or shut down
    const what = `${job.ids.join(', ')} (${job.reset ? 'from the start' : 'continue'})`;
    const client = this.client;
    if (!client || this.disabledUntilRestart) {
      this.setStartResult(`failed: ${what} - app zone control is not running`);
      return;
    }
    try {
      const status = await client.status(this.sn);
      if (job.seq !== this.startSeq) return;
      const stateCode = String(status.vehicle_state || '');
      const errors = Array.isArray(status.error_data) ? status.error_data : [];
      if (errors.length || BLOCKING_STATES.has(stateCode)) {
        const first = errors[0] || {};
        const why = `the mower reports a problem (state ${stateCode}${first.error_code ? `, error ${first.error_code}` : ''})`;
        this.adapter.log.error(`remote.zoneStart not sent: ${why}. Clear it and try again.`);
        this.setStartResult(`failed: ${what} - ${why}`);
        return;
      }
      // index2 reports network_status 1 while the mower is online. Anything else known means offline;
      // missing means unknown, and then the command is simply sent.
      const net = status.network_status;
      if (net !== undefined && net !== null && net !== '' && Number(net) !== 1) {
        this.retryStart(job, attempt, `mower offline (network_status ${net})`);
        return;
      }
      const model = status.subType || '';
      const ordered = false; // the first H generation (incl. H3000) picks the order itself
      if (!isH1Generation(model, status.vehicle_type)) {
        this.adapter.log.debug(
          `Mower ${model || '?'} may support a zone order; sending "free order" anyway (matches the tested behaviour).`,
        );
      }
      const cmdNum = await client.startZones(this.sn, job.ids, { reset: job.reset, ordered });
      this.adapter.log.info(
        `Zone start sent: ${what}${cmdNum ? `, cmd ${cmdNum}` : ''}${attempt > 1 ? ` (try ${attempt})` : ''}.`,
      );
      this.setStartResult(`sent: ${what}${attempt > 1 ? `, try ${attempt}` : ''}`);
      // Read back soon so the states follow the mower leaving the dock.
      this.schedule(5000);
    } catch (error) {
      if (error instanceof AppApiError && Number(error.code) === CODE_REFUSED) {
        this.adapter.log.warn(
          'Zone start refused by the mower (5001) - it is usually busy; try again when it is docked.',
        );
        this.setStartResult(`failed: ${what} - refused by the mower (5001), it is usually busy`);
        return;
      }
      if (this.isPassing(error)) {
        this.retryStart(job, attempt, this.describe(error));
        return;
      }
      throw error;
    }
  }

  /**
   * @param {any} error anything thrown by a try
   * @returns {boolean} true for failures worth another try later: mower offline, network trouble
   */
  isPassing(error) {
    if (!(error instanceof AppApiError) || error instanceof AppApiAuthError) return false;
    return error.kind === 'network' || Number(error.code) === CODE_MOWER_OFFLINE;
  }

  /**
   * Arms the next try of a zone start, or gives up after START_MAX_ATTEMPTS.
   *
   * @param {{ids: number[], reset: boolean, seq: number}} job what to start
   * @param {number} attempt the try that just failed
   * @param {string} why short reason for the log and the result state
   */
  retryStart(job, attempt, why) {
    const what = `${job.ids.join(', ')} (${job.reset ? 'from the start' : 'continue'})`;
    if (attempt >= START_MAX_ATTEMPTS) {
      this.adapter.log.error(`Zone start ${what} given up after ${attempt} tries: ${why}`);
      this.setStartResult(`failed: ${what} - gave up after ${attempt} tries: ${why}`);
      return;
    }
    const mins = Math.round(START_RETRY_MS / 60000);
    this.adapter.log.warn(
      `Zone start ${what} not sent (try ${attempt}/${START_MAX_ATTEMPTS}): ${why} - trying again in ${mins} min.`,
    );
    this.setStartResult(`waiting: ${what} - ${why}, try ${attempt}/${START_MAX_ATTEMPTS}, next in ${mins} min`);
    this.cancelStartRetry();
    this.startTimer = this.adapter.setTimeout(() => {
      this.startTimer = null;
      this.tryStart(job, attempt + 1).catch((error) => {
        this.adapter.log.error(`Zone start failed: ${this.describe(error)}`);
        this.setStartResult(`failed: ${what} - ${this.describe(error)}`);
      });
    }, START_RETRY_MS);
  }

  /**
   * @param {any} error anything thrown
   * @returns {string} a short, secret-free description for the log
   */
  describe(error) {
    if (error instanceof AppApiError) return `[${error.kind} ${error.code}] ${error.desc}`;
    return error && error.message ? error.message : String(error);
  }

  /**
   * Stops the feature: cancels the timers. Called from onUnload.
   */
  stop() {
    this.stopped = true;
    this.running = false;
    this.pollTimer && this.adapter.clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.cancelStartRetry();
  }
}

module.exports = { AppZones };
