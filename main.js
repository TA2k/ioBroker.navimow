'use strict';

const utils = require('@iobroker/adapter-core');
const axios = require('axios');
const Json2iob = require('json2iob');
const crypto = require('node:crypto');
const mqtt = require('mqtt');
const { URL } = require('node:url');
const { createCanvas } = require('@napi-rs/canvas');
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
const ACTIVE_LOCATION_STATES = new Set(['isRunning', 'mowing', 'isMowing', 'isMapping', 'mapping']);

// How long the MQTT state channel keeps the mower state to itself after it last spoke.
// Comfortably more than the minute or two getVehicleStatus runs behind, so a poll landing
// in between cannot put an older state back on display.
const STATE_CHANNEL_TRUST_MS = 3 * 60 * 1000;

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

// How often at most the mowing track is written to its state while the mower is out.
const MAP_TRACK_SAVE_MS = 30 * 1000;

// Mowing map: the longer edge of the rendered image in pixels. The shorter edge follows from
// the shape of the frame, because the image covers exactly the frame and nothing besides.
const MAP_SIZE_PX = 800;
// The frame is widened this far past the point that triggered it and snapped to whole metres,
// so it jumps ahead of the mower and settles instead of nudging on every location message.
const MAP_FRAME_MARGIN_M = 2;
// A mower drives well under a metre per second and reports its position every couple of
// seconds, so a step this large is not driving. It is either a stray position, or the mower
// really is somewhere else - the next message decides which.
const LOCATION_JUMP_MAX_M = 10;

