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
 */

const {
  AppApiClient,
  AppApiError,
  AppApiAuthError,
  CODE_REFUSED,
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
    if (!this.running || this.disabledUntilRestart || !this.client) {
      this.adapter.log.warn('remote.zoneStart written but app zone control is not running.');
      return true;
    }
    // Not awaited: onStateChange is synchronous. Errors are logged inside.
    this.startZones(state && state.val).catch((error) =>
      this.adapter.log.error(`Zone start failed: ${this.describe(error)}`),
    );
    return true;
  }

  /**
   * Parses the zoneStart value, resolves names to ids, checks the state and sends the command.
   *
   * @param {any} value the written value: ids/names string, or JSON {zones, reset}
   * @returns {Promise<void>}
   */
  async startZones(value) {
    const client = this.client;
    if (!client) return;
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
          this.adapter.log.error(
            `remote.zoneStart: zone name "${token}" ${match.length ? 'is ambiguous' : 'is unknown'}.`,
          );
          return;
        }
        id = match[0].id;
      }
      if (!(id >= 1 && id <= 0xffff)) {
        this.adapter.log.error(`remote.zoneStart: zone id ${id} out of range 1..65535.`);
        return;
      }
      /** @type {number} */
      const zoneId = id;
      if (known.length && !known.some((z) => z.id === zoneId)) {
        this.adapter.log.error(
          `remote.zoneStart: zone ${zoneId} is not on the map (known: ${known.map((z) => z.id).join(', ')}).`,
        );
        return;
      }
      if (!ids.includes(zoneId)) ids.push(zoneId);
    }

    const status = await client.status(this.sn);
    const stateCode = String(status.vehicle_state || '');
    const errors = Array.isArray(status.error_data) ? status.error_data : [];
    if (errors.length || BLOCKING_STATES.has(stateCode)) {
      const first = errors[0] || {};
      this.adapter.log.error(
        `remote.zoneStart not sent: the mower reports a problem (state ${stateCode}${first.error_code ? `, error ${first.error_code}` : ''}). Clear it and try again.`,
      );
      return;
    }

    let reset = wantedReset;
    if (reset === null) {
      const resetState = await this.adapter.getStateAsync(this.deviceId + '.remote.zoneReset');
      reset = !!(resetState && resetState.val);
    }
    const model = status.subType || '';
    const ordered = false; // the first H generation (incl. H3000) picks the order itself
    if (!isH1Generation(model, status.vehicle_type)) {
      this.adapter.log.debug(
        `Mower ${model || '?'} may support a zone order; sending "free order" anyway (matches the tested behaviour).`,
      );
    }
    try {
      const cmdNum = await client.startZones(this.sn, ids, { reset, ordered });
      this.adapter.log.info(
        `Zone start sent: ${ids.join(', ')} (${reset ? 'from the start' : 'continue'})${cmdNum ? `, cmd ${cmdNum}` : ''}.`,
      );
      // Read back soon so the states follow the mower leaving the dock.
      this.schedule(5000);
    } catch (error) {
      if (error instanceof AppApiError && Number(error.code) === CODE_REFUSED) {
        this.adapter.log.warn(
          'Zone start refused by the mower (5001) - it is usually busy; try again when it is docked.',
        );
        return;
      }
      throw error;
    }
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
   * Stops the feature: cancels the timer. Called from onUnload.
   */
  stop() {
    this.stopped = true;
    this.running = false;
    this.pollTimer && this.adapter.clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }
}

module.exports = { AppZones };
