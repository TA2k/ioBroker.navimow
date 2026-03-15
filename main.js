'use strict';

const utils = require('@iobroker/adapter-core');
const axios = require('axios');
const Json2iob = require('json2iob');
const crypto = require('crypto');
const mqtt = require('mqtt');
const { URL, URLSearchParams } = require('url');
const descriptions = require('./lib/descriptions.json');
const states = require('./lib/states.json');

const API_BASE_URL = 'https://navimow-fra.ninebot.com';
const OAUTH2_TOKEN_URL = API_BASE_URL + '/openapi/oauth/getAccessToken';
const CLIENT_ID = 'homeassistant';
const CLIENT_SECRET = '57056e15-722e-42be-bbaa-b0cbfb208a52';


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
    });
    this.session = {};
    this.updateInterval = null;
    this.refreshTokenTimeout = null;
    this.refreshTimeout = undefined;
    this.mqttClient = null;
    this.mqttConnected = false;
    this.lastMqttMessage = 0;
  }

  async onReady() {
    this.setState('info.connection', false, true);
    if (this.config.interval < 0.5) {
      this.log.info('Set interval to minimum 0.5');
      this.config.interval = 0.5;
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
        await this.updateDevices();

        // Connect MQTT for real-time updates
        await this.connectMqtt();

        // HTTP polling as fallback only when MQTT is stale (no message for 5 min)
        const pollMs = this.config.interval * 60 * 1000;
        this.updateInterval = setInterval(() => {
          const mqttStale = Date.now() - this.lastMqttMessage > 5 * 60 * 1000;
          if (!this.mqttConnected || mqttStale) {
            this.log.debug('MQTT ' + (this.mqttConnected ? 'stale' : 'disconnected') + ', polling via HTTP');
            this.updateDevices();
          }
        }, pollMs);

        // Schedule token refresh
        if (tokenObj.expires_in) {
          const refreshMs = (tokenObj.expires_in - 300) * 1000;
          if (refreshMs > 0) {
            this.refreshTokenTimeout = setTimeout(() => {
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
        const mqttInfo = res.data.data || {};
        const mqttUrlRaw = mqttInfo.mqttUrl;
        const mqttHost = mqttInfo.mqttHost || 'mqtt.navimow.com';
        const mqttUsername = mqttInfo.userName;
        const mqttPassword = mqttInfo.pwdInfo;

        let brokerUrl;
        const mqttOpts = {
          username: mqttUsername,
          password: mqttPassword,
          clientId: 'web_' + (mqttUsername || 'iobroker') + '_' + crypto.randomUUID().substring(0, 10),
          keepalive: 60,
          reconnectPeriod: 10000,
        };

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
        this.mqttClient = mqtt.connect(brokerUrl, mqttOpts);

        this.mqttClient.on('connect', () => {
          this.log.info('MQTT connected');
          this.mqttConnected = true;
          // Subscribe to device topics
          for (const deviceId of this.deviceArray) {
            const topics = [
              '/downlink/vehicle/' + deviceId + '/realtimeDate/state',
              '/downlink/vehicle/' + deviceId + '/realtimeDate/event',
              '/downlink/vehicle/' + deviceId + '/realtimeDate/attributes',
            ];
            for (const topic of topics) {
              this.mqttClient && this.mqttClient.subscribe(topic, (err) => {
                if (err) {
                  this.log.error('MQTT subscribe error for ' + topic + ': ' + err.message);
                } else {
                  this.log.debug('MQTT subscribed to ' + topic);
                }
              });
            }
          }
        });

        this.mqttClient.on('message', (topic, payload) => {
          this.lastMqttMessage = Date.now();
          this.handleMqttMessage(topic, payload);
        });

        this.mqttClient.on('error', (err) => {
          this.log.error('MQTT error: ' + err.message);
          if ('code' in err) {
            this.log.debug('MQTT error code: ' + /** @type {any} */ (err).code);
          }
        });

        this.mqttClient.on('close', () => {
          this.log.info('MQTT connection closed');
          this.mqttConnected = false;
        });

        this.mqttClient.on('reconnect', () => {
          this.log.debug('MQTT reconnecting...');
        });
      })
      .catch((error) => {
        this.log.warn('MQTT setup failed: ' + error.message);
        error.response && this.log.debug(JSON.stringify(error.response.data));
      });
  }

  handleMqttMessage(topic, payload) {
    try {
      const parts = topic.split('/').filter((p) => p !== '');
      // Expected: downlink/vehicle/{device_id}/realtimeDate/{channel}
      if (parts.length !== 5 || parts[0] !== 'downlink' || parts[1] !== 'vehicle') {
        this.log.debug('MQTT unknown topic: ' + topic);
        return;
      }
      const deviceId = parts[2];
      const channel = parts[4]; // state, event, attributes

      if (!this.deviceArray.includes(deviceId)) {
        this.log.debug('MQTT message for unknown device: ' + deviceId);
        return;
      }

      const data = JSON.parse(payload.toString());
      data.device_id = data.device_id || deviceId;

      this.log.debug('MQTT ' + channel + ' for ' + deviceId + ': ' + JSON.stringify(data));

      if (channel === 'state') {
        this.setState(deviceId + '.status.json', JSON.stringify(data), true);
        this.json2iob.parse(deviceId + '.status', data, {
          forceIndex: true,
          channelName: 'Status',
          descriptions,
          states,
        });
      } else if (channel === 'event') {
        this.json2iob.parse(deviceId + '.events', data, {
          forceIndex: true,
          channelName: 'Events',
          descriptions,
          states,
        });
      } else if (channel === 'attributes') {
        this.json2iob.parse(deviceId + '.attributes', data, {
          forceIndex: true,
          channelName: 'Attributes',
          descriptions,
          states,
        });
      }
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

  disconnectMqtt() {
    if (this.mqttClient) {
      this.mqttClient.end(true);
      this.mqttClient = null;
      this.mqttConnected = false;
      this.log.info('MQTT disconnected');
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
    const params = new URLSearchParams();
    params.append('grant_type', 'authorization_code');
    params.append('code', code);
    params.append('client_id', CLIENT_ID);
    params.append('client_secret', CLIENT_SECRET);
    return this.requestClient({
      method: 'post',
      url: OAUTH2_TOKEN_URL,
      data: params,
    })
      .then((res) => {
        this.log.debug(JSON.stringify(res.data));
        if (res.data && res.data.data && res.data.data.access_token) {
          return res.data.data;
        }
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
    const params = new URLSearchParams();
    params.append('grant_type', 'refresh_token');
    params.append('refresh_token', refreshTokenValue);
    params.append('client_id', CLIENT_ID);
    params.append('client_secret', CLIENT_SECRET);
    return this.requestClient({
      method: 'post',
      url: OAUTH2_TOKEN_URL,
      data: params,
    })
      .then((res) => {
        this.log.debug(JSON.stringify(res.data));
        if (res.data && res.data.data && res.data.data.access_token) {
          return res.data.data;
        }
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
      // Reconnect MQTT with new token
      this.log.debug('Reconnecting MQTT with new token...');
      this.disconnectMqtt();
      this.connectMqtt();
      if (tokenData.expires_in) {
        const refreshMs = (tokenData.expires_in - 300) * 1000;
        if (refreshMs > 0) {
          this.refreshTokenTimeout = setTimeout(() => {
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
        const payload = res.data && res.data.data && res.data.data.payload;
        const devices = (payload && payload.devices) || [];

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
        const payload = res.data.data && res.data.data.payload;
        const devices = (payload && payload.devices) || [];

        for (const deviceData of devices) {
          const id = deviceData.id || deviceData.device_id;
          if (!id || !this.deviceArray.includes(id)) {
            continue;
          }

          this.setState(id + '.status.json', JSON.stringify(deviceData), true);

          this.json2iob.parse(id + '.status', deviceData, {
            forceIndex: true,
            channelName: 'Status',
            descriptions,
            states,
          });

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
        const payload = res.data.data && res.data.data.payload;
        const results = (payload && payload.commands) || [];
        for (const result of results) {
          if (result.status === 'ERROR' && result.errorCode !== 'alreadyInState') {
            this.log.error('Command error: ' + (result.errorCode || 'unknown'));
          }
        }
        this.log.info('Command "' + commandName + '" sent successfully');
        clearTimeout(this.refreshTimeout);
        this.refreshTimeout = setTimeout(() => {
          this.updateDevices();
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
        this.log.debug('Device state changed to "' + state.val + '", updating remote states');
        this.updateRemoteStates(deviceId, String(state.val));
      }
      return;
    }

    // ack:false = user action -> handle remote commands
    if (channel !== 'remote') {
      return;
    }

    this.log.debug('Remote command triggered: ' + command + ' for device ' + deviceId);

    if (command === 'Refresh') {
      this.updateDevices();
      return;
    }

    if (COMMAND_MAP[command]) {
      this.sendMowerCommand(deviceId, command);
    } else {
      this.log.warn('Unknown remote command: ' + command);
    }
  }

  onUnload(callback) {
    try {
      this.log.debug('Adapter unloading, cleaning up...');
      this.setState('info.connection', false, true);
      this.disconnectMqtt();
      this.updateInterval && clearInterval(this.updateInterval);
      this.refreshTokenTimeout && clearTimeout(this.refreshTokenTimeout);
      this.refreshTimeout && clearTimeout(this.refreshTimeout);
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