// Command mapping: name -> { command, params }
const COMMAND_MAP = {
  start: { command: 'action.devices.commands.StartStop', params: { on: true } },
  stop: { command: 'action.devices.commands.StartStop', params: { on: false } },
  pause: { command: 'action.devices.commands.PauseUnpause', params: { on: false } },
  resume: { command: 'action.devices.commands.PauseUnpause', params: { on: true } },
  dock: { command: 'action.devices.commands.Dock', params: null },
};

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
    this.updateInterval = null;
    this.statusStaleInterval = null;
    this.lastStatusUpdate = 0;
    this.refreshTokenTimeout = null;
    this.refreshTimeout = undefined;
    this.mqttRetryTimeout = null;
    this.mqttClient = null;
    this.mqttConnected = false;
    this.mqttRefreshing = false;
    this.mqttErrorCount = 0;
    this.lastMqttMessage = 0;
    this.lastLocationMessage = {};
    this.lastLocationRecovery = {};
    this.locationRecoveryRunning = false;
    this.runningSince = {};
    this.locationMqttStale = {};
    this.locationHistory = {};
    this.lastMowingPercentage = {};
    this.sessionStart = {};
    this.lastStateChannelAt = {};
    this.lastTrackSave = {};
    this.mapFrame = {};
    this.pendingLocation = {};
    this.lastLocation = {};
    this.lastVehicleState = {};
    this.lastMapRender = 0;
    this.mapRenderTimeout = null;
    this.httpPollRunning = false;
    this.httpPollStartedAt = 0;
    this.httpPollToken = 0;
  }

  async onReady() {
    this.setState('info.connection', false, true);
    const configuredInterval = Number(this.config.interval);
    if (!Number.isFinite(configuredInterval) || configuredInterval < 0) {
      this.log.info('Invalid interval, defaulting to 5 minutes');
      this.config.interval = 5;
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
      this.log.debug('Auth code input: ' + authCode.substring(0, 20) + '...');
      // Extract code from full URL if user pasted the entire redirect URL
      if (authCode.startsWith('http')) {
        try {
          const parsed = new URL(authCode);
          authCode = parsed.searchParams.get('code') || authCode;
          this.log.debug('Extracted code from URL: ' + authCode.substring(0, 20) + '...');
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
        this.log.debug('Access token starts with: ' + tokenObj.access_token.substring(0, 20) + '...');
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
          this.updateInterval = this.setInterval(() => this.pollDevices('interval'), pollMs);
        } else {
          this.log.info(
            'Periodic HTTP status polling disabled (interval=0). Relying on MQTT, with an HTTP fallback poll after ' +
              Math.round(STATUS_STALE_MS / 60000) +
              ' minutes without a status update.',
          );
          this.statusStaleInterval = this.setInterval(() => this.pollIfStatusStale(), STATUS_STALE_CHECK_MS);
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
          keepalive: 2400,
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
            const topics = [
              '/downlink/vehicle/' + deviceId + '/realtimeDate/state',
              '/downlink/vehicle/' + deviceId + '/realtimeDate/event',
              '/downlink/vehicle/' + deviceId + '/realtimeDate/attributes',
              '/downlink/vehicle/' + deviceId + '/realtimeDate/location',
              '/downlink/vehicle/' + deviceId + '/#',
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
          if (this.mqttErrorCount === 1) {
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
          if (this.mqttConnected) {
            this.log.info('MQTT connection closed');
          }
          this.mqttConnected = false;
          if (!this.mqttRefreshing) {
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
        this.log.warn('MQTT setup failed: ' + error.message);
        error.response && this.log.debug(JSON.stringify(error.response.data));
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

  handleMqttMessage(topic, payload) {
    try {
      const parts = topic.split('/').filter((p) => p !== '');
      // Expected: downlink/vehicle/{device_id}/.../{channel}
      if (parts.length < 4 || parts[0] !== 'downlink' || parts[1] !== 'vehicle') {
        this.log.debug('MQTT unknown topic: ' + topic);
        return;
      }
      const deviceId = parts[2];
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
        // The progress is late, though: for about a minute after leaving the dock the mower
        // still reports the one of the session before. `sessionStart` holds where the track
        // stood when it left, set on the state change, so the positions driven in that minute
        // survive the reset the progress asks for once it catches up.
        const pendingStart = this.sessionStart[deviceId];
        let resetAt = -1;
        let resetFrom;
        // Whether the progress has said what the pending session start is: a restart answers
        // "a new one", a rise above the last progress answers "the one it went to charge from".
        let decided = false;
        // Only a fraction of the location messages carry a progress at all - the mower sends
        // its position every two seconds and the progress roughly once a percent, in a message
        // of its own. Without this the value carried over from the last one would be reported
        // and stored again with every position, as if the mower had just said it.
        let reported = false;
        let progress = this.lastMowingPercentage[deviceId];
        for (let i = 0; i < points.length; i++) {
          const p = points[i];
          if (!p || p.mowingPercentage == null) continue;
          const percentage = Number(p.mowingPercentage);
          if (!Number.isFinite(percentage)) continue;
          reported = true;
          // A progress of zero only starts a session while there is nothing to compare it
          // against. Once it is known, the drop is what counts: the mower reports zero from
          // leaving the dock until the first percent is done, which on a large lawn is
          // minutes of positions, and treating every one of them as a fresh start would
          // throw the track away again with each message.
          if (progress == null ? percentage === 0 : percentage < progress) {
            resetAt = i;
            resetFrom = progress;
            decided = true;
          } else if (progress != null && percentage > progress) {
            decided = true;
          }
          progress = percentage;
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
        if (resetAt >= 0) {
          const to = Number(points[resetAt].mowingPercentage);
          this.resetMap(deviceId, `mowing progress restarted (${resetFrom ?? 'unknown'}% -> ${to}%)`, pendingStart?.index);
          // Only without a pending session start do the points ahead of the restart belong to
          // the session that ended. With one they were all driven after the mower left the
          // dock, and the progress they carry is the stale one of the session before.
          if (!pendingStart) {
            points = points.slice(resetAt);
          }
        } else if (reported) {
          const stale = pendingStart ? ', still the one of the session before?' : '';
          this.log.debug(`Mowing progress for ${deviceId}: ${progress}%${stale}`);
        }
        if (decided) {
          delete this.sessionStart[deviceId];
        }

        if (!this.locationHistory[deviceId]) {
          this.locationHistory[deviceId] = [];
        }
        const history = this.locationHistory[deviceId];
        const prevLen = history.length;
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
                this.pendingLocation[deviceId] = { x, y };
                this.log.debug(
                  `Holding back position x=${x} y=${y} for ${deviceId}: ` +
                    `${Math.hypot(x - last.x, y - last.y).toFixed(1)} m from the last one`,
                );
                continue;
              }
              this.log.debug(`Position x=${x} y=${y} for ${deviceId} confirmed by a second message, taking it`);
              history.push(pending);
              // The confirmed one is now the last point, so an identical reading is not
              // pushed a second time below.
              last = pending;
            }
            this.pendingLocation[deviceId] = undefined;
            if (!last || last.x !== x || last.y !== y) {
              history.push({ x, y });
            }
            this.lastLocation[deviceId] = { x, y };
          }
        }
        if (history.length > prevLen) {
          const now = Date.now();
          if (!this.lastMapRender || now - this.lastMapRender >= 1000) {
            this.lastMapRender = now;
            this.renderMap(deviceId);
          } else if (!this.mapRenderTimeout) {
            this.mapRenderTimeout = this.setTimeout(() => {
              this.mapRenderTimeout = null;
              this.lastMapRender = Date.now();
              this.renderMap(deviceId);
            }, 1000 - (now - this.lastMapRender));
          }
        }
        if (history.length > 5000) {
          history.splice(0, history.length - 5000);
        }
      }

      // Arrays: use last entry (e.g. location)
      if (Array.isArray(data)) {
        data = data[data.length - 1];
        if (!data) return;
      }

      const folderName = channel === 'state' ? 'status' : channel;
      this.json2iob.parse(deviceId + '.' + folderName, data, {
        forceIndex: true,
        channelName: folderName.charAt(0).toUpperCase() + folderName.slice(1),
        descriptions,
        states,
      });
    } catch (e) {
      this.log.error('MQTT message parse error: ' + e.message);
    }
  }

  /**
   * Map vehicleState to the active remote command
   * @param {string} deviceId
   * @param {string} vehicleState
   */
  updateRemoteStates(deviceId, vehicleState) {
    const stateToRemote = {
      isRunning: 'start',
      mowing: 'start',
      isPaused: 'pause',
      paused: 'pause',
      isDocking: 'dock',
      returning: 'dock',
      isDocked: 'dock',
      docked: 'dock',
      charging: 'dock',
      isIdle: 'stop',
      isIdel: 'stop',
      idle: 'stop',
    };
    const activeCmd = stateToRemote[vehicleState] || null;
    for (const cmd of Object.keys(COMMAND_MAP)) {
      this.setState(deviceId + '.remote.' + cmd, cmd === activeCmd, true);
    }
  }

  renderMap(deviceId) {
    const points = this.locationHistory[deviceId]?.slice();
    if (!points || points.length < 2) return;
    this.log.debug(`Rendering map for ${deviceId}: ${points.length} points`);

    const frame = this.growMapFrame(deviceId, points);

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
    if (color) {
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

    // Start marker (blue)
    const first = points[0];
    ctx.fillStyle = '#4488ff';
    ctx.beginPath();
    ctx.arc(projectX(first.x), projectY(first.y), 5, 0, Math.PI * 2);
    ctx.fill();

    // Current position marker (red)
    const last = points[points.length - 1];
    ctx.fillStyle = '#ff4444';
    ctx.beginPath();
    ctx.arc(projectX(last.x), projectY(last.y), 5, 0, Math.PI * 2);
    ctx.fill();

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
   * track: locationHistory is capped at 5000 points, so a long session keeps the length at
   * 5000 while the contents shift, and a length comparison would stop saving right where
   * this matters most. Every arriving position is pushed as a new object, so the identity
   * of the last one changes exactly when the track does.
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
      points: points.map((p) => [Math.round(p.x * 100) / 100, Math.round(p.y * 100) / 100]),
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
    const points = track.points
      .filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
      .map((p) => ({ x: p[0], y: p[1] }));
    if (!points.length) return;
    this.locationHistory[deviceId] = points;
    // The track on disk is what was just loaded, so nothing needs writing back.
    this.lastTrackSave[deviceId] = { at: Date.now(), last: points[points.length - 1] };
    this.log.info(`Restored mowing track for ${deviceId}: ${points.length} points`);
    // Draw it straight away, so the map is there before the mower moves again.
    this.renderMap(deviceId);
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
      let timeoutHandle = null;
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
      timeoutHandle = this.setTimeout(finish, 2000);
    }));
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
   *   track - so anything but undefined counts.
   */
  resetMap(deviceId, reason, keepFrom) {
    const history = this.locationHistory[deviceId] || [];
    const had = history.length;
    const keep = keepFrom == null ? [] : history.slice(Math.min(keepFrom, had));
    this.locationHistory[deviceId] = keep;
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
    this.setState(deviceId + '.map', '', true);
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

  async refreshMqttCredentials() {
    if (this.mqttRefreshing) return;
    this.mqttRefreshing = true;
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
        this.log.error('Token exchange error: ' + error.message);
        error.response && this.log.error(JSON.stringify(error.response.data));
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
        this.log.warn('Token refresh returned no token: ' + JSON.stringify(res.data));
        return null;
      })
      .catch((error) => {
        this.log.warn('Token refresh failed: ' + error.message);
        error.response && this.log.debug(JSON.stringify(error.response.data));
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
    }
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
          const id = device.id;
          if (!id) {
            continue;
          }
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
            common: { name: 'Mowing Map frame (world bounds and pixel geometry JSON)', write: false, read: true, type: 'string', role: 'json' },
            native: {},
          });
          // Before the track: loading it renders the map, which needs the frame.
          await this.loadMapFrame(id);
          await this.loadMapTrack(id);
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

          const remoteArray = [
            { command: 'Refresh', name: 'Refresh status' },
            { command: 'start', name: 'Start mowing' },
            { command: 'stop', name: 'Stop mowing' },
            { command: 'pause', name: 'Pause mowing' },
            { command: 'resume', name: 'Resume mowing' },
            { command: 'dock', name: 'Return to dock' },
          ];
          for (const remote of remoteArray) {
            await this.setObjectNotExistsAsync(id + '.remote.' + remote.command, {
              type: 'state',
              common: {
                name: remote.name,
                type: 'boolean',
                role: 'button',
                def: false,
                write: true,
                read: true,
              },
              native: {},
            });
          }
          this.json2iob.parse(id + '.general', device, { descriptions, states });
        }
        this.log.info('Found ' + devices.length + ' device(s)');
      })
      .catch((error) => {
        this.log.error('getDeviceList error: ' + error.message);
        error.response && this.log.error(JSON.stringify(error.response.data));
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
          this.log.error(
            'updateDevices failed: ' + ((res.data && res.data.desc) || JSON.stringify(res.data)),
          );
          return;
        }
        const devices = res.data.data?.payload?.devices || [];

        for (const deviceData of devices) {
          const id = deviceData.id || deviceData.device_id;
          if (!id || !this.deviceArray.includes(id)) {
            continue;
          }

          // Derive battery from capacityRemaining[].rawValue since getVehicleStatus
          // does not carry a direct battery field; battery would otherwise only
          // update via MQTT state pushes which are unreliable.
          // Prefer entries marked as PERCENTAGE; fall back to the first entry
          // (Segway's API only returns the battery percentage here in practice).
          if (deviceData.battery == null && Array.isArray(deviceData.capacityRemaining)) {
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

          this.json2iob.parse(id + '.status', deviceData, {
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
        this.log.error('updateDevices error: ' + error.message);
        error.response && this.log.error(JSON.stringify(error.response.data));
      });
  }

  /**
   * MQTT-only fallback: pull the status over HTTP when the MQTT state channel has
   * gone quiet. Without this, battery and vehicleState freeze while the mower is
   * docked, because the broker only pushes the state channel during operation.
   */
  pollIfStatusStale() {
    const age = Date.now() - this.lastStatusUpdate;
    if (age < STATUS_STALE_MS) {
      return;
    }
    this.log.debug('No MQTT status update for ' + Math.round(age / 60000) + ' min, falling back to HTTP poll');
    // Count the attempt, not just the success. A failing poll otherwise leaves the
    // timestamp stale and this check would retry every minute instead of every 15.
    this.lastStatusUpdate = Date.now();
    this.pollDevices('status stale');
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
      await this.updateDevices();
    } catch (error) {
      this.log.error('HTTP status poll failed (' + reason + '): ' + (error && error.message ? error.message : error));
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
        this.log.error('sendCommand error: ' + error.message);
        error.response && this.log.error(JSON.stringify(error.response.data));
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

    // ack:true = device confirmed value -> reset remote buttons on state change
    if (state.ack) {
      if (channel === 'status' && (command === 'vehicleState' || command === 'state' || command === 'status')) {
        const newState = String(state.val);
        this.updateRemoteStates(deviceId, newState);
      }
      // Only track vehicleState for map history reset to avoid cross-field false transitions
      if (channel === 'status' && command === 'vehicleState') {
        const newState = String(state.val);
        const prevState = this.lastVehicleState[deviceId];
        this.lastVehicleState[deviceId] = newState;
        if (newState !== prevState) {
          this.log.debug(`vehicleState transition: "${prevState || 'unknown'}" -> "${newState}"`);
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
        }
      }
      return;
    }

    // ack:false = user action -> handle remote commands
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
      this.setState('info.connection', false, true);
      this.disconnectMqtt();
      this.updateInterval && this.clearInterval(this.updateInterval);
      this.statusStaleInterval && this.clearInterval(this.statusStaleInterval);
      this.refreshTokenTimeout && this.clearTimeout(this.refreshTokenTimeout);
      this.refreshTimeout && this.clearTimeout(this.refreshTimeout);
      this.mapRenderTimeout && this.clearTimeout(this.mapRenderTimeout);
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
  module.exports = (options) => new Navimow(options);
} else {
  new Navimow();
}
