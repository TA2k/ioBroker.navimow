'use strict';

const utils = require('@iobroker/adapter-core');
const axios = require('axios');
const Json2iob = require('json2iob');
const crypto = require('crypto');
const mqtt = require('mqtt');
const { URL } = require('url');
const { createCanvas } = require('@napi-rs/canvas');
const descriptions = require('./lib/descriptions.json');
const states = require('./lib/states.json');
const { parseTopic, hasMowingReset, appendLocationPoints } = require('./lib/mqttParse');

const API_BASE_URL = 'https://navimow-fra.ninebot.com';
const OAUTH2_TOKEN_URL = API_BASE_URL + '/openapi/oauth/getAccessToken';
const CLIENT_ID = 'homeassistant';
const CLIENT_SECRET = '57056e15-722e-42be-bbaa-b0cbfb208a52';
const REDIRECT_URI = 'http://localhost:1/callback';


// MQTT keepalive in seconds. mqtt.js only detects a dead socket through its keepalive
// pings, so this doubles as the upper bound for noticing a half-open connection.
const MQTT_KEEPALIVE_S = 60;
const MAP_POINT_LIMIT = 5000;
const MAP_RENDER_MIN_INTERVAL_MS = 1000;

// Location MQTT watchdog
const LOCATION_STALE_MS = 3 * 60 * 1000;
const LOCATION_RECOVERY_COOLDOWN_MS = 5 * 60 * 1000;
const ACTIVE_LOCATION_STATES = new Set(['isRunning', 'mowing', 'isMowing', 'isMapping', 'mapping']);

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
    this.refreshTokenTimeout = null;
    this.refreshTimeout = undefined;
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
    this.lastVehicleState = {};
    // Map rendering is throttled per device, otherwise a second mower silently
    // loses its scheduled render to the first one.
    this.lastMapRender = {};
    this.mapRenderTimeout = {};
    this.unloaded = false;
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
          this.log.info('Periodic HTTP status polling disabled (interval=0). Relying on MQTT for updates.');
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
    if (this.unloaded) {
      return Promise.resolve();
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
        this.log.debug('MQTT info: ' + JSON.stringify(res.data));
        if (!res.data || res.data.code !== 1) {
          this.log.warn('Failed to get MQTT info: ' + JSON.stringify(res.data));
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

        this.log.debug('MQTT info raw: ' + JSON.stringify(mqttInfo));

        let brokerUrl;
        const mqttOpts = {
          clientId: 'web_' + (mqttUsername || 'iobroker') + '_' + crypto.randomUUID().replace(/-/g, '').substring(0, 10),
          keepalive: MQTT_KEEPALIVE_S,
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
            // rejectUnauthorized belongs into wsOptions for the ws transport;
            // as a top level option it only applies to mqtts and was a no-op here.
            mqttOpts.wsOptions = {
              headers: { Authorization: 'Bearer ' + this.session.access_token },
              rejectUnauthorized: true,
            };
          } catch {
            // Fallback: treat mqttUrl as ws path
            brokerUrl = 'wss://' + mqttHost + ':443' + mqttUrlRaw;
            mqttOpts.wsOptions = {
              headers: { Authorization: 'Bearer ' + this.session.access_token },
              rejectUnauthorized: true,
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
          // One wildcard subscription per device. The explicit realtimeDate/* topics it
          // replaces were covered by it anyway, and brokers deliver one copy per matching
          // subscription - which doubled every state write and every map point.
          for (const deviceId of this.deviceArray) {
            const topic = '/downlink/vehicle/' + deviceId + '/#';
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
          if (!this.mqttRefreshing && !this.unloaded) {
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
      });
  }

  handleMqttMessage(topic, payload) {
    try {
      const parsed = parseTopic(topic);
      if (!parsed) {
        this.log.debug('MQTT unknown topic: ' + topic);
        return;
      }
      const { deviceId, channel } = parsed;

      if (!this.deviceArray.includes(deviceId)) {
        this.log.debug('MQTT message for unknown device: ' + deviceId);
        return;
      }

      if (channel === 'location') {
        const now = Date.now();
        this.lastLocationMessage[deviceId] = now;
        this.setStateSafe(deviceId + '.diagnostics.lastLocationMessage', now);
        this.setStateSafe(deviceId + '.diagnostics.lastLocationAgeSeconds', 0);
        if (this.locationMqttStale[deviceId]) {
          this.locationMqttStale[deviceId] = false;
          this.setStateSafe(deviceId + '.diagnostics.locationMqttStale', false);
          this.log.info('MQTT location stream recovered: device=' + deviceId);
        }
      }

      let data = JSON.parse(payload.toString());

      this.log.debug('MQTT ' + channel + ' for ' + deviceId + ': ' + JSON.stringify(data));

      // state channel: also store raw JSON
      if (channel === 'state') {
        this.setStateSafe(deviceId + '.status.json', JSON.stringify(data));
      }

      // location channel: collect points and render map
      if (channel === 'location') {
        const points = Array.isArray(data) ? data : [data];

        // Reset map when mowingPercentage=0 arrives (before collecting new points)
        if (hasMowingReset(points) && this.locationHistory[deviceId]?.length > 0) {
          this.log.info(`mowingPercentage=0 via MQTT, resetting map for ${deviceId}`);
          this.locationHistory[deviceId] = [];
          this.setStateSafe(deviceId + '.map', '');
        }

        if (!this.locationHistory[deviceId]) {
          this.locationHistory[deviceId] = [];
        }
        if (appendLocationPoints(this.locationHistory[deviceId], points, MAP_POINT_LIMIT) > 0) {
          this.scheduleMapRender(deviceId);
        }
      }

      // Arrays: use last entry (e.g. location)
      if (Array.isArray(data)) {
        data = data[data.length - 1];
        if (!data) return;
      }

      const folderName = channel === 'state' ? 'status' : channel;
      this.json2iob
        .parse(deviceId + '.' + folderName, data, {
          forceIndex: true,
          channelName: folderName.charAt(0).toUpperCase() + folderName.slice(1),
          descriptions,
          states,
        })
        .catch((e) => this.log.warn('MQTT ' + channel + ' state write failed: ' + e.message));
    } catch (e) {
      this.log.error('MQTT message parse error: ' + e.message);
    }
  }

  /**
   * Write an acknowledged state without leaving an unhandled rejection behind.
   * A rejected setState (restarting states DB, unloading adapter) would otherwise
   * kill the adapter process.
   *
   * @param {string} id state id relative to the adapter namespace
   * @param {any} value value to write
   */
  setStateSafe(id, value) {
    this.setState(id, value, true).catch((e) => this.log.debug('setState ' + id + ' failed: ' + e.message));
  }

  /**
   * Render the map at most once per MAP_RENDER_MIN_INTERVAL_MS and per device.
   *
   * @param {string} deviceId device the path belongs to
   */
  scheduleMapRender(deviceId) {
    if (this.unloaded || this.mapRenderTimeout[deviceId]) {
      return;
    }
    const now = Date.now();
    const last = this.lastMapRender[deviceId] || 0;
    const waitMs = MAP_RENDER_MIN_INTERVAL_MS - (now - last);
    if (waitMs <= 0) {
      this.lastMapRender[deviceId] = now;
      this.renderMap(deviceId);
      return;
    }
    this.mapRenderTimeout[deviceId] = this.setTimeout(() => {
      delete this.mapRenderTimeout[deviceId];
      this.lastMapRender[deviceId] = Date.now();
      this.renderMap(deviceId);
    }, waitMs);
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
      this.setStateSafe(deviceId + '.remote.' + cmd, cmd === activeCmd);
    }
  }

  renderMap(deviceId) {
    const points = this.locationHistory[deviceId]?.slice();
    if (!points || points.length < 2) return;
    this.log.debug(`Rendering map for ${deviceId}: ${points.length} points`);

    const size = 800;
    const padding = 50;

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }

    const rangeX = maxX - minX || 1;
    const rangeY = maxY - minY || 1;
    const drawArea = size - 2 * padding;
    const scaleX = drawArea / rangeX;
    const scaleY = drawArea / rangeY;

    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d');

    // Grid
    ctx.strokeStyle = 'rgba(100,100,100,0.3)';
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 10; i++) {
      const pos = padding + (drawArea / 10) * i;
      ctx.beginPath();
      ctx.moveTo(pos, padding);
      ctx.lineTo(pos, size - padding);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(padding, pos);
      ctx.lineTo(size - padding, pos);
      ctx.stroke();
    }

    // Draw path with gradient from start (blue) to current (green)
    // Y-flip only: real-world Y grows up, canvas Y grows down
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (let i = 1; i < points.length; i++) {
      const t = i / (points.length - 1);
      const g = Math.round(120 + 135 * t);
      const b = Math.round(255 - 155 * t);
      ctx.strokeStyle = `rgb(0,${g},${b})`;
      ctx.beginPath();
      ctx.moveTo(padding + (points[i - 1].x - minX) * scaleX, padding + (maxY - points[i - 1].y) * scaleY);
      ctx.lineTo(padding + (points[i].x - minX) * scaleX, padding + (maxY - points[i].y) * scaleY);
      ctx.stroke();
    }

    // Start marker (blue)
    const first = points[0];
    ctx.fillStyle = '#4488ff';
    ctx.beginPath();
    ctx.arc(padding + (first.x - minX) * scaleX, padding + (maxY - first.y) * scaleY, 5, 0, Math.PI * 2);
    ctx.fill();

    // Current position marker (red)
    const last = points[points.length - 1];
    ctx.fillStyle = '#ff4444';
    ctx.beginPath();
    ctx.arc(padding + (last.x - minX) * scaleX, padding + (maxY - last.y) * scaleY, 5, 0, Math.PI * 2);
    ctx.fill();

    const base64 = 'data:image/png;base64,' + canvas.toBuffer('image/png').toString('base64');
    this.setStateSafe(deviceId + '.map', base64);
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

  checkLocationWatchdog(deviceId, vehicleState) {
    const now = Date.now();
    const active = this.isLocationActiveState(vehicleState);

    if (!active) {
      this.runningSince[deviceId] = 0;
      this.locationMqttStale[deviceId] = false;
      this.setStateSafe(deviceId + '.diagnostics.locationMqttStale', false);
      const lastLocation = this.lastLocationMessage[deviceId] || 0;
      const ageSeconds = lastLocation ? Math.round((now - lastLocation) / 1000) : 0;
      this.setStateSafe(deviceId + '.diagnostics.lastLocationAgeSeconds', ageSeconds);
      return;
    }

    if (!this.runningSince[deviceId]) {
      this.runningSince[deviceId] = now;
    }

    const activeAge = now - this.runningSince[deviceId];
    const lastLocation = this.lastLocationMessage[deviceId] || 0;
    const locationAge = lastLocation ? now - lastLocation : activeAge;
    const ageSeconds = Math.round(locationAge / 1000);
    this.setStateSafe(deviceId + '.diagnostics.lastLocationAgeSeconds', ageSeconds);

    if (activeAge < LOCATION_STALE_MS || locationAge < LOCATION_STALE_MS) {
      if (this.locationMqttStale[deviceId]) {
        this.locationMqttStale[deviceId] = false;
        this.setStateSafe(deviceId + '.diagnostics.locationMqttStale', false);
      }
      return;
    }

    this.locationMqttStale[deviceId] = true;
    this.setStateSafe(deviceId + '.diagnostics.locationMqttStale', true);

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
    if (this.locationRecoveryRunning || this.unloaded) {
      this.log.debug('MQTT location recovery already running or adapter unloading, skipping device=' + deviceId);
      return;
    }

    this.locationRecoveryRunning = true;
    const now = Date.now();
    this.lastLocationRecovery[deviceId] = now;
    this.setStateSafe(deviceId + '.diagnostics.lastMqttRecovery', now);

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
    if (this.mqttRefreshing || this.unloaded) return;
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
        this.log.debug(JSON.stringify(res.data));
        if (res.data && res.data.access_token) {
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
        this.log.debug(JSON.stringify(res.data));
        if (res.data && res.data.access_token) {
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
      // Reconnect MQTT with new token. Both calls have to be awaited, otherwise the
      // new client is created while the old one is still closing and wins the race.
      this.log.debug('Reconnecting MQTT with new token...');
      await this.disconnectMqtt(true);
      await this.connectMqtt();
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
          await this.json2iob.parse(id + '.general', device, { descriptions, states });
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

          this.setStateSafe(id + '.status.json', JSON.stringify(deviceData));

          this.json2iob
            .parse(id + '.status', deviceData, {
              forceIndex: true,
              channelName: 'Status',
              descriptions,
              states,
            })
            .catch((e) => this.log.warn('Status state write failed: ' + e.message));

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
      // Set before any await: every reconnect path checks this flag, otherwise the
      // MQTT close handler rebuilds the connection while the adapter is shutting down.
      this.unloaded = true;
      this.updateInterval && this.clearInterval(this.updateInterval);
      this.refreshTokenTimeout && this.clearTimeout(this.refreshTokenTimeout);
      this.refreshTimeout && this.clearTimeout(this.refreshTimeout);
      for (const handle of Object.values(this.mapRenderTimeout)) {
        this.clearTimeout(handle);
      }
      this.mapRenderTimeout = {};
      await this.setStateAsync('info.connection', false, true);
      // In compact mode the process keeps running, so the client has to be gone
      // before the callback returns.
      await this.disconnectMqtt(true);
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
