'use strict';

const utils = require('@iobroker/adapter-core');
const axios = require('axios');
const Json2iob = require('json2iob');
const crypto = require('node:crypto');
const mqtt = require('mqtt');
const { URL } = require('node:url');
const descriptions = require('./lib/descriptions.json');
const states = require('./lib/states.json');

const API_BASE_URL = 'https://navimow-fra.ninebot.com';
const OAUTH2_TOKEN_URL = API_BASE_URL + '/openapi/oauth/getAccessToken';
const CLIENT_ID = 'homeassistant';
const CLIENT_SECRET = '57056e15-722e-42be-bbaa-b0cbfb208a52';
const REDIRECT_URI = 'http://localhost:1/callback';


// Location MQTT watchdog
const LOCATION_STALE_MS = 3 * 60 * 1000;
const LOCATION_RECOVERY_COOLDOWN_MS = 5 * 60 * 1000;

// MQTT-only mode (interval=0): the broker only pushes the state channel while the
// mower is moving. Docked and charging it stays silent, so battery and vehicleState
// keep their last values for hours. Fall back to a single HTTP poll once the state
// channel has been quiet for this long.
const STATUS_STALE_MS = 15 * 60 * 1000;
const STATUS_STALE_CHECK_MS = 60 * 1000;
// A day, the same ceiling the admin UI offers. Beyond about 24.8 days a delay overflows
// what setTimeout takes and fires immediately instead.
const MAX_INTERVAL_MINUTES = 24 * 60;
const ACTIVE_LOCATION_STATES = new Set(['isRunning', 'mowing', 'isMowing', 'isMapping', 'mapping']);

// How long the MQTT state channel keeps the mower state to itself after it last spoke.
// Comfortably more than the minute or two getVehicleStatus runs behind, so a poll landing
// in between cannot put an older state back on display.
const STATE_CHANNEL_TRUST_MS = 3 * 60 * 1000;

// How long a connect attempt that never succeeded waits before it is worth fetching MQTT
// credentials again. Long enough that a broker refusing connections cannot turn into a stream
// of OAuth calls, short enough that an adapter started on an expired token recovers by itself
// rather than retrying for ever on credentials that cannot work.
const MQTT_CREDENTIAL_REFRESH_MIN_MS = 10 * 60 * 1000;

// How long a failed token refresh waits before trying again, growing with the number of
// failures behind it. The first is soon, because a refresh window missed over a short network
// outage is the common case; the last is an hour, because a refresh token that has really
// expired needs a re-login and nothing here will change that.
const TOKEN_REFRESH_RETRY_MS = [60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000, 60 * 60 * 1000];

// States that end a mowing session. Only used as a fallback for mowers that never report a
// mowing progress with their positions - where they do, the progress decides, because a mower
// that docks halfway through to charge and drives back out is indistinguishable from one
// starting fresh by its state alone. Only states the mower has actually arrived in count:
// isDocking/returning and a short isIdle can still go back to isRunning within the same
// session (cancelled dock, pause, recovery), and clearing the map there would throw away the
// track of a session that is still running. isPaused, isLifted, Error and Offline are
// interruptions for the same reason, so resuming out of them keeps the track collected so far.
const SESSION_END_STATES = new Set(['isDocked', 'docked', 'charging']);

// How long the mowing progress has to say what a mower leaving the dock is doing. It keeps
// reporting the progress of the session before for about a minute, so the answer is waited
// for rather than guessed - but not for ever, or a start never answered would spare every
// position driven since it from the next reset.
const SESSION_START_GRACE_MS = 5 * 60 * 1000;

// How far the mowed area has to fall before it counts as a new session rather than the mower
// correcting what it thinks it has covered. Unlike the progress, which moves in whole percent
// and cannot jitter, the area is a computed value with two decimals, and without a threshold a
// single tick the wrong way would wipe a track mid-session. A session that starts over drops by
// everything it mowed, and a percent of a lawn is several square metres, so a metre sits far
// below the signal and far above the noise. A session that ended below it is one the progress
// still catches - and one whose track is a few positions long.
const MOWED_AREA_RESTART_DROP_M2 = 1;

// How many status polls in a row have to come back empty-handed before the adapter calls
// itself disconnected. On the default five-minute interval that is a quarter of an hour of
// readings the mower never sent - long past a cloud hiccup, and long enough that whatever the
// states still say about the mower is out of date.
const POLL_FAILURES_UNTIL_ERROR = 3;

// A location reading dated this far ahead of the host clock does not become the newest one
// seen. Only a wrong clock produces one, and letting it set the mark would lock every real
// reading after it out - so the guard steps aside instead, and a mower running minutes ahead
// of its host simply gets the behaviour of before.
const LOCATION_TIME_AHEAD_MAX_MS = 5 * 60 * 1000;

// How often at most the mowing track is written to its state while the mower is out.
const MAP_TRACK_SAVE_MS = 30 * 1000;

// Mowing map: the longer edge of the rendered image in pixels. The shorter edge follows from
// the shape of the frame, because the image covers exactly the frame and nothing besides.
const MAP_SIZE_PX = 800;
// The frame is widened this far past the point that triggered it and snapped to whole metres,
// so it jumps ahead of the mower and settles instead of nudging on every location message.
const MAP_FRAME_MARGIN_M = 2;
// How often at most the map is drawn while positions keep arriving, in seconds, and the range
// the setting may move it in. The mower reports every couple of seconds and a render of a
// session-length track costs about 80 ms of blocked event loop plus a 65 KiB state write - the
// same loop that takes the MQTT messages, so drawing every position taxes the data the map is
// made of. Where that cost lands is a matter of garden and hardware, which is why it can be
// set: at three seconds the picture is at most a metre and a half behind at half a metre per
// second, a Pi with a large lawn is better off higher, and a map watched live is smoothest at
// the two seconds the positions themselves arrive in. The renders that matter - a docking, a
// reset, a station moved by hand - go straight through without waiting either way.
const MAP_RENDER_DEFAULT_S = 3;
const MAP_RENDER_MIN_S = 1;
const MAP_RENDER_MAX_S = 30;
// A mower drives well under a metre per second and reports its position every couple of
// seconds, so a step this large is not driving. It is either a stray position, or the mower
// really is somewhere else - the next message decides which.
const LOCATION_JUMP_MAX_M = 10;

// How many positions a mowing track may hold. Reached, the track is thinned rather than cut
// off at the front: a mower rated for 1200 m2 sends more positions in one session than any
// budget worth keeping in a state, and losing the beginning of the session is exactly what
// the map is there to show.
const MAP_TRACK_MAX_POINTS = 10000;

// A position older than this is not used to locate the charging station: the mower may have
// been docked for hours, and the last thing it reported would then be where it was mowing.
const DOCK_POSITION_MAX_AGE_MS = 2 * 60 * 1000;
// How far a position may sit off the straight line between its neighbours before it is worth
// keeping. The mower drives long straight lanes and reports every two seconds, so most of what
// it sends lies on a line already drawn: at 2 cm half the positions of a recorded session went
// and the track moved by at most 1.1 px of an 800 px map, under a line 1.5 px wide.
//
// ponytail: the check only looks at the position before last, not at the ones already dropped,
// so the error can creep on a long slow curve - measured 1.1 px at 2 cm but 154 px at 10 cm.
// Doubling this constant is therefore not free. Douglas-Peucker over the whole track holds the
// error at any tolerance and is the upgrade if the budget ever has to come down much further.
const MAP_TRACK_MIN_DEVIATION_M = 0.02;

// Command mapping: name -> { command, params }
const COMMAND_MAP = {
  start: { command: 'action.devices.commands.StartStop', params: { on: true } },
  stop: { command: 'action.devices.commands.StartStop', params: { on: false } },
  pause: { command: 'action.devices.commands.PauseUnpause', params: { on: false } },
  resume: { command: 'action.devices.commands.PauseUnpause', params: { on: true } },
  dock: { command: 'action.devices.commands.Dock', params: null },
};

/**
 * A position for the mowing track, carrying the mower's heading where it reported one.
 *
 * @param {number} x world position in metres
 * @param {number} y world position in metres
 * @param {unknown} postureTheta the heading as it arrived, in radians
 * @returns {{x:number,y:number,theta?:number}} the position to keep
 */
/** @type {{ createCanvas?: Function, error?: string } | null} */
let canvasModule = null;

/**
 * The canvas library, loaded on first use rather than with this file. It ships a native binary
 * and there is no prebuild for every platform an ioBroker runs on - armv6, so a Pi Zero or a
 * Pi 1, has none. Required at the top it took the whole adapter down with it on such a host:
 * no status, no remote control, over a picture. Now the map is what fails.
 *
 * The outcome is remembered either way, so a host without it does not attempt the require on
 * every render, and the warning is said once rather than every few seconds.
 *
 * @returns {{ createCanvas?: Function, error?: string }} the library, or why there is none
 */
function loadCanvas() {
  if (!canvasModule) {
    try {
      canvasModule = { createCanvas: require('@napi-rs/canvas').createCanvas };
    } catch (e) {
      canvasModule = { error: e instanceof Error ? e.message : String(e) };
    }
  }
  return canvasModule;
}

/**
 * A number, but only from something that was meant as one. `Number()` alone answers 0 for
 * null, for an empty string, for false and for an empty array, so a position missing half its
 * coordinates would silently land on an axis instead of being refused.
 *
 * @param {unknown} value what stood in the field
 * @returns {number} the number, or NaN if it was not one
 */
function strictNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return NaN;
}

/**
 * Read a world position out of a state value, which a user may have written by hand.
 *
 * @param {unknown} value the value as it stands in the state
 * @returns {{x:number,y:number}|null} the position, or null if it is not one
 */
function parsePosition(value) {
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const x = strictNumber(/** @type {any} */ (parsed).x);
  const y = strictNumber(/** @type {any} */ (parsed).y);
  // Infinity survives isNaN and would grow the frame past what a canvas can be sized to.
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function trackPoint(x, y, postureTheta) {
  const theta = strictNumber(postureTheta);
  return Number.isFinite(theta) ? { x, y, theta } : { x, y };
}

/**
 * What a failed API call is worth saying, in one line.
 *
 * The body used to be logged verbatim next to the message, and a gateway in front of the API
 * does not answer in JSON: the 502 of 2026-08-12 put nine lines of
 * `<html><head><title>502 Bad Gateway</title>...` into the log at error level, none of which
 * said more than the status code. A JSON body is worth keeping - it carries the API's own
 * reason - so it stays, capped at a length that cannot bury the rest of the log.
 *
 * @param {any} error the rejection axios threw
 * @returns {string} the status and what the body says, empty if there was no response at all
 */
function apiErrorDetail(error) {
  const response = error?.response;
  if (!response) return '';
  const data = response.data;
  let body = '';
  if (typeof data === 'string') {
    // An HTML error page says everything it has to say in its title.
    const title = data.match(/<title>([^<]*)<\/title>/i);
    body = (title ? title[1] : data).replace(/\s+/g, ' ').trim();
  } else if (data != null) {
    body = JSON.stringify(data);
  }
  if (body.length > 200) {
    body = body.slice(0, 200) + '...';
  }
  return `HTTP ${response.status}` + (body ? `: ${body}` : '');
}

/**
 * Whether a reading is the placeholder a standing mower sends instead of a measurement.
 *
 * A mower left standing reports exactly "0.0" in all three posture fields, every five minutes
 * (2026-08-12, overnight, and twice in a full day's log of 2026-08-10). It is not what a
 * standing mower measures: docked readings in that same log sit at (0.195, 0.062) facing
 * -2.833 rad, because the origin is the charging station but the mower never sits on it to the
 * millimetre. Over 7237 positions of that day, exactly those two carry a zero in postureX at
 * all. So three exact zeros are the mower saying nothing, not saying "here".
 *
 * Taken for a measurement it walks the marker the last few centimetres onto the origin and
 * turns it to face east - a mower that stood still all night looks like it turned round in the
 * dock overnight, which is what it was reported as.
 *
 * All three fields, because one is not enough: a position mowed at (-6.586, ...) in the same
 * log reports a heading of exactly "0.0", and it is a real one. The numeric `vehicleState`
 * riding along is 1 on both placeholders and on nothing else in the log - but a mowing
 * position is a 4, a docked one a 2, and a 3 and a 5 also occur, so what the numbers mean is
 * guesswork past that. The zeros are the signal; the state is only logged, not trusted.
 *
 * @param {any} point one entry of the location payload
 * @returns {boolean} true if the reading says nothing about where the mower is
 */
function isPlaceholderPosture(point) {
  if (!point) return false;
  // All three, and all three exactly: a position that only happens to sit on an axis is a
  // position, and a firmware that sends no heading at all must not have every reading dropped.
  return strictNumber(point.postureX) === 0 && strictNumber(point.postureY) === 0 && strictNumber(point.postureTheta) === 0;
}

/**
 * How far `p` sits off the straight line from `a` to `b`.
 *
 * @param {{x:number,y:number}} a one end of the line
 * @param {{x:number,y:number}} b the other end
 * @param {{x:number,y:number}} p the position measured against it
 * @returns {number} the distance in metres
 */
function lineDeviation(a, b, p) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  // Both ends in the same spot: there is no line to measure against, so the distance to it is
  // simply the distance to that spot.
  if (length === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs(dx * (a.y - p.y) - (a.x - p.x) * dy) / length;
}

/**
 * Drop the positions of a track that lie on the line their neighbours already draw.
 *
 * @param {{x:number,y:number}[]} points the track
 * @param {number} tolerance how far off that line a position has to sit to be worth keeping
 * @returns {{x:number,y:number}[]} a new track holding the positions that matter
 */
function thinTrack(points, tolerance) {
  const kept = [];
  for (const p of points) {
    if (kept.length >= 2 && lineDeviation(kept[kept.length - 2], p, kept[kept.length - 1]) < tolerance) {
      kept[kept.length - 1] = p;
    } else {
      kept.push(p);
    }
  }
  return kept;
}

class Navimow extends utils.Adapter {
  constructor(options) {
    super({
      ...options,
      name: 'navimow',
    });
    this.on('ready', this.onReady.bind(this));
    this.on('stateChange', this.onStateChange.bind(this));
    this.on('unload', this.onUnload.bind(this));
    this.deviceArray = [];
    this.json2iob = new Json2iob(this);
    this.requestClient = axios.create({
      baseURL: API_BASE_URL,
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000,
    });
    this.session = {};
    this.pollTimeout = null;
    this.lastStatusUpdate = 0;
    this.refreshTokenTimeout = null;
    this.refreshTimeout = undefined;
    this.mqttRetryTimeout = null;
    this.mqttClient = null;
    this.mqttConnected = false;
    this.mqttRefreshing = false;
    this.mqttErrorCount = 0;
    this.lastMqttCredentialRefresh = 0;
    this.tokenRefreshFailures = 0;
    this.pollFailures = 0;
    this.canvasWarned = false;
    this.lastMqttMessage = 0;
    this.lastLocationMessage = {};
    this.lastLocationRecovery = {};
    this.locationRecoveryRunning = false;
    this.runningSince = {};
    this.locationMqttStale = {};
    this.locationHistory = {};
    this.trackTolerance = {};
    this.lastMowingPercentage = {};
    this.lastSubtotalArea = {};
    this.lastLocationAt = {};
    this.sessionStart = {};
    this.lastStateChannelAt = {};
    this.lastTrackSave = {};
    this.mapFrame = {};
    this.dockPosition = {};
    this.pendingLocation = {};
    this.lastLocation = {};
    this.lastVehicleState = {};
    // Per device: one mower's render must not swallow another's, and the pending timer has to
    // know which map it was armed for.
    this.lastMapRender = {};
    this.mapRenderTimeout = {};
    this.httpPollRunning = false;
    this.httpPollStartedAt = 0;
    this.httpPollToken = 0;
    this.unloading = false;
  }

  async onReady() {
    this.setState('info.connection', false, true);
    const configuredInterval = Number(this.config.interval);
    if (!Number.isFinite(configuredInterval) || configuredInterval < 0) {
      this.log.info('Invalid interval, defaulting to 5 minutes');
      this.config.interval = 5;
    } else if (configuredInterval > MAX_INTERVAL_MINUTES) {
      // The admin UI stops at a day, but the value can also come from a script or a
      // hand-edited instance object, and a delay past 2^31 ms fires a timer at once.
      this.log.info(`Interval capped at ${MAX_INTERVAL_MINUTES} minutes`);
      this.config.interval = MAX_INTERVAL_MINUTES;
    } else {
      this.config.interval = configuredInterval;
    }

    this.subscribeStates('*');

    await this.setObjectNotExistsAsync('auth', {
      type: 'channel',
      common: { name: 'Authentication' },
      native: {},
    });
    await this.setObjectNotExistsAsync('auth.token', {
      type: 'state',
      common: { name: 'Token Data', type: 'string', role: 'json', read: true, write: false },
      native: {},
    });

    // Step 1: New auth code in config -> exchange for token
    if (this.config.authCode) {
      let authCode = this.config.authCode.trim();
      // Its length, not its first characters: the code buys a token, and a debug log is
      // pasted into forum threads.
      this.log.debug('Auth code input (' + authCode.length + ' characters)');
      // Extract code from full URL if user pasted the entire redirect URL
      if (authCode.startsWith('http')) {
        try {
          const parsed = new URL(authCode);
          authCode = parsed.searchParams.get('code') || authCode;
          this.log.debug('Extracted code from URL (' + authCode.length + ' characters)');
        } catch {
          this.log.debug('Auth code is not a valid URL, using as-is');
        }
      }
      this.log.info('Authorization code found in config, exchanging for token...');
      const tokenData = await this.exchangeCodeForToken(authCode);
      if (tokenData) {
        await this.storeToken(tokenData);
        this.log.info('Token obtained. Clearing auth code from config.');
        this.extendForeignObject('system.adapter.' + this.namespace, {
          native: { authCode: '' },
        });
      } else {
        this.log.error('Token exchange failed. Check the authorization code.');
      }
    }

    // Step 2: Restore stored token and try refresh
    this.log.debug('Loading stored token...');
    const tokenState = await this.getStateAsync('auth.token');
    if (tokenState && tokenState.val) {
      let tokenObj;
      try {
        tokenObj = JSON.parse(/** @type {string} */ (tokenState.val));
      } catch {
        tokenObj = { access_token: tokenState.val };
      }

      if (tokenObj.refresh_token) {
        this.log.info('Refresh token found, trying to refresh...');
        const refreshed = await this.refreshToken(tokenObj.refresh_token);
        if (refreshed) {
          tokenObj = refreshed;
          await this.storeToken(tokenObj);
          this.log.info('Token refreshed successfully');
        } else {
          this.log.warn('Token refresh failed, using stored access token');
        }
      }

      if (tokenObj.access_token) {
        this.session = tokenObj;
        this.setState('info.connection', true, true);
        this.log.info('Token loaded (expires_in: ' + (tokenObj.expires_in || 'unknown') + 's)');
        this.log.debug('Access token loaded (' + tokenObj.access_token.length + ' characters)');
        await this.getDeviceList();
        this.log.debug('Device array: ' + JSON.stringify(this.deviceArray));
        await this.pollDevices('startup');

        // Connect MQTT for real-time updates
        await this.connectMqtt();

        // Periodic HTTP polling alongside MQTT real-time updates (0 = disabled)
        if (this.config.interval > 0) {
          const pollMs = this.config.interval * 60 * 1000;
          this.log.info(
            'Periodic HTTP status polling active every ' + this.config.interval + ' minute(s). MQTT remains active for real-time updates.',
          );
          this.schedulePoll(pollMs, 'interval');
        } else {
          this.log.info(
            'Periodic HTTP status polling disabled (interval=0). Relying on MQTT, with an HTTP fallback poll after ' +
              Math.round(STATUS_STALE_MS / 60000) +
              ' minutes without a status update.',
          );
          this.schedulePoll(STATUS_STALE_CHECK_MS, 'status stale');
        }

        // Schedule token refresh
        if (tokenObj.expires_in) {
          const refreshMs = (tokenObj.expires_in - 300) * 1000;
          if (refreshMs > 0) {
            this.refreshTokenTimeout = this.setTimeout(() => {
              this.handleTokenRefresh();
            }, refreshMs);
            this.log.info('Token refresh scheduled in ' + Math.round(refreshMs / 60000) + ' min');
          }
        }
      } else {
        this.log.warn('No valid access token found.');
      }
    } else {
      this.log.warn(
        'No token found. Open the Navimow login link in adapter settings, copy the code and paste it into the settings.',
      );
    }
  }

  // ---- MQTT ----

  connectMqtt() {
    // Any connect attempt supersedes a pending retry.
    if (this.mqttRetryTimeout) {
      this.clearTimeout(this.mqttRetryTimeout);
      this.mqttRetryTimeout = null;
    }
    if (this.deviceArray.length === 0) {
      this.log.info('No devices, skipping MQTT');
      return Promise.resolve();
    }

    return this.requestClient({
      method: 'get',
      url: '/openapi/mqtt/userInfo/get/v2',
      headers: this.getAuthHeaders(),
    })
      .then((res) => {
        if (!res.data || res.data.code !== 1) {
          this.log.warn('Failed to get MQTT info: ' + JSON.stringify(res.data));
          // Server may temporarily block the request (e.g. "url Circuit Breaker").
          // Without a retry, MQTT stays down until the next token refresh (~55 min).
          this.scheduleMqttRetry();
          return;
        }
        const mqttInfo = res.data.data ?? {};
        const mqttUrlRaw = mqttInfo.mqttUrl;
        // Parse hostname from mqttHost (may contain scheme like wss://host)
        let mqttHost = mqttInfo.mqttHost || 'mqtt.navimow.com';
        try {
          const parsedHost = new URL(mqttHost);
          mqttHost = parsedHost.hostname || mqttHost;
        } catch {
          // already a plain hostname
        }
        const mqttUsername = mqttInfo.userName;
        const mqttPassword = mqttInfo.pwdInfo;

        // Do not log mqttInfo verbatim: it contains pwdInfo (the broker password).
        this.log.debug('MQTT info received: host=' + mqttHost + ' hasCredentials=' + !!(mqttUsername && mqttPassword));

        let brokerUrl;
        const mqttOpts = {
          clientId: 'web_' + (mqttUsername || 'iobroker') + '_' + crypto.randomUUID().replace(/-/g, '').substring(0, 10),
          // How long the client may stay silent before it owes the broker a PINGREQ, in
          // seconds - and, at 1.5x, how long the broker waits before it may drop a client it
          // has not heard from.
          //
          // It stood at 2400, forty minutes of allowed silence, and that is what killed the
          // stream whenever the mower stood still. Measured on the wss path over two full days
          // (2026-08-11/12, mower docked overnight): after every connect exactly two of the
          // mower's five-minute heartbeats arrive, then the connection goes quiet and stays
          // quiet - location and state channel alike - with no error, no close and no
          // reconnect. Only the scheduled token reconnect 55 minutes later brought it back:
          //
          //   connect 03:42:28 -> last message 03:51:45 -> silence until 04:37
          //   connect 04:37:18 -> last message 04:46:45 -> silence until 05:32
          //   connect 05:32:18 -> last message 05:41:45 -> silence until 06:27
          //
          // Something on the way to the broker reaps a connection idle for about ten minutes,
          // and reaps it without a FIN, so mqtt.js believes it is connected until its own ping
          // falls due - which at 2400 is long after the reconnect that hid the whole thing.
          // Mowing masks the fault: positions arrive every two seconds, the connection never
          // falls idle, and the stream ran six hours without a gap on the same day.
          //
          // The 2400 is the upstream SDK's value, and it guards a broker that drops connections
          // after an hour without traffic - mower_sdk/mqtt.py picks forty minutes so that one
          // PINGREQ falls inside that hour, and clamps the setting at max(30, ...). That is a
          // lower bound on traffic, not an upper one, and the vendor's own floor is 30 seconds.
          // At 60 the client sends four bytes a minute, well inside both limits, the connection
          // never sits idle long enough to be reaped, and a link that dies anyway is noticed
          // within two minutes instead of up to eighty.
          keepalive: 60,
          reconnectPeriod: 10000,
        };

        // Only set MQTT username/password if both are present (matches HA behavior)
        if (mqttUsername && mqttPassword) {
          mqttOpts.username = mqttUsername;
          mqttOpts.password = mqttPassword;
        }

        if (mqttUrlRaw) {
          // WebSocket mode
          try {
            const parsed = new URL(mqttUrlRaw);
            const wsScheme = parsed.protocol === 'wss:' ? 'wss' : 'ws';
            const wsPort = parsed.port || (wsScheme === 'wss' ? 443 : 80);
            const wsPath = (parsed.pathname || '/') + (parsed.search || '');
            brokerUrl = wsScheme + '://' + (parsed.hostname || mqttHost) + ':' + wsPort + wsPath;
            mqttOpts.wsOptions = {
              headers: { Authorization: 'Bearer ' + this.session.access_token },
            };
            if (wsScheme === 'wss') {
              mqttOpts.rejectUnauthorized = true;
            }
          } catch {
            // Fallback: treat mqttUrl as ws path
            brokerUrl = 'wss://' + mqttHost + ':443' + mqttUrlRaw;
            mqttOpts.wsOptions = {
              headers: { Authorization: 'Bearer ' + this.session.access_token },
            };
          }
        } else {
          // TCP mode
          brokerUrl = 'mqtt://' + mqttHost + ':1883';
        }

        this.log.info('MQTT connecting to ' + brokerUrl);
        this.log.debug('MQTT clientId: ' + mqttOpts.clientId);
        this.log.debug('MQTT username: ' + (mqttUsername || 'none'));
        const mqttClient = mqtt.connect(brokerUrl, mqttOpts);
        this.mqttClient = mqttClient;

        mqttClient.on('connect', () => {
          if (this.mqttClient !== mqttClient) {
            return;
          }
          if (this.mqttErrorCount > 0) {
            this.log.info('MQTT reconnected successfully after ' + this.mqttErrorCount + ' error(s)');
          } else {
            this.log.info('MQTT connected');
          }
          this.mqttConnected = true;
          this.mqttErrorCount = 0;
          // Reset reconnect interval on successful connect
          mqttClient.options.reconnectPeriod = 10000;
          // Subscribe to device topics
          for (const deviceId of this.deviceArray) {
            // The four channels the adapter reads, and no wildcard beside them: a subscription
            // to '/#' matches all four as well, and the broker then delivers every message once
            // per matching subscription.
            const topics = [
              '/downlink/vehicle/' + deviceId + '/realtimeDate/state',
              '/downlink/vehicle/' + deviceId + '/realtimeDate/event',
              '/downlink/vehicle/' + deviceId + '/realtimeDate/attributes',
              '/downlink/vehicle/' + deviceId + '/realtimeDate/location',
            ];
            for (const topic of topics) {
              mqttClient.subscribe(topic, (err) => {
                if (this.mqttClient !== mqttClient) {
                  return;
                }
                if (err) {
                  this.log.error('MQTT subscribe error for ' + topic + ': ' + err.message);
                } else {
                  this.log.debug('MQTT subscribed to ' + topic);
                }
              });
            }
          }
        });

        mqttClient.on('message', (topic, payload) => {
          if (this.mqttClient !== mqttClient) {
            return;
          }
          this.lastMqttMessage = Date.now();
          this.handleMqttMessage(topic, payload);
        });

        mqttClient.on('error', (err) => {
          if (this.mqttClient !== mqttClient) {
            return;
          }
          this.mqttErrorCount++;
          // A broker that drops a connection is not something the user can do anything about,
          // and it is over before they read the line: on 2026-08-13 the cloud closed the
          // connection six times in 38 minutes and every one of them was back inside two.
          // At error level each of those rings the alarm rules people hang off the log.
          //
          // The third in a row is a different matter - that is where the reconnect interval
          // goes to ten minutes below, so it is the point at which the adapter stops keeping
          // up with the mower. It is the one worth waking someone for.
          if (this.mqttErrorCount === 1) {
            this.log.warn('MQTT error: ' + err.message);
          } else if (this.mqttErrorCount === 3) {
            this.log.error('MQTT error: ' + err.message);
          } else {
            this.log.debug('MQTT error: ' + err.message);
          }
          if (this.mqttErrorCount === 3) {
            this.log.info('MQTT repeated errors, increasing reconnect interval to 10 min. HTTP polling is active as fallback.');
            mqttClient.options.reconnectPeriod = 600000;
          }
          if ('code' in err) {
            this.log.debug('MQTT error code: ' + /** @type {any} */ (err).code);
          }
        });

        mqttClient.on('close', () => {
          // Refresh MQTT credentials on unplanned disconnect (userName/pwdInfo are bound to OAuth token)
          if (/** @type {any} */ (mqttClient).suppressCredentialRefresh) {
            this.log.debug('MQTT credential refresh skipped for controlled disconnect');
            return;
          }
          if (this.mqttClient !== mqttClient) {
            return;
          }
          const wasConnected = this.mqttConnected;
          this.mqttConnected = false;
          if (wasConnected) {
            this.log.info('MQTT connection closed');
          }
          if (this.shouldRefreshMqttCredentials(wasConnected)) {
            this.refreshMqttCredentials();
          }
        });

        mqttClient.on('reconnect', () => {
          if (this.mqttClient !== mqttClient) {
            return;
          }
          if (this.mqttErrorCount >= 3) {
            this.log.info('MQTT reconnecting...');
          } else {
            this.log.debug('MQTT reconnecting...');
          }
        });
      })
      .catch((error) => {
        this.logApiError('MQTT setup failed', error, 'warn');
        this.scheduleMqttRetry();
      });
  }

  scheduleMqttRetry() {
    if (this.mqttRetryTimeout) {
      return;
    }
    this.log.info('Retrying MQTT connection in 60s');
    this.mqttRetryTimeout = this.setTimeout(() => {
      this.mqttRetryTimeout = null;
      this.connectMqtt();
    }, 60 * 1000);
  }

  /**
   * Whether a location reading is newer than the ones of its kind already seen. The broker
   * delivers late: on 2026-08-11 a mowing progress sent at 11:48 arrived at 13:34, an hour and
   * three quarters after the fact and after the session it belonged to had finished at 100 %.
   * Taken for the present it read as a new session and cleared the map of one that was over.
   * Positions in the same stream are routinely reordered by a few seconds.
   *
   * Each kind carries its own mark, told apart by the `type` the mower itself puts on the
   * reading. A single mark would let a position - one every two seconds - silence a mowing
   * progress still on its way, and those come only once a percent.
   *
   * @param {string} deviceId device
   * @param {any} point one entry of the location payload
   * @returns {boolean} false if the reading has been overtaken and is to be dropped
   */
  isFreshLocationReading(deviceId, point) {
    const at = Number(point?.time);
    // A reading the mower did not date cannot be placed in time, and dropping it on suspicion
    // would throw away every message of a firmware that sends no timestamp at all.
    if (!Number.isFinite(at) || point.type == null) return true;
    const seen = this.lastLocationAt[deviceId] || (this.lastLocationAt[deviceId] = {});
    const newest = seen[point.type];
    if (newest != null && at < newest) {
      this.log.debug(
        `Ignoring a type ${point.type} reading for ${deviceId} sent ${Math.round((newest - at) / 1000)} s ` +
          'before the last one of its kind - it arrived late and says nothing about now',
      );
      return false;
    }
    if (at - Date.now() < LOCATION_TIME_AHEAD_MAX_MS) {
      seen[point.type] = at;
    }
    return true;
  }

  /**
   * The object id of a device: what the cloud calls it, with anything ioBroker forbids in an
   * id replaced. The id reaches the object tree straight from the API and from MQTT topics,
   * and neither is ours to trust. FORBIDDEN_CHARS is the adapter base class's own pattern, so
   * this agrees with json2iob, which writes the rest of the tree under the same rule.
   *
   * @param {string} deviceId as the API or an MQTT topic spells it
   * @returns {string} the id its objects live under
   */
  deviceObjectId(deviceId) {
    return String(deviceId).replace(this.FORBIDDEN_CHARS, '_');
  }

  /**
   * A payload with every key put through the same rule, before json2iob makes object ids out
   * of them. json2iob filters most of what it writes, but three of its paths hand a key
   * straight to setState or extendObject - the plain key/value branch, the keyed string
   * array and the two-key array case - so a key the cloud spells with a character ioBroker
   * forbids would land as an id nobody can address. Cleaning them here means json2iob never
   * sees one. A dot goes too: in an id it is a level of the tree, not a character.
   *
   * @param {any} value payload as it arrived
   * @returns {any} the same payload, its keys usable as object ids
   */
  sanitizeKeys(value) {
    if (Array.isArray(value)) {
      return value.map((entry) => this.sanitizeKeys(entry));
    }
    if (!value || typeof value !== 'object') {
      return value;
    }
    /** @type {Record<string, any>} */
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
      result[this.deviceObjectId(key).replace(/\./g, '_')] = this.sanitizeKeys(entry);
    }
    return result;
  }

  handleMqttMessage(topic, payload) {
    try {
      const parts = topic.split('/').filter((p) => p !== '');
      // Expected: downlink/vehicle/{device_id}/.../{channel}
      if (parts.length < 4 || parts[0] !== 'downlink' || parts[1] !== 'vehicle') {
        this.log.debug('MQTT unknown topic: ' + topic);
        return;
      }
      // Through the same normalisation the device list went through, or the whitelist below
      // would never match a device whose id had to be rewritten to become an object id.
      const deviceId = this.deviceObjectId(parts[2]);
      const channel = parts[parts.length - 1];

      if (!this.deviceArray.includes(deviceId)) {
        this.log.debug('MQTT message for unknown device: ' + deviceId);
        return;
      }

      if (channel === 'location') {
        const now = Date.now();
        this.lastLocationMessage[deviceId] = now;
        this.setState(deviceId + '.diagnostics.lastLocationMessage', now, true);
        this.setState(deviceId + '.diagnostics.lastLocationAgeSeconds', 0, true);
        if (this.locationMqttStale[deviceId]) {
          this.locationMqttStale[deviceId] = false;
          this.setState(deviceId + '.diagnostics.locationMqttStale', false, true);
          this.log.info('MQTT location stream recovered: device=' + deviceId);
        }
      }

      let data = JSON.parse(payload.toString());

      this.log.debug('MQTT ' + channel + ' for ' + deviceId + ': ' + JSON.stringify(data));

      // state channel: also store raw JSON
      if (channel === 'state') {
        this.lastStatusUpdate = Date.now();
        this.setState(deviceId + '.status.json', JSON.stringify(data), true);
        // The state channel calls the mower state "state" and reports it the moment it
        // changes, while getVehicleStatus calls it "vehicleState" and lags behind by a
        // minute or two - it still answered "isDocked" for a mower that had been out
        // mowing for a while. Both are the same vocabulary, so the timely one is put where
        // the documented datapoint is, and everything reading vehicleState follows along.
        // Only a message that actually carries a state may keep the poll out of the field
        // afterwards - the channel also sends payloads without one.
        if (typeof data.state === 'string' && data.state) {
          this.lastStateChannelAt[deviceId] = this.lastStatusUpdate;
          this.setState(deviceId + '.status.vehicleState', data.state, true);
        }
      }

      // location channel: collect points and render map
      if (channel === 'location') {
        let points = Array.isArray(data) ? data : [data];

        // Anything the mower sent before a reading of the same kind already seen is dropped
        // here, once, so nothing downstream has to think about it: not the session decision,
        // not the track, and not the states written at the end. A message that is stale
        // through and through leaves nothing to act on and ends here.
        points = points.filter((p) => this.isFreshLocationReading(deviceId, p));
        // The placeholder a standing mower sends goes the same way, and for the same reason:
        // nothing downstream should have to know it is not a measurement.
        points = points.filter((p) => {
          if (!isPlaceholderPosture(p)) return true;
          this.log.debug(
            `Ignoring an all-zero posture for ${deviceId} (vehicleState=${p.vehicleState}) - ` +
              'the mower is standing, not at the origin',
          );
          return false;
        });
        if (!points.length) return;
        // So the states see what the track sees. A payload holding a placeholder behind
        // another reading would otherwise still write the zeros, the last entry being what
        // the states are filled from.
        if (Array.isArray(data)) data = points;

        // The map is what all of this is for, and it is off unless it was asked for. The
        // positions still reach the location states below; what is skipped is collecting
        // them into a track, deciding sessions on them, and drawing.
        if (this.config.mapEnabled) {
          this.updateMowingMap(deviceId, points);
        }
      }

      // Arrays: use last entry (e.g. location)
      if (Array.isArray(data)) {
        data = data[data.length - 1];
        if (!data) return;
      }

      const folderName = channel === 'state' ? 'status' : channel;
      this.json2iob.parse(deviceId + '.' + folderName, this.sanitizeKeys(data), {
        forceIndex: true,
        channelName: folderName.charAt(0).toUpperCase() + folderName.slice(1),
        descriptions,
        // The value lists are keyed by the state names the state channel reports
        // ("isRunning", "isDocked"). The location channel has a vehicleState of its own, a
        // number, and attaching the same list to it puts values on the object that its
        // state can never take.
        states: channel === 'state' ? states : undefined,
      });
    } catch (e) {
      this.log.error('MQTT message parse error: ' + e.message);
    }
  }


  /**
   * Collect the positions of one location message into the mowing track and draw it, having
   * first decided whether they belong to the session already on the map or start a new one.
   *
   * @param {string} deviceId device
   * @param {any[]} points the readings of the message, the overtaken ones already dropped
   */
  updateMowingMap(deviceId, points) {
    // Decide whether this is still the same mowing session, before the new points are
    // collected. The mowing progress is the only signal that tells a new session from a
    // continuation: it starts over at zero for a new one and picks up where it left off
    // when the mower carries on after a charging break.
    //
    // Every point of the payload is looked at, not only the first one carrying a progress:
    // a single message can hold the end of one session and the start of the next
    // ([80 %, 0 %]), and stopping at the first would take the oldest sample for the truth
    // and miss the boundary. The newest restart in the batch wins, and the points ahead of
    // it belong to the session that just ended, so they go with it.
    //
    // The progress is late, though: for minutes after leaving the dock the mower still
    // reports the one of the session before - it only ticks once a whole percent is done,
    // which on a large lawn is several minutes. `sessionStart` holds where the track stood
    // when it left, set on the state change, so the positions driven until then survive the
    // reset the progress asks for once it catches up.
    //
    // `subtotalArea` says the same thing in square metres, and it is the field the mower
    // zeroes the moment it takes on a new task: the message announcing the start carries
    // "0.0" square metres next to the stale 100 % of the session before. So the area is
    // asked first and answers minutes earlier; the percentage stays as the second witness,
    // for the mowers or firmwares that send no area at all.
    //
    // The two are not one quantity rescaled, measured over one session: 4.21 m² at 1.04 %
    // puts the lawn at 405 m², 224.15 m² at 61.01 % puts it at 367 m². The percentage
    // follows the planned path, the area follows the ground covered. What the area is, is
    // an accumulator: over the same session it tracked the rise in `mowingWeekArea` to
    // within 0.05 m² (734.08 -> 958.18 against 0.0 -> 224.15), a charging break in the
    // middle included.
    //
    // What does not tell the two apart is the message itself: `action: -1` and a
    // `mapWorkPosition` starting FFFFFFFF ride on the announcement of a new task and on
    // the first message after a charging break alike. Only the numbers decide.
    const pendingStart = this.sessionStart[deviceId];
    let resetAt = -1;
    let resetReason = '';
    // Whether the progress has said what the pending session start is: a restart answers
    // "a new one", a rise above the last progress answers "the one it went to charge from".
    let decided = false;
    // Only a fraction of the location messages carry a progress at all - the mower sends
    // its position every two seconds and the progress roughly once a percent, in a message
    // of its own. Without this the value carried over from the last one would be reported
    // and stored again with every position, as if the mower had just said it.
    let reported = false;
    let progress = this.lastMowingPercentage[deviceId];
    let area = this.lastSubtotalArea[deviceId];
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (!p) continue;
      // A message that reports no task at all. Its zeroes say a session is missing, not that
      // one is beginning, and read as a start they throw the track away: on 2026-08-13 at
      // 03:14 the mower sent one from the dock, hours after it had stopped, booking the
      // 4.08 m² of the session it broke off into the week total - and the map went empty
      // overnight without the mower having moved.
      //
      // `mowStartType` is what says it: 0 in that one message and 1 in all 207 others of
      // three days of logs, alongside a `currentMowBoundary` and a `currentMowProgress` of
      // zero and a `mapWorkPosition` that is nothing but its FFFFFFFF prefix. What does not
      // tell it apart is `action: -1`, which is also the routine progress tick.
      if (Number(p.mowStartType) === 0) continue;
      const percentage = Number(p.mowingPercentage);
      const hasPercentage = p.mowingPercentage != null && Number.isFinite(percentage);
      // An empty string is not a zero square metres, but Number('') is - and would read as
      // a mower that has just started over. Only a value that says something counts.
      const mowed = p.subtotalArea === '' || p.subtotalArea == null ? NaN : Number(p.subtotalArea);
      const hasArea = Number.isFinite(mowed);
      if (!hasPercentage && !hasArea) continue;
      if (hasPercentage) {
        reported = true;
        // A progress of zero only starts a session while there is nothing to compare it
        // against. Once it is known, the drop is what counts: the mower reports zero from
        // leaving the dock until the first percent is done, which on a large lawn is
        // minutes of positions, and treating every one of them as a fresh start would
        // throw the track away again with each message.
        if (progress == null ? percentage === 0 : percentage < progress) {
          resetAt = i;
          resetReason = `mowing progress restarted (${progress ?? 'unknown'}% -> ${percentage}%)`;
          decided = true;
        } else if (progress != null && percentage > progress) {
          decided = true;
        }
        progress = percentage;
      }
      if (hasArea) {
        // Only a fall, never a zero on its own: the area stands at "0.0" for the whole
        // first percent, so starting a session on the value rather than on the fall would
        // clear the track again with every message of those minutes. A charging break does
        // not fall: measured on 2026-08-11, the mower docked at 224.15 m² and came back
        // out reporting 227.26 - what the area accumulates is the session's share of
        // `mowingWeekArea`, and nothing resets a week counter for a charge.
        if (area != null && mowed < area - MOWED_AREA_RESTART_DROP_M2) {
          resetAt = i;
          resetReason = `mowed area restarted (${area} m² -> ${mowed} m²)`;
          decided = true;
          // Read after the percentage of this very point, and deliberately overriding it:
          // the area has already turned over while the percentage still reports the
          // session before, and left standing that stale value would ask for a second
          // reset minutes later, when the percentage finally falls too - throwing away
          // the start of the new session that was just kept. Nothing is mowed yet, so
          // zero is what the new session is actually at.
          //
          // It also settles the question the state change asks: a progress that is no
          // longer null switches off the fallback that clears the map on leaving the dock,
          // for good and even for a mower that never reports a percentage. That is the
          // right answer - from here on the area says when a session starts.
          progress = 0;
          reported = true;
        }
        area = mowed;
      }
    }
    if (pendingStart && !decided && Date.now() - pendingStart.at > SESSION_START_GRACE_MS) {
      // The progress never spoke. Take it for a continuation - it is the answer that keeps
      // the track - and stop holding the points of a session start that long ago, or a
      // reset far in the future would spare everything driven since and never clear.
      decided = true;
      this.log.debug(`Giving up on the mowing progress for ${deviceId}, treating it as the same session`);
    }
    if (reported) {
      // Set before the reset, so the track written out by it already carries the progress
      // of the session that is starting.
      this.lastMowingPercentage[deviceId] = progress;
    }
    if (area != null) {
      this.lastSubtotalArea[deviceId] = area;
    }
    if (resetAt >= 0) {
      this.resetMap(deviceId, resetReason, pendingStart?.index);
      // Only without a pending session start do the points ahead of the restart belong to
      // the session that ended. With one they were all driven after the mower left the
      // dock, and the progress they carry is the stale one of the session before.
      if (!pendingStart) {
        points = points.slice(resetAt);
      }
    } else if (reported) {
      // Only while the question is still open. A progress that rose above the last one has
      // just answered it - the mower is carrying on with the session it went to charge
      // from - and calling that reading stale says the opposite of what was decided.
      const stale = pendingStart && !decided ? ', still the one of the session before?' : '';
      this.log.debug(`Mowing progress for ${deviceId}: ${progress}%${stale}`);
    }
    if (decided) {
      delete this.sessionStart[deviceId];
    }

    // A mower in the dock keeps reporting a position every five minutes, and its own pose
    // estimate wanders while it stands there: measured over one docked morning (2026-08-12)
    // it covered 1.16 m in steps of 2 to 47 cm without the mower having moved at all. Each
    // step is a point, so the track grows all night; and because the frame only ever grows,
    // a drift excursion widens the picture for good, while the jump guard sits at ten metres
    // and never sees a metre of it.
    //
    // The track is a mowing track. The position the mower arrives in the dock with is worth
    // having - it is what locates the charging station - and it is already collected, because
    // it is reported while the state is still isDocking. From the arrival on there is nothing
    // to record until the mower drives out again.
    if (SESSION_END_STATES.has(String(this.lastVehicleState[deviceId]))) {
      points = [];
    }

    if (!this.locationHistory[deviceId]) {
      this.locationHistory[deviceId] = [];
    }
    const history = this.locationHistory[deviceId];
    // The track changes without getting longer: a position on the line the map already
    // draws replaces the one before it rather than joining it, and reaching the budget
    // makes the track shorter. So what says the map is out of date is the last position
    // itself - the same marker saveMapTrack uses, and for the same reason.
    const prevLast = history[history.length - 1];
    for (const p of points) {
      if (p && p.postureX != null && p.postureY != null) {
        const x = parseFloat(p.postureX);
        const y = parseFloat(p.postureY);
        // Infinity survives isNaN, and a frame grown to Infinity turns the canvas
        // dimensions into NaN, which the native canvas answers with an abort of the
        // whole process. Nothing but a finite coordinate is of any use here anyway.
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        // The frame outlives a map reset, so the first position of a new session would
        // widen it unchecked. lastLocation keeps the last accepted position across the
        // reset, so the guard below covers that point too.
        let last = history[history.length - 1] || this.lastLocation[deviceId];
        // A single position far from the last one is not believed straight away. It
        // would draw a spike across the map, and because the frame only ever grows it
        // would widen the picture for good - a one-off stray reading would leave the
        // real mowing squeezed into a corner for every session to come. The next
        // message decides: if it lands near the held-back one, the mower really is
        // somewhere else (back out of the dock, or the adapter restarted onto an older
        // track) and both are taken. If not, the reading is dropped and never seen again.
        if (last && Math.hypot(x - last.x, y - last.y) > LOCATION_JUMP_MAX_M) {
          const pending = this.pendingLocation[deviceId];
          if (!pending || Math.hypot(x - pending.x, y - pending.y) > LOCATION_JUMP_MAX_M) {
            this.pendingLocation[deviceId] = trackPoint(x, y, p.postureTheta);
            this.log.debug(
              `Holding back position x=${x} y=${y} for ${deviceId}: ` +
                  `${Math.hypot(x - last.x, y - last.y).toFixed(1)} m from the last one`,
            );
            continue;
          }
          this.log.debug(`Position x=${x} y=${y} for ${deviceId} confirmed by a second message, taking it`);
          this.pushTrackPoint(deviceId, pending);
          // The confirmed one is now the last point, so an identical reading is not
          // pushed a second time below.
          last = pending;
        }
        this.pendingLocation[deviceId] = undefined;
        if (!last || last.x !== x || last.y !== y) {
          this.pushTrackPoint(deviceId, trackPoint(x, y, p.postureTheta));
        }
        // With the heading: it is what the marker is drawn at while the track is empty, and
        // this is the one position that survives a reset.
        this.lastLocation[deviceId] = trackPoint(x, y, p.postureTheta);
      }
    }
    // Re-read it: a compaction swaps the array out, so the one captured above may be the
    // track as it stood before.
    const collected = this.locationHistory[deviceId];
    if (collected[collected.length - 1] !== prevLast) {
      const now = Date.now();
      const last = this.lastMapRender[deviceId] || 0;
      const minMs = this.mapRenderMinMs();
      if (now - last >= minMs) {
        this.renderMapNow(deviceId);
      } else if (!this.mapRenderTimeout[deviceId]) {
        // Trailing edge: the positions arriving until then are all in the track already, so
        // the one render that follows shows every one of them.
        this.mapRenderTimeout[deviceId] = this.setTimeout(() => this.renderMapNow(deviceId), minMs - (now - last));
      }
    }
  }

  /**
   * Map vehicleState to the active remote command
   * @param {string} deviceId
   * @param {string} vehicleState
   */
  /**
   * How long a position may wait for its render. Checked here rather than trusted from the UI:
   * the value can also come from a script or a hand-edited instance object, and a zero would
   * draw on every message while a negative one would arm timers into the past.
   *
   * @returns {number} milliseconds
   */
  mapRenderMinMs() {
    const seconds = Number(this.config.mapRenderInterval);
    const valid = seconds >= MAP_RENDER_MIN_S && seconds <= MAP_RENDER_MAX_S;
    return (valid ? seconds : MAP_RENDER_DEFAULT_S) * 1000;
  }

  /**
   * Draw the map at once and restart the throttle window. For the moments the picture has to be
   * right straight away - the mower reached the dock, the map was reset, the station was moved -
   * and for the pending render of the throttle itself, which must not fire a second time on top
   * of one of those.
   *
   * @param {string} deviceId device
   */
  renderMapNow(deviceId) {
    if (this.mapRenderTimeout[deviceId]) {
      this.clearTimeout(this.mapRenderTimeout[deviceId]);
      this.mapRenderTimeout[deviceId] = null;
    }
    this.lastMapRender[deviceId] = Date.now();
    this.renderMap(deviceId);
  }

  renderMap(deviceId) {
    const points = this.locationHistory[deviceId]?.slice() || [];
    const dock = this.dockPosition[deviceId];
    // A track of its own needs two positions to be a line. The charging station does not: it
    // outlives the session, and drawn on its own it keeps the map from going blank between a
    // reset and the first position of the session that follows. With neither there is nothing
    // to draw at all.
    if (points.length < 2 && !dock) return;
    const canvasLib = loadCanvas();
    if (!canvasLib.createCanvas) {
      // Once: the alternative is this line every few seconds for as long as the mower drives,
      // and nothing about it changes in between.
      if (!this.canvasWarned) {
        this.canvasWarned = true;
        this.log.warn(
          `The mowing map needs @napi-rs/canvas, which will not load here: ${canvasLib.error}. ` +
            'Everything else keeps working - the map is the only thing that stays empty.',
        );
      }
      return;
    }
    const createCanvas = /** @type {Function} */ (canvasLib.createCanvas);
    this.log.debug(`Rendering map for ${deviceId}: ${points.length} points`);

    // The charging station is grown into the frame as well, so it cannot end up outside the
    // picture. In a call of its own rather than appended to the positions: the track runs to
    // ten thousand of them and copying that array once a second to add one fixed point to the
    // end of it is work for nothing.
    // An empty track is not offered to growMapFrame: with no frame stored yet it would answer
    // the infinities it started from, and store them.
    let frame = this.mapFrame[deviceId];
    if (points.length) {
      frame = this.growMapFrame(deviceId, points);
    }
    if (dock) {
      frame = this.growMapFrame(deviceId, [dock]);
    }
    if (!frame) return;

    const configuredSize = Number(this.config.mapMarkerSize);
    const markerSize = configuredSize >= 4 && configuredSize <= 60 ? configuredSize : 10;

    // One scale for both axes, and the corners of the image are the corners of the frame:
    // that is what makes a world position land on a fixed pixel, and what keeps a garden
    // that is longer than it is wide from being squeezed into a square.
    const scale = MAP_SIZE_PX / Math.max(frame.maxX - frame.minX, frame.maxY - frame.minY);
    const width = Math.round((frame.maxX - frame.minX) * scale);
    const height = Math.round((frame.maxY - frame.minY) * scale);
    // Y-flip only: real-world Y grows up, canvas Y grows down.
    const projectX = (x) => (x - frame.minX) * scale;
    const projectY = (y) => (frame.maxY - y) * scale;

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // Grid
    ctx.strokeStyle = 'rgba(100,100,100,0.3)';
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 10; i++) {
      ctx.beginPath();
      ctx.moveTo((width / 10) * i, 0);
      ctx.lineTo((width / 10) * i, height);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, (height / 10) * i);
      ctx.lineTo(width, (height / 10) * i);
      ctx.stroke();
    }

    // A value the UI cannot produce - out of range, or text where a number belongs - falls
    // back to the default on its own: NaN fails every comparison below.
    const color = String(this.config.mapLineColor || '').trim();
    const opacity = Number(this.config.mapLineOpacity);
    const lineWidth = Number(this.config.mapLineWidth);

    // The track is drawn on a canvas of its own, fully opaque, and laid over the map as a
    // single image. Stroked straight onto the map at a globalAlpha below 1, every overlap
    // blends with itself into a darker spot - the rounded ends where two segments meet, and
    // every stretch the mower drove twice - and the line reads as mottled rather than
    // transparent.
    const trackCanvas = createCanvas(width, height);
    const trackCtx = trackCanvas.getContext('2d');
    trackCtx.lineWidth = lineWidth >= 0.5 && lineWidth <= 10 ? lineWidth : 1.5;
    trackCtx.lineJoin = 'round';
    trackCtx.lineCap = 'round';
    if (color && points.length) {
      // One path and one stroke, so there are no seams between the segments at all.
      trackCtx.strokeStyle = color;
      trackCtx.beginPath();
      trackCtx.moveTo(projectX(points[0].x), projectY(points[0].y));
      for (let i = 1; i < points.length; i++) {
        trackCtx.lineTo(projectX(points[i].x), projectY(points[i].y));
      }
      trackCtx.stroke();
    } else {
      // The gradient from blue at the start to green at the current position is what the map
      // has always looked like, so it stays the default. It needs a stroke per segment.
      for (let i = 1; i < points.length; i++) {
        const t = i / (points.length - 1);
        trackCtx.strokeStyle = `rgb(0,${Math.round(120 + 135 * t)},${Math.round(255 - 155 * t)})`;
        trackCtx.beginPath();
        trackCtx.moveTo(projectX(points[i - 1].x), projectY(points[i - 1].y));
        trackCtx.lineTo(projectX(points[i].x), projectY(points[i].y));
        trackCtx.stroke();
      }
    }
    ctx.globalAlpha = opacity >= 0.05 && opacity <= 1 ? opacity : 1;
    ctx.drawImage(trackCanvas, 0, 0);
    // The markers stay opaque whatever the track does - they are the two positions worth
    // finding again on a busy background.
    ctx.globalAlpha = 1;

    // Charging station, where it is known
    if (dock) {
      this.drawDockMarker(ctx, projectX(dock.x), projectY(dock.y), markerSize);
    }

    // Start marker (blue)
    const first = points[0];
    if (first) {
      ctx.fillStyle = '#4488ff';
      ctx.beginPath();
      ctx.arc(projectX(first.x), projectY(first.y), 5, 0, Math.PI * 2);
      ctx.fill();
    }

    // Current position marker. On a map with no track the mower is in the dock, so that is
    // where it is drawn - facing the way it arrived, which is the heading lastLocation kept
    // across the reset. Without it the mower would be missing from the picture for as long as
    // it takes the new session to report its first position.
    const last = points[points.length - 1] || (dock ? { ...dock, theta: this.lastLocation[deviceId]?.theta } : undefined);
    if (last && this.config.mapMarker === 'mower') {
      // postureTheta is the mower's own heading, counted from +X counterclockwise - the same
      // convention as atan2, checked against the direction actually driven over twelve samples
      // of a straight lane, where the two agreed to a mean of 0.003 rad. It is negated because
      // the canvas counts Y downwards. Better than the direction of travel in two ways: it is
      // there from the first position of a session, and it still points the right way while the
      // mower stands still. Without it the last stretch driven has to do, and with nothing to
      // go on the mower faces right.
      const prev = points[points.length - 2];
      const angle = Number.isFinite(last.theta)
        ? -last.theta
        : prev
          ? Math.atan2(projectY(last.y) - projectY(prev.y), projectX(last.x) - projectX(prev.x))
          : 0;
      this.drawMowerMarker(ctx, projectX(last.x), projectY(last.y), markerSize, angle);
    } else if (last) {
      ctx.fillStyle = '#ff4444';
      ctx.beginPath();
      ctx.arc(projectX(last.x), projectY(last.y), markerSize / 2, 0, Math.PI * 2);
      ctx.fill();
    }

    const base64 = 'data:image/png;base64,' + canvas.toBuffer('image/png').toString('base64');
    this.setState(deviceId + '.map', base64, true);
    void this.saveMapTrack(deviceId);
  }

  /**
   * The rectangle of the garden, in mower coordinates, that the map image covers.
   *
   * It used to be re-fitted to the current point cloud on every render, so every point
   * beyond the previous extent moved every pixel already drawn and the track crept across
   * a background image for the whole session. The frame therefore only ever grows, and it
   * grows a margin past the point that triggered it, snapped to whole metres - so it jumps
   * ahead of the mower and stops changing once the garden has been driven, instead of
   * nudging on every location message.
   *
   * It is not reset with the track: staying put across sessions is the point.
   *
   * @param {string} deviceId device
   * @param {{x:number,y:number}[]} points the track the map is drawn from
   * @returns {{minX:number,maxX:number,minY:number,maxY:number}} frame containing them all
   */
  growMapFrame(deviceId, points) {
    const current = this.mapFrame[deviceId];
    let { minX, maxX, minY, maxY } = current || { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
    for (const p of points) {
      if (p.x < minX) minX = Math.floor(p.x - MAP_FRAME_MARGIN_M);
      if (p.x > maxX) maxX = Math.ceil(p.x + MAP_FRAME_MARGIN_M);
      if (p.y < minY) minY = Math.floor(p.y - MAP_FRAME_MARGIN_M);
      if (p.y > maxY) maxY = Math.ceil(p.y + MAP_FRAME_MARGIN_M);
    }
    if (current && minX === current.minX && maxX === current.maxX && minY === current.minY && maxY === current.maxY) {
      return current;
    }
    const frame = { minX, maxX, minY, maxY };
    this.mapFrame[deviceId] = frame;
    const scale = MAP_SIZE_PX / Math.max(maxX - minX, maxY - minY);
    // Published with the pixel geometry of the render, so a world position's pixel is
    // (x - minX) * scale from the left and (maxY - y) * scale from the top, without
    // anyone having to repeat the projection.
    this.setState(
      deviceId + '.mapFrame',
      JSON.stringify({
        ...frame,
        width: Math.round((maxX - minX) * scale),
        height: Math.round((maxY - minY) * scale),
        // Exact, not rounded: the render projects with this value, and two decimals would
        // put a consumer several pixels off at the far edge of the frame.
        scale,
      }),
      true,
    );
    this.log.debug(`Map frame for ${deviceId} widened to ${JSON.stringify(frame)}`);
    return frame;
  }

  /**
   * @param {string} deviceId device
   */
  async loadMapFrame(deviceId) {
    const state = await this.getStateAsync(deviceId + '.mapFrame');
    if (!state?.val) return;
    let frame;
    try {
      frame = JSON.parse(String(state.val));
    } catch (e) {
      this.log.warn(`Ignoring unreadable map frame for ${deviceId}: ${e.message}`);
      return;
    }
    const { minX, maxX, minY, maxY } = frame || {};
    if (![minX, maxX, minY, maxY].every(Number.isFinite) || minX >= maxX || minY >= maxY) {
      this.log.warn(`Ignoring unusable map frame for ${deviceId}: ${state.val}`);
      return;
    }
    this.mapFrame[deviceId] = { minX, maxX, minY, maxY };
    this.log.debug(`Restored map frame for ${deviceId}: ${JSON.stringify(this.mapFrame[deviceId])}`);
  }

  /**
   * Keep the mowing track so the map survives a restart. Until now the points were only
   * held in memory, so every restart - including the one that saving the settings triggers
   * - left the map frozen on its last PNG until the mower drove again.
   *
   * Written at most every MAP_TRACK_SAVE_MS and only when points have actually come in
   * since the last write, because a session runs into thousands of them.
   *
   * The marker for "something came in" is the last point itself, not the length of the
   * track: the track is thinned as positions arrive and again when it reaches its budget, so
   * its length stands still or even falls while the mowing goes on, and a length comparison
   * would stop saving right where this matters most. Every position that is kept lands as a
   * new object at the end, so the identity of the last one changes exactly when the track does.
   *
   * @param {string} deviceId device
   * @param {boolean} [force] write now, regardless of when the last write was
   * @returns {Promise<void>}
   */
  async saveMapTrack(deviceId, force) {
    const points = this.locationHistory[deviceId] || [];
    const saved = this.lastTrackSave[deviceId];
    if (saved && !force) {
      if (saved.last === points[points.length - 1]) return;
      if (Date.now() - saved.at < MAP_TRACK_SAVE_MS) return;
    }
    // Pairs rather than objects and centimetres rather than raw floats: same picture at a
    // fraction of the size. The mowing progress travels with the track, because without it a
    // restart cannot tell the first sample of a new session from a resumed one.
    const track = {
      percentage: this.lastMowingPercentage[deviceId] ?? null,
      // The area travels for the same reason, and it is the field that spots the restart
      // first. A track written before it did simply comes back without one.
      area: this.lastSubtotalArea[deviceId] ?? null,
      points: points.map((p) => {
        const pair = [Math.round(p.x * 100) / 100, Math.round(p.y * 100) / 100];
        // The heading is only read off the last position, but carrying it on every one keeps
        // them one shape, and a track written without it still reads as it always did.
        return Number.isFinite(p.theta) ? [...pair, Math.round(p.theta * 100) / 100] : pair;
      }),
    };
    await this.setStateAsync(deviceId + '.mapTrack', JSON.stringify(track), true);
    // Only after the write went through, so a failed one is retried on the next call
    // instead of being remembered as saved.
    this.lastTrackSave[deviceId] = { at: Date.now(), last: points[points.length - 1] };
  }

  /**
   * @param {string} deviceId device
   */
  async loadMapTrack(deviceId) {
    const state = await this.getStateAsync(deviceId + '.mapTrack');
    if (!state?.val) return;
    let track;
    try {
      track = JSON.parse(String(state.val));
    } catch (e) {
      this.log.warn(`Ignoring unreadable mowing track for ${deviceId}: ${e.message}`);
      return;
    }
    // A bare array is a track from before the mowing progress travelled with it, so there is
    // nothing to compare the next progress sample against. Restoring it anyway would append
    // the next session to it and only sort itself out one session later, so it is dropped
    // once, on the first start after the update.
    if (Array.isArray(track)) {
      this.log.info(`Discarding the mowing track of ${deviceId}: it carries no mowing progress to continue from`);
      // Overwrite it and drop the picture drawn from it: left on disk it would be discarded
      // again on every start, and the map would keep showing a track the adapter no longer
      // holds until the mower drives again.
      await this.saveMapTrack(deviceId, true);
      this.setState(deviceId + '.map', '', true);
      return;
    }
    if (!track || !Array.isArray(track.points)) return;
    if (Number.isFinite(track.percentage)) {
      this.lastMowingPercentage[deviceId] = track.percentage;
    }
    if (Number.isFinite(track.area)) {
      this.lastSubtotalArea[deviceId] = track.area;
    }
    const points = track.points
      .filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
      .map((p) => trackPoint(p[0], p[1], p[2]));
    if (!points.length) return;
    this.locationHistory[deviceId] = points;
    // The track on disk is what was just loaded, so nothing needs writing back.
    this.lastTrackSave[deviceId] = { at: Date.now(), last: points[points.length - 1] };
    this.log.info(`Restored mowing track for ${deviceId}: ${points.length} points`);
    // Draw it straight away, so the map is there before the mower moves again.
    this.renderMapNow(deviceId);
  }

  disconnectMqtt(suppressCredentialRefresh = false) {
    if (!this.mqttClient) {
      return Promise.resolve();
    }

    const client = this.mqttClient;
    this.mqttClient = null;
    this.mqttConnected = false;
    if (suppressCredentialRefresh) {
      /** @type {any} */ (client).suppressCredentialRefresh = true;
    }

    return /** @type {Promise<void>} */ (new Promise((resolve) => {
      let resolved = false;
      /** @type {ioBroker.Timeout | undefined} */
      let timeoutHandle;
      const finish = () => {
        if (resolved) return;
        resolved = true;
        if (timeoutHandle) {
          this.clearTimeout(timeoutHandle);
        }
        this.log.info('MQTT disconnected');
        resolve();
      };
      client.once('close', finish);
      client.end(true, finish);
      // Not while unloading: the adapter refuses new timers then and says so in the log, and
      // there is nothing for this one to rescue anyway - onUnload fires the disconnect and
      // moves on without waiting for it. Everywhere else it bounds a reconnect that would
      // otherwise hang on a broker that never answers the close.
      if (!this.unloading) {
        timeoutHandle = this.setTimeout(finish, 2000);
      }
    }));
  }

  /**
   * Remember where the charging station is. The API has no endpoint for it - the official SDK
   * knows only authList, mqtt/userInfo, getVehicleStatus, sendCommands and responseCommands,
   * and none of them carries a coordinate - but the position the mower reports as it arrives
   * in the dock is the station's, give or take the mower's own length.
   *
   * Taken once only, and only from a fresh position. The station does not move, so a second
   * opinion can only make it worse: vehicleState lags the location stream by up to a minute,
   * so while the mower drives back out it still reads as docked, and taking its position then
   * walks the station across the garden after it. Write the state by hand to correct it, or
   * empty it to have the next docking looked at again.
   *
   * @param {string} deviceId device
   */
  recordDockPosition(deviceId) {
    if (this.dockPosition[deviceId]) return;
    const lastMessage = this.lastLocationMessage[deviceId];
    if (!lastMessage || Date.now() - lastMessage > DOCK_POSITION_MAX_AGE_MS) {
      this.log.debug(`Not locating the charging station for ${deviceId}: no recent position`);
      return;
    }
    const history = this.locationHistory[deviceId];
    const last = history?.[history.length - 1];
    if (!last) return;
    this.dockPosition[deviceId] = { x: last.x, y: last.y };
    this.log.info(`Charging station located for ${deviceId} at x=${last.x} y=${last.y} (mower arrived in the dock)`);
    this.setState(deviceId + '.dockPosition', JSON.stringify(this.dockPosition[deviceId]), true);
  }

  /**
   * @param {string} deviceId device
   */
  async loadDockPosition(deviceId) {
    const state = await this.getStateAsync(deviceId + '.dockPosition');
    if (!state?.val) return;
    const position = parsePosition(state.val);
    if (!position) {
      this.log.warn(`Ignoring unusable charging station position for ${deviceId}: ${state.val}`);
      return;
    }
    this.dockPosition[deviceId] = position;
  }

  /**
   * Take a charging station position written by hand, to correct the one the mower reported or
   * to set it without waiting for a docking. An empty value forgets it, which also re-arms the
   * automatic one.
   *
   * @param {string} deviceId device
   * @param {unknown} value the value written to the state
   */
  setDockPosition(deviceId, value) {
    if (value === '' || value == null) {
      delete this.dockPosition[deviceId];
      this.log.info(`Charging station position cleared for ${deviceId}`);
      this.setState(deviceId + '.dockPosition', '', true);
      this.renderMapNow(deviceId);
      return;
    }
    const position = parsePosition(value);
    if (!position) {
      this.log.warn(`Ignoring invalid charging station position for ${deviceId}, expected {"x":..,"y":..}: ${value}`);
      return;
    }
    this.dockPosition[deviceId] = position;
    this.log.info(`Charging station position set by hand for ${deviceId}: ${JSON.stringify(position)}`);
    this.setState(deviceId + '.dockPosition', JSON.stringify(position), true);
    this.renderMapNow(deviceId);
  }

  /**
   * The charging station: a round badge with a lightning bolt. Round because the position says
   * nothing about which way the station faces, and a shape with a front would claim an
   * orientation nobody knows.
   *
   * @param {import('@napi-rs/canvas').SKRSContext2D} ctx canvas context
   * @param {number} x pixel position
   * @param {number} y pixel position
   * @param {number} size diameter in pixels
   */
  drawDockMarker(ctx, x, y, size) {
    const r = size / 2;
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = '#2b2b2b';
    ctx.strokeStyle = '#f2f2f2';
    ctx.lineWidth = Math.max(0.5, size * 0.08);
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#00a651';
    ctx.beginPath();
    ctx.moveTo(-r * 0.12, -r * 0.62);
    ctx.lineTo(r * 0.42, -r * 0.06);
    ctx.lineTo(r * 0.08, -r * 0.06);
    ctx.lineTo(r * 0.14, r * 0.62);
    ctx.lineTo(-r * 0.42, r * 0.04);
    ctx.lineTo(-r * 0.06, r * 0.04);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /**
   * A mower seen from above, pointing the way it faces: two wheels, a body and a green front.
   * Drawn rather than loaded, so no image has to ship with the adapter or be configured before
   * the marker works.
   *
   * @param {import('@napi-rs/canvas').SKRSContext2D} ctx canvas context
   * @param {number} x pixel position
   * @param {number} y pixel position
   * @param {number} size length of the mower in pixels
   * @param {number} angle heading in canvas coordinates
   */
  drawMowerMarker(ctx, x, y, size, angle) {
    const length = size;
    const width = size * 0.7;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    // Wheels first, the body overlaps them.
    ctx.fillStyle = '#2b2b2b';
    ctx.fillRect(-length * 0.3, -width / 2 - width * 0.12, length * 0.3, width * 0.18);
    ctx.fillRect(-length * 0.3, width / 2 - width * 0.06, length * 0.3, width * 0.18);
    ctx.fillStyle = '#f2f2f2';
    ctx.strokeStyle = '#2b2b2b';
    ctx.lineWidth = Math.max(0.5, size * 0.06);
    ctx.beginPath();
    ctx.roundRect(-length / 2, -width / 2, length, width, width * 0.35);
    ctx.fill();
    ctx.stroke();
    // Green front, so the direction can be read at a glance.
    ctx.fillStyle = '#00a651';
    ctx.beginPath();
    ctx.moveTo(length * 0.16, -width * 0.44);
    ctx.lineTo(length * 0.42, -width * 0.2);
    ctx.lineTo(length * 0.42, width * 0.2);
    ctx.lineTo(length * 0.16, width * 0.44);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /**
   * Add a position to the mowing track.
   *
   * The one before it goes if the new one carries on in its direction: the mower reports every
   * two seconds and drives long straight lanes, so most of what arrives lies on a line the map
   * has already drawn, and keeping it costs a point of the budget for nothing.
   *
   * @param {string} deviceId device the track belongs to
   * @param {{x:number,y:number}} point the position that has just arrived
   */
  pushTrackPoint(deviceId, point) {
    const history = this.locationHistory[deviceId];
    const tolerance = this.trackTolerance[deviceId] || MAP_TRACK_MIN_DEVIATION_M;
    const n = history.length;
    if (n >= 2 && lineDeviation(history[n - 2], point, history[n - 1]) < tolerance) {
      history[n - 1] = point;
    } else {
      history.push(point);
    }
    if (history.length <= MAP_TRACK_MAX_POINTS) return;

    // The budget is spent. Cutting the front off would take away the part of the session the
    // map exists to show, so the whole track is thinned again instead, at whatever tolerance
    // brings it back under the budget with room to grow - and the rest of the session is
    // collected at that tolerance too, or the next position would spend it again straight away.
    let tolerated = tolerance;
    let thinned = history;
    // Thinned from the original track each round rather than from the round before, so the
    // positions kept are never further off the real one than the tolerance finally used.
    while (thinned.length > MAP_TRACK_MAX_POINTS * 0.8) {
      tolerated *= 2;
      thinned = thinTrack(history, tolerated);
    }
    this.trackTolerance[deviceId] = tolerated;
    this.locationHistory[deviceId] = thinned;
    this.log.info(
      `Mowing track of ${deviceId} reached ${history.length} positions: thinned to ${thinned.length} ` +
        `at ${(tolerated * 100).toFixed(0)} cm rather than dropping the start of the session`,
    );
  }

  isLocationActiveState(vehicleState) {
    return ACTIVE_LOCATION_STATES.has(String(vehicleState));
  }

  /**
   * Drop the collected track and the rendered map of a device.
   *
   * @param {string} deviceId device the map belongs to
   * @param {string} reason logged so it is visible which trigger cleared the map
   * @param {number} [keepFrom] index the new session already starts at, so the positions from
   *   there on survive. Zero is a meaningful value - the mower can leave the dock on an empty
   *   track - so anything but undefined counts. Thinning at intake replaces the last position
   *   rather than moving any, so an index stays valid; only a compaction renumbers the track,
   *   and the clamp below turns that into keeping nothing rather than keeping the wrong ones.
   *   It cannot keep the wrong ones: a compaction within the five minutes such an index lives
   *   needs the track to be within ~150 positions of its budget already, which puts the index
   *   past the compacted length and into the clamp.
   */
  resetMap(deviceId, reason, keepFrom) {
    const history = this.locationHistory[deviceId] || [];
    const had = history.length;
    const keep = keepFrom == null ? [] : history.slice(Math.min(keepFrom, had));
    this.locationHistory[deviceId] = keep;
    // A new session starts on the full budget, so it is collected at full detail again.
    delete this.trackTolerance[deviceId];
    // Unconditionally, and before the guard below: an empty history says nothing about what
    // is on disk, and a track left there would come back on the next start after having
    // been cleared here.
    void this.saveMapTrack(deviceId, true);
    if (!had) {
      return;
    }
    this.log.info(
      `Resetting map for ${deviceId}: ${reason}` +
        (keep.length ? `, keeping the ${keep.length} positions already driven in the new session` : ''),
    );
    if (keep.length) {
      // The picture is redrawn from the kept positions as soon as this message is collected,
      // so clearing it here would only make the map blink.
      return;
    }
    // The frame deliberately survives: it describes the garden, not the session, and a new
    // session drawn in the same frame lands on the same pixels as the one before it.
    //
    // So does the charging station, and blanking the picture took it off the map until the
    // first position of the new session arrived - the map went empty while the mower was still
    // leaving the dock. Redrawn instead, it stays; only a map that has no station to show is
    // cleared.
    if (this.dockPosition[deviceId]) {
      this.renderMapNow(deviceId);
      return;
    }
    this.setState(deviceId + '.map', '', true);
  }

  /**
   * Say that an API call failed, in one line: what was being done, what axios said, and what
   * the endpoint answered.
   *
   * @param {string} what the call that failed, as it reads in the log
   * @param {any} error the rejection axios threw
   * @param {'error'|'warn'} [level] how loud, for the calls that carry on regardless
   */
  logApiError(what, error, level = 'error') {
    const detail = apiErrorDetail(error);
    this.log[level](`${what}: ${error?.message || error}` + (detail ? ` - ${detail}` : ''));
  }

  /**
   * A status poll that did not come back with a reading.
   *
   * One of them says nothing: the cloud answers a 502 or an "Exception.Server.Error" now and
   * then and has the next poll again minutes later - three times over 2026-08-11 to 08-13,
   * every one of them gone by the following poll. Reported as an error, each rings the alarm
   * rules people hang off the ioBroker log for a gap in the readings nobody noticed.
   *
   * POLL_FAILURES_UNTIL_ERROR of them in a row is not nothing. That is a quarter of an hour
   * without a reading on the default interval, and it is the point at which the states the
   * adapter publishes are no longer the mower's. So it says so, at error level and by putting
   * `info.connection` where it belongs - which nothing did until now: the state only ever
   * went false on a 401 or a dead token refresh, so a cloud that was simply unreachable left
   * the adapter green in the admin for as long as it lasted.
   *
   * @param {string} what the call that failed, already worded for the log
   * @param {any} error the rejection, or what the API said instead of a reading
   */
  notePollFailure(what, error) {
    // The || 0 is not redundant next to the constructor: the tests drive this on a bare object.
    this.pollFailures = (this.pollFailures || 0) + 1;
    if (this.pollFailures < POLL_FAILURES_UNTIL_ERROR) {
      this.logApiError(what, error, 'warn');
      return;
    }
    this.logApiError(what, error, 'error');
    this.setState('info.connection', false, true);
  }

  /**
   * A status poll that came back. The count runs over polls in a row, so anything that got
   * through ends the run - the next hiccup starts again at a warning.
   */
  notePollSuccess() {
    // Only where it was taken away, and never on the way past: the readings are flowing
    // again, and nothing else would put the state back - it is set on login and then only
    // ever cleared. Writing it on every poll instead would put a state change on the bus
    // every five minutes for a connection that never went anywhere.
    if (this.pollFailures >= POLL_FAILURES_UNTIL_ERROR) {
      this.log.info('Status polling recovered after ' + this.pollFailures + ' failed polls');
      this.setState('info.connection', true, true);
    }
    this.pollFailures = 0;
  }

  checkLocationWatchdog(deviceId, vehicleState) {
    const now = Date.now();
    const active = this.isLocationActiveState(vehicleState);

    if (!active) {
      this.runningSince[deviceId] = 0;
      this.locationMqttStale[deviceId] = false;
      this.setState(deviceId + '.diagnostics.locationMqttStale', false, true);
      const lastLocation = this.lastLocationMessage[deviceId] || 0;
      const ageSeconds = lastLocation ? Math.round((now - lastLocation) / 1000) : 0;
      this.setState(deviceId + '.diagnostics.lastLocationAgeSeconds', ageSeconds, true);
      return;
    }

    if (!this.runningSince[deviceId]) {
      this.runningSince[deviceId] = now;
    }

    const activeAge = now - this.runningSince[deviceId];
    const lastLocation = this.lastLocationMessage[deviceId] || 0;
    const locationAge = lastLocation ? now - lastLocation : activeAge;
    const ageSeconds = Math.round(locationAge / 1000);
    this.setState(deviceId + '.diagnostics.lastLocationAgeSeconds', ageSeconds, true);

    if (activeAge < LOCATION_STALE_MS || locationAge < LOCATION_STALE_MS) {
      if (this.locationMqttStale[deviceId]) {
        this.locationMqttStale[deviceId] = false;
        this.setState(deviceId + '.diagnostics.locationMqttStale', false, true);
      }
      return;
    }

    this.locationMqttStale[deviceId] = true;
    this.setState(deviceId + '.diagnostics.locationMqttStale', true, true);

    const lastRecovery = this.lastLocationRecovery[deviceId] || 0;
    if (now - lastRecovery < LOCATION_RECOVERY_COOLDOWN_MS) {
      this.log.debug(
        'MQTT location stream stale: device=' + deviceId + ' vehicleState=' + vehicleState + ' age=' + ageSeconds + 's action=cooldown',
      );
      return;
    }

    this.log.warn(
      'MQTT location stream stale: device=' + deviceId + ' vehicleState=' + vehicleState + ' age=' + ageSeconds + 's action=reconnect',
    );
    this.recoverMqttLocationStream(deviceId);
  }

  async recoverMqttLocationStream(deviceId) {
    if (this.locationRecoveryRunning) {
      this.log.debug('MQTT location recovery already running, skipping device=' + deviceId);
      return;
    }

    this.locationRecoveryRunning = true;
    const now = Date.now();
    this.lastLocationRecovery[deviceId] = now;
    this.setState(deviceId + '.diagnostics.lastMqttRecovery', now, true);

    try {
      await this.disconnectMqtt(true);
      await this.connectMqtt();
      this.log.info('MQTT location stream reconnect initiated: device=' + deviceId);
    } catch (e) {
      this.log.warn('MQTT location recovery failed: device=' + deviceId + ' error=' + e.message);
    } finally {
      this.locationRecoveryRunning = false;
    }
  }

  /**
   * Whether a closed MQTT connection is worth fetching credentials for. 'close' says two
   * different things. A connection that was up and went down is answered at once: the broker
   * credentials are bound to the OAuth token, and a rotation is the usual reason it dropped.
   *
   * A connect attempt that never succeeded is not. mqtt.js is already retrying on its own
   * reconnectPeriod, and the refresh that used to fire for it cost an OAuth call per attempt
   * with a token seconds old - three of them in 31 seconds in one recorded case, none of which
   * shortened the gap. It is not dropped altogether, though: nothing else fetches credentials
   * for a client that has never come up, so an adapter started on an expired token would
   * retry for ever on credentials that cannot work. It is throttled instead.
   *
   * @param {boolean} wasConnected whether the connection had come up before it closed
   * @returns {boolean}
   */
  shouldRefreshMqttCredentials(wasConnected) {
    if (this.mqttRefreshing) return false;
    if (wasConnected) return true;
    return Date.now() - (this.lastMqttCredentialRefresh || 0) > MQTT_CREDENTIAL_REFRESH_MIN_MS;
  }

  async refreshMqttCredentials() {
    if (this.mqttRefreshing) return;
    this.mqttRefreshing = true;
    // Stamped where every path through it passes, so the throttle on the close handler sees
    // the attempt whether it succeeded or not - a refresh that keeps failing must not be
    // retried per connect attempt any more than a successful one.
    this.lastMqttCredentialRefresh = Date.now();
    try {
      // Refresh OAuth token first (MQTT credentials are bound to it)
      if (this.session.refresh_token) {
        const tokenData = await this.refreshToken(this.session.refresh_token);
        if (tokenData) {
          await this.storeToken(tokenData);
          this.log.debug('Token refreshed before MQTT credential update');
        }
      }
      // Fetch fresh MQTT credentials
      const res = await this.requestClient({
        method: 'get',
        url: '/openapi/mqtt/userInfo/get/v2',
        headers: this.getAuthHeaders(),
      });
      if (res.data && res.data.code === 1 && res.data.data) {
        const mqttInfo = res.data.data;
        const newUsername = mqttInfo.userName;
        const newPassword = mqttInfo.pwdInfo;
        // Update wsOptions with fresh Bearer token
        if (this.mqttClient && this.mqttClient.options) {
          if (newUsername && newPassword) {
            this.mqttClient.options.username = newUsername;
            this.mqttClient.options.password = newPassword;
          }
          const wsOptions = /** @type {any} */ (this.mqttClient.options.wsOptions);
          if (wsOptions && wsOptions.headers) {
            wsOptions.headers.Authorization = 'Bearer ' + this.session.access_token;
          }
          this.log.debug('MQTT credentials updated for next reconnect');
        }
      }
    } catch (e) {
      this.log.debug('MQTT credential refresh failed: ' + e.message);
    } finally {
      this.mqttRefreshing = false;
    }
  }

  // ---- Token Management ----

  async storeToken(tokenData) {
    this.session = tokenData;
    await this.setStateAsync('auth.token', { val: JSON.stringify(tokenData), ack: true });
    this.log.info('Token stored');
  }

  getAuthHeaders() {
    return {
      Authorization: 'Bearer ' + this.session.access_token,
      'Content-Type': 'application/json',
      requestId: crypto.randomUUID(),
    };
  }

  exchangeCodeForToken(code) {
    this.log.debug('Exchanging auth code for token (code length: ' + code.length + ')');
    return this.requestClient({
      method: 'post',
      url: OAUTH2_TOKEN_URL,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: {
        grant_type: 'authorization_code',
        code: code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
      },
    })
      .then((res) => {
        if (res.data && res.data.access_token) {
          this.log.debug('Token exchange succeeded (expires_in: ' + (res.data.expires_in || 'unknown') + 's)');
          return res.data;
        }
        this.log.error('Token exchange failed: ' + JSON.stringify(res.data));
        return null;
      })
      .catch((error) => {
        this.logApiError('Token exchange error', error);
        return null;
      });
  }

  refreshToken(refreshTokenValue) {
    this.log.debug('Refreshing token...');
    return this.requestClient({
      method: 'post',
      url: OAUTH2_TOKEN_URL,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: {
        grant_type: 'refresh_token',
        refresh_token: refreshTokenValue,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      },
    })
      .then((res) => {
        if (res.data && res.data.access_token) {
          this.log.debug('Token refresh succeeded (expires_in: ' + (res.data.expires_in || 'unknown') + 's)');
          return res.data;
        }
        // The API's own reason, never the body: a refresh response that is missing the access
        // token can still be carrying the refresh token, and this line runs at warn level.
        const why = res.data && (res.data.error_description || res.data.error || res.data.desc);
        this.log.warn('Token refresh returned no token' + (why ? ': ' + why : ''));
        return null;
      })
      .catch((error) => {
        this.logApiError('Token refresh failed', error, 'warn');
        return null;
      });
  }

  async handleTokenRefresh() {
    if (!this.session.refresh_token) {
      this.log.warn('No refresh token available. Please re-login via settings.');
      return;
    }
    const tokenData = await this.refreshToken(this.session.refresh_token);
    if (tokenData) {
      await this.storeToken(tokenData);
      this.tokenRefreshFailures = 0;
      this.log.info('Token refreshed successfully');
      // Reconnect MQTT with new token
      this.log.debug('Reconnecting MQTT with new token...');
      this.disconnectMqtt();
      this.connectMqtt();
      if (tokenData.expires_in) {
        const refreshMs = (tokenData.expires_in - 300) * 1000;
        if (refreshMs > 0) {
          this.refreshTokenTimeout = this.setTimeout(() => {
            this.handleTokenRefresh();
          }, refreshMs);
        }
      }
    } else {
      this.log.error('Token refresh failed. Please re-login via settings.');
      this.setState('info.connection', false, true);
      // What keeps this adapter authenticated is this timer rescheduling itself. Dropping it
      // on a failure meant no further attempt ever: the access token then ran out and the
      // adapter stayed offline until someone restarted it by hand, and a network outage over
      // one refresh window was enough to get there.
      this.scheduleTokenRefreshRetry();
    }
  }

  /**
   * Arm the next attempt after a refresh that failed, waiting longer the more have failed in
   * a row. Any pending one is dropped first, so the chain stays a chain rather than becoming
   * two timers refreshing against each other.
   */
  scheduleTokenRefreshRetry() {
    const retryMs = TOKEN_REFRESH_RETRY_MS[Math.min(this.tokenRefreshFailures, TOKEN_REFRESH_RETRY_MS.length - 1)];
    this.tokenRefreshFailures++;
    this.refreshTokenTimeout && this.clearTimeout(this.refreshTokenTimeout);
    this.log.info(`Trying the token refresh again in ${Math.round(retryMs / 60000)} minute(s)`);
    this.refreshTokenTimeout = this.setTimeout(() => this.handleTokenRefresh(), retryMs);
  }

  // ---- REST API ----

  getDeviceList() {
    return this.requestClient({
      method: 'get',
      url: '/openapi/smarthome/authList',
      headers: this.getAuthHeaders(),
    })
      .then(async (res) => {
        this.log.debug(JSON.stringify(res.data));
        if (res.data && res.data.code !== 1) {
          this.log.error('getDeviceList failed: ' + (res.data.desc || JSON.stringify(res.data)));
          return;
        }
        const devices = res.data.data?.payload?.devices || [];
        if (devices.length === 0) {
          this.log.warn('No devices found');
          return;
        }

        this.deviceArray = [];
        for (const device of devices) {
          if (!device.id) {
            continue;
          }
          const id = this.deviceObjectId(device.id);
          this.deviceArray.push(id);
          const name = device.name || id;

          await this.setObjectNotExistsAsync(id, {
            type: 'device',
            common: { name: name },
            native: {},
          });
          await this.setObjectNotExistsAsync(id + '.remote', {
            type: 'channel',
            common: { name: 'Remote Controls' },
            native: {},
          });
          await this.setObjectNotExistsAsync(id + '.status', {
            type: 'channel',
            common: { name: 'Status' },
            native: {},
          });
          await this.setObjectNotExistsAsync(id + '.status.json', {
            type: 'state',
            common: { name: 'Raw JSON', write: false, read: true, type: 'string', role: 'json' },
            native: {},
          });
          // Only where the map is drawn. States for a feature that is switched off are clutter
          // in the object tree, and the four of them mean nothing without it. Ones an earlier
          // run created are left alone: they hold the last picture and the track behind it, and
          // throwing that away over a checkbox is not this adapter's call to make.
          if (this.config.mapEnabled) {
            await this.setObjectNotExistsAsync(id + '.map', {
              type: 'state',
              common: { name: 'Mowing Map (PNG base64)', write: false, read: true, type: 'string', role: 'text' },
              native: {},
            });
            await this.setObjectNotExistsAsync(id + '.mapTrack', {
              type: 'state',
              common: { name: 'Mowing Map track (world positions JSON)', write: false, read: true, type: 'string', role: 'json' },
              native: {},
            });
            await this.setObjectNotExistsAsync(id + '.mapFrame', {
              type: 'state',
              common: {
                name: 'Mowing Map frame (world bounds and pixel geometry JSON)',
                write: false,
                read: true,
                type: 'string',
                role: 'json',
              },
              native: {},
            });
            await this.setObjectNotExistsAsync(id + '.dockPosition', {
              type: 'state',
              common: {
                name: 'Charging station position (world position JSON, writable)',
                write: true,
                read: true,
                type: 'string',
                role: 'json',
              },
              native: {},
            });
            // Both before the track: loading it renders the map, which needs the frame, and the
            // charging station belongs in that first picture rather than in the next one.
            await this.loadMapFrame(id);
            await this.loadDockPosition(id);
            await this.loadMapTrack(id);
          }
          await this.setObjectNotExistsAsync(id + '.diagnostics', {
            type: 'channel',
            common: { name: 'Diagnostics' },
            native: {},
          });
          await this.setObjectNotExistsAsync(id + '.diagnostics.lastLocationMessage', {
            type: 'state',
            common: { name: 'Last MQTT location message', write: false, read: true, type: 'number', role: 'date' },
            native: {},
          });
          await this.setObjectNotExistsAsync(id + '.diagnostics.locationMqttStale', {
            type: 'state',
            common: { name: 'MQTT location stream stale', write: false, read: true, type: 'boolean', role: 'indicator' },
            native: {},
          });
          await this.setObjectNotExistsAsync(id + '.diagnostics.lastMqttRecovery', {
            type: 'state',
            common: { name: 'Last MQTT recovery', write: false, read: true, type: 'number', role: 'date' },
            native: {},
          });
          await this.setObjectNotExistsAsync(id + '.diagnostics.lastLocationAgeSeconds', {
            type: 'state',
            common: { name: 'Last MQTT location age', write: false, read: true, type: 'number', role: 'value', unit: 's' },
            native: {},
          });

          // There is no button.dock, and Refresh is not a mower command at all, so both take
          // the plain role. A button is written, not read: ioBroker's rule for the role, and
          // what the mower is doing is in status.vehicleState rather than in these.
          const remoteArray = [
            { command: 'Refresh', name: 'Refresh status', role: 'button' },
            { command: 'start', name: 'Start mowing', role: 'button.start' },
            { command: 'stop', name: 'Stop mowing', role: 'button.stop' },
            { command: 'pause', name: 'Pause mowing', role: 'button.pause' },
            { command: 'resume', name: 'Resume mowing', role: 'button.resume' },
            { command: 'dock', name: 'Return to dock', role: 'button' },
          ];
          for (const remote of remoteArray) {
            await this.setObjectNotExistsAsync(id + '.remote.' + remote.command, {
              type: 'state',
              common: {
                name: remote.name,
                type: 'boolean',
                role: remote.role,
                def: false,
                write: true,
                read: false,
              },
              native: {},
            });
            // The buttons of an installation from before shipped role "button" with read:true,
            // which the role does not allow. Only the three keys move; a name the user changed
            // stays theirs.
            await this.extendObjectAsync(id + '.remote.' + remote.command, {
              common: { role: remote.role, read: false, write: true },
            });
          }
          this.json2iob.parse(id + '.general', this.sanitizeKeys(device), { descriptions, states });
        }
        this.log.info('Found ' + devices.length + ' device(s)');
      })
      .catch((error) => {
        this.logApiError('getDeviceList error', error);
      });
  }

  updateDevices() {
    if (this.deviceArray.length === 0) {
      return Promise.resolve();
    }
    if (!this.session.access_token) {
      this.log.warn('No access token available. Please login first.');
      return Promise.resolve();
    }

    return this.requestClient({
      method: 'post',
      url: '/openapi/smarthome/getVehicleStatus',
      headers: this.getAuthHeaders(),
      data: {
        devices: this.deviceArray.map((id) => ({ id: id })),
      },
    })
      .then((res) => {
        this.log.debug(JSON.stringify(res.data));
        if (!res.data || res.data.code !== 1) {
          this.notePollFailure(
            'updateDevices failed',
            (res.data && res.data.desc) || JSON.stringify(res.data),
          );
          return;
        }
        this.notePollSuccess();
        const devices = res.data.data?.payload?.devices || [];

        for (const deviceData of devices) {
          const raw = deviceData.id || deviceData.device_id;
          if (!raw) {
            continue;
          }
          const id = this.deviceObjectId(raw);
          if (!this.deviceArray.includes(id)) {
            continue;
          }

          // Derive battery from capacityRemaining[].rawValue since getVehicleStatus
          // does not carry a direct battery field; battery would otherwise only
          // update via MQTT state pushes which are unreliable.
          // Prefer entries marked as PERCENTAGE; fall back to the first entry
          // (Segway's API only returns the battery percentage here in practice).
          if (deviceData.battery == null && Array.isArray(deviceData.capacityRemaining)) {
            /** @type {number | null} */
            let v = null;
            for (const item of deviceData.capacityRemaining) {
              if (item && String(item.unit || '').toUpperCase() === 'PERCENTAGE') {
                const n = Number(item.rawValue);
                if (Number.isFinite(n)) { v = n; break; }
              }
            }
            if (v == null && deviceData.capacityRemaining[0]) {
              const n = Number(deviceData.capacityRemaining[0].rawValue);
              if (Number.isFinite(n)) v = n;
            }
            if (v != null) deviceData.battery = v;
          }

          // getVehicleStatus answers from a server-side cache that runs a minute or two
          // behind - it reported "isDocked" for a mower that had been mowing for a while.
          // Starting the poll later does not make its answer newer, so as long as the state
          // channel is talking at all, it owns this field and the poll keeps out of it.
          // Once the channel falls quiet - which it does while the mower is docked - the
          // cache has long caught up and the poll takes over again.
          const stateChannelAge = Date.now() - (this.lastStateChannelAt[id] || 0);
          if (deviceData.vehicleState != null && stateChannelAge < STATE_CHANNEL_TRUST_MS && this.lastVehicleState[id]) {
            if (deviceData.vehicleState !== this.lastVehicleState[id]) {
              this.log.debug(
                `Keeping vehicleState "${this.lastVehicleState[id]}" for ${id}: the state channel spoke ` +
                  `${Math.round(stateChannelAge / 1000)}s ago, the poll still says "${deviceData.vehicleState}"`,
              );
            }
            // Overwritten rather than dropped, so status.json stays complete.
            deviceData.vehicleState = this.lastVehicleState[id];
          }

          this.lastStatusUpdate = Date.now();
          this.setState(id + '.status.json', JSON.stringify(deviceData), true);

          this.json2iob.parse(id + '.status', this.sanitizeKeys(deviceData), {
            forceIndex: true,
            channelName: 'Status',
            descriptions,
            states,
          });

          if (deviceData.vehicleState != null) {
            this.checkLocationWatchdog(id, deviceData.vehicleState);
          }
        }
      })
      .catch((error) => {
        if (error.response && error.response.status === 401) {
          this.log.warn('Token expired (401). Trying refresh...');
          this.setState('info.connection', false, true);
          this.handleTokenRefresh();
          return;
        }
        this.notePollFailure('updateDevices error', error);
      });
  }

  /**
   * MQTT-only fallback: pull the status over HTTP when the MQTT state channel has
   * gone quiet. Without this, battery and vehicleState freeze while the mower is
   * docked, because the broker only pushes the state channel during operation.
   *
   * @returns {Promise<void>} once the poll it decided on has come back
   */
  async pollIfStatusStale() {
    const age = Date.now() - this.lastStatusUpdate;
    if (age < STATUS_STALE_MS) {
      return;
    }
    this.log.debug('No MQTT status update for ' + Math.round(age / 60000) + ' min, falling back to HTTP poll');
    // Count the attempt, not just the success. A failing poll otherwise leaves the
    // timestamp stale and this check would retry every minute instead of every 15.
    this.lastStatusUpdate = Date.now();
    await this.pollDevices('status stale');
  }

  /**
   * The next poll, armed only once the one before it has come back. A cycle that outruns
   * its interval - a cloud answering slowly, a network stack hung past the request timeout -
   * would otherwise have the next one start on top of it.
   *
   * @param {number} ms how long to wait between the end of one poll and the start of the next
   * @param {'interval' | 'status stale'} reason which of the two loops this is
   */
  schedulePoll(ms, reason) {
    this.pollTimeout = this.setTimeout(async () => {
      try {
        if (reason === 'interval') {
          await this.pollDevices('interval');
        } else {
          await this.pollIfStatusStale();
        }
      } finally {
        if (!this.unloading) {
          this.schedulePoll(ms, reason);
        }
      }
    }, ms);
  }

  async pollDevices(reason) {
    const isManual = reason === 'manual refresh';
    // Stale-lock recovery: if a previous poll has been "running" for too long
    // (e.g. network stack hung past axios timeout), force-release the lock.
    // The old poll's finally{} won't touch the new lock because it compares tokens.
    if (this.httpPollRunning && this.httpPollStartedAt && Date.now() - this.httpPollStartedAt > 60000) {
      this.log.warn('HTTP status poll lock stuck for >60s, force-releasing');
      this.httpPollRunning = false;
      this.httpPollStartedAt = 0;
    }
    if (this.httpPollRunning && !isManual) {
      this.log.debug('Skipping HTTP status poll (' + reason + '), previous poll still running');
      return;
    }
    // Each poll gets its own token. Only the owner of the current token may
    // release the lock — prevents stale-recovered or overlapping polls from
    // clobbering a fresh lock.
    const token = ++this.httpPollToken;
    const ownsLock = !this.httpPollRunning;
    if (ownsLock) {
      this.httpPollRunning = true;
      this.httpPollStartedAt = Date.now();
    } else {
      this.log.debug('Manual refresh bypassing poll lock');
    }
    try {
      this.log.debug(reason === 'interval' ? 'Running periodic HTTP status poll' : 'Running HTTP status poll (' + reason + ')');
      // Discovery failing at startup - ioBroker up before the network is - used to leave the
      // adapter idle for good: an empty device list makes updateDevices and connectMqtt both
      // return at once, and nothing ever looked again. The poll is the retry, so this needs no
      // timer of its own. It runs on the configured interval, and where polling is switched
      // off the stale-status check drives it instead.
      if (!this.deviceArray.length) {
        this.log.debug('No devices known, looking again before polling');
        await this.getDeviceList();
        // Only once devices are known is there anything to subscribe to, and only without a
        // client already built: connectMqtt makes a new one every time it is called.
        if (this.deviceArray.length && !this.mqttClient) {
          await this.connectMqtt();
        }
      }
      await this.updateDevices();
    } catch (error) {
      this.notePollFailure('HTTP status poll failed (' + reason + ')', error);
    } finally {
      if (ownsLock && this.httpPollToken === token) {
        this.httpPollRunning = false;
        this.httpPollStartedAt = 0;
      }
    }
  }

  sendMowerCommand(deviceId, commandName) {
    const mapping = COMMAND_MAP[commandName];
    if (!mapping) {
      this.log.error('Unknown command: ' + commandName);
      return Promise.resolve();
    }

    const execution = { command: mapping.command };
    if (mapping.params) {
      execution.params = mapping.params;
    }

    this.log.info('Sending command "' + commandName + '" to device ' + deviceId);
    this.log.debug('Command payload: ' + JSON.stringify(execution));

    return this.requestClient({
      method: 'post',
      url: '/openapi/smarthome/sendCommands',
      headers: this.getAuthHeaders(),
      data: {
        commands: [
          {
            devices: [{ id: deviceId }],
            execution: execution,
          },
        ],
      },
    })
      .then((res) => {
        this.log.debug(JSON.stringify(res.data));
        if (!res.data || res.data.code !== 1) {
          this.log.error(
            'Command failed: ' + ((res.data && res.data.desc) || JSON.stringify(res.data)),
          );
          return;
        }
        const results = res.data.data?.payload?.commands || [];
        for (const result of results) {
          if (result.status === 'ERROR' && result.errorCode !== 'alreadyInState') {
            this.log.error('Command error: ' + (result.errorCode || 'unknown'));
          }
        }
        this.log.info('Command "' + commandName + '" sent successfully');
        this.refreshTimeout && this.clearTimeout(this.refreshTimeout);
        this.refreshTimeout = this.setTimeout(() => {
          this.pollDevices('post-command');
        }, 5 * 1000);
      })
      .catch((error) => {
        if (error.response && error.response.status === 401) {
          this.log.warn('Token expired (401). Trying refresh...');
          this.setState('info.connection', false, true);
          this.handleTokenRefresh();
          return;
        }
        this.logApiError('sendCommand error', error);
      });
  }

  // ---- State Changes ----

  onStateChange(id, state) {
    if (!state) {
      return;
    }
    const parts = id.split('.');
    const deviceId = parts[2];
    const channel = parts[3];
    const command = parts[4];

    // ack:true = the adapter's own write, the mower reporting where it stands
    if (state.ack) {
      // Only track vehicleState for map history reset to avoid cross-field false transitions
      if (channel === 'status' && command === 'vehicleState') {
        const newState = String(state.val);
        const prevState = this.lastVehicleState[deviceId];
        this.lastVehicleState[deviceId] = newState;
        if (newState !== prevState) {
          this.log.debug(`vehicleState transition: "${prevState || 'unknown'}" -> "${newState}"`);
        }
        // Everything the transition is read for - clearing the map, marking where a session
        // started, locating the charging station - is the map's business and stops with it.
        if (newState !== prevState && this.config.mapEnabled) {
          if (SESSION_END_STATES.has(prevState) && this.isLocationActiveState(newState)) {
            if (this.lastMowingPercentage[deviceId] == null) {
              // Fallback for mowers that never send a mowing progress with their positions:
              // without one nothing would ever clear the map and the tracks of all sessions
              // would pile up in the same picture. Where there is a progress it decides alone -
              // it can tell a resumed session from a new one, which the state cannot.
              this.resetMap(
                deviceId,
                `new mowing session ("${prevState}" -> "${newState}"), no mowing progress reported`,
              );
            } else {
              // The mower is leaving the dock, and whether that starts a new session or carries
              // on with the one it went to charge from only the progress can say - which for
              // about a minute still reports the session before. Mark where the track stands,
              // so whatever is driven until then survives the reset instead of going with the
              // session that ended.
              this.sessionStart[deviceId] = { index: this.locationHistory[deviceId]?.length || 0, at: Date.now() };
              this.log.debug(`Waiting for the mowing progress to tell whether ${deviceId} starts a new session`);
            }
          }
          // Arrived in the dock: the position it reported getting there is the station's.
          if (SESSION_END_STATES.has(newState)) {
            this.recordDockPosition(deviceId);
            // The session is over, so no further position will trigger the throttled render -
            // whatever it is holding back is the last picture of the session and is due now.
            this.renderMapNow(deviceId);
          }
        }
      }
      return;
    }

    // ack:false = user action -> handle remote commands
    if (channel === 'dockPosition') {
      this.setDockPosition(deviceId, state.val);
      return;
    }
    if (channel !== 'remote') {
      return;
    }

    this.log.debug('Remote command triggered: ' + command + ' for device ' + deviceId);

    if (command === 'Refresh') {
      this.pollDevices('manual refresh');
      return;
    }

    if (COMMAND_MAP[command]) {
      this.sendMowerCommand(deviceId, command);
    } else {
      this.log.warn('Unknown remote command: ' + command);
    }
  }

  async onUnload(callback) {
    try {
      this.log.debug('Adapter unloading, cleaning up...');
      this.unloading = true;
      this.setState('info.connection', false, true);
      this.disconnectMqtt();
      this.pollTimeout && this.clearTimeout(this.pollTimeout);
      this.refreshTokenTimeout && this.clearTimeout(this.refreshTokenTimeout);
      this.refreshTimeout && this.clearTimeout(this.refreshTimeout);
      for (const timeout of Object.values(this.mapRenderTimeout)) {
        timeout && this.clearTimeout(timeout);
      }
      this.mqttRetryTimeout && this.clearTimeout(this.mqttRetryTimeout);
      // Awaited, not fired and forgotten: this write keeps the points collected since the
      // last periodic one, and the adapter is about to stop. Last, so a failing write
      // cannot skip the cleanup above.
      await Promise.all(Object.keys(this.locationHistory).map((deviceId) => this.saveMapTrack(deviceId, true)));
      callback();
    } catch {
      callback();
    }
  }
}

if (require.main !== module) {
  // One assignment, so this stays a plain export: the class rides along on the factory, for a
  // test that drives a single method without an adapter instance.
  module.exports = Object.assign((options) => new Navimow(options), { Navimow });
} else {
  new Navimow();
}
