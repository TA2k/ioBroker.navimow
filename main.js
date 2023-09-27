'use strict';

/*
 * Created with @iobroker/create-adapter v2.5.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');
const axios = require('axios').default;
const Json2iob = require('json2iob');
const crypto = require('crypto');
class Navimow extends utils.Adapter {
  /**
   * @param {Partial<utils.AdapterOptions>} [options={}]
   */
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
    this.requestClient = axios.create();
  }

  /**
   * Is called when databases are connected and adapter received configuration.
   */
  async onReady() {
    // Reset the connection indicator during startup
    this.setState('info.connection', false, true);
    if (this.config.interval < 0.5) {
      this.log.info('Set interval to minimum 0.5');
      this.config.interval = 0.5;
    }
    if (!this.config.username || !this.config.password) {
      this.log.error('Please set username and password in the instance settings');
      return;
    }

    this.updateInterval = null;
    this.reLoginTimeout = null;
    this.refreshTokenTimeout = null;
    this.session = {};
    this.subscribeStates('*');

    await this.login();

    if (this.session.access_token) {
      await this.getDeviceList();
      await this.updateDevices();
      this.updateInterval = setInterval(
        async () => {
          await this.updateDevices();
        },
        this.config.interval * 60 * 1000,
      );
    }
    let expireTimeout = 30 * 60 * 60 * 1000;
    if (this.session.expires_in) {
      expireTimeout = this.session.expires_in * 1000;
    }
    this.refreshTokenInterval = setInterval(() => {
      this.refreshToken();
    }, expireTimeout);
  }
  async createSignature(data) {
    data.clientKey = 'ZV4B4KpBwymR';
    data.device = 'ANDROID';

    const keys = Object.keys(data).sort();
    let payload = '';
    keys.forEach((key) => {
      payload = payload + key + '=' + data[key] + '&';
    });
    //hash 256
    return crypto.createHash('sha256').update(payload).digest('hex');
  }
  async createRequest() {
    //h = MD5 Hash of the payload
    //k = clientKey
    //d = postdata
  }
  async login() {
    const data = {
      timestamp: Date.now(),
      url: '/v3/user/login',
      username: this.config.username,
      password: this.config.password,
    };

    await this.requestClient({
      method: 'post',
      maxBodyLength: Infinity,
      url: 'https://api-passport-fra.ninebot.com/v3/user/login',
      headers: {
        'Content-Type': 'application/json',
        Accept: '*/*',
        'Accept-Language': 'de-DE;q=1.0, uk-DE;q=0.9, en-DE;q=0.8',
        clientId: 'MOWERBOT_APP_KEY',
        'User-Agent': 'Segway_Mowerbot/1.4.9 (com.segway.mower; build:1.4.9.1; iOS 14.8.0) Alamofire/1.4.9',
        sign: this.createSignature(data),
        timestamp: data.timestamp,
      },
      data: { username: this.config.username, password: this.config.password, device: 'ANDROID' },
    })
      .then((res) => {
        this.log.debug(JSON.stringify(res.data));
        this.session = res.data;
        this.log.info('Login successful');
        this.setState('info.connection', true, true);
      })
      .catch((error) => {
        this.log.error(error);
        error.response && this.log.error(JSON.stringify(error.response.data));
      });
  }

  async getDeviceList() {
    await this.requestClient({
      method: 'get',
      url: '',
      headers: {
        accept: '*/*',
        'content-type': 'application/json',
        'user-agent': '',
        authorization: 'Bearer ' + this.session.access_token,
        'accept-language': 'de-de',
      },
    })
      .then(async (res) => {
        this.log.debug(JSON.stringify(res.data));

        for (const device of res.data) {
          const id = device.id;

          this.deviceArray.push(id);
          const name = device.name + ' ' + device.deviceTypeDescription;

          await this.setObjectNotExistsAsync(id, {
            type: 'device',
            common: {
              name: name,
            },
            native: {},
          });
          await this.setObjectNotExistsAsync(id + '.remote', {
            type: 'channel',
            common: {
              name: 'Remote Controls',
            },
            native: {},
          });
          await this.setObjectNotExistsAsync(id + '.json', {
            type: 'state',
            common: {
              name: 'Raw JSON',
              write: false,
              read: true,
              type: 'string',
              role: 'json',
            },
            native: {},
          });

          const remoteArray = [
            { command: 'Refresh', name: 'True = Refresh' },
            { command: 'toDocking', name: 'True = toDocking' },
            { command: 'edgeMowing', name: 'True = edgeMowing' },
            {
              command: 'startMowingFromPoint',
              name: 'DurationInMunitesDividedBy10,StartPoint: Example: 9,0',
              type: 'string',
              role: 'text',
              def: '9,0',
            },
          ];
          remoteArray.forEach((remote) => {
            this.setObjectNotExists(id + '.remote.' + remote.command, {
              type: 'state',
              common: {
                name: remote.name || '',
                type: remote.type || 'boolean',
                role: remote.role || 'boolean',
                def: remote.def || false,
                write: true,
                read: true,
              },
              native: {},
            });
          });
          this.json2iob.parse(id, device);
        }
      })
      .catch((error) => {
        this.log.error(error);
        error.response && this.log.error(JSON.stringify(error.response.data));
      });
  }
  async updateDevices() {
    const statusArray = [
      {
        path: '',
        url: '',
        desc: 'Graph data of the device',
      },
    ];

    for (const id of this.deviceArray) {
      for (const element of statusArray) {
        const url = element.url.replace('$id', id);

        await this.requestClient({
          method: element.method || 'get',
          url: url,
          headers: {
            accept: '*/*',
            'content-type': 'application/json',
            'user-agent': '',
            authorization: 'Bearer ' + this.session.access_token,
            'accept-language': 'de-de',
          },
        })
          .then((res) => {
            this.log.debug(JSON.stringify(res.data));
            if (!res.data) {
              return;
            }
            const data = res.data;

            const forceIndex = true;
            const preferedArrayName = null;

            this.setState(id + '.json', JSON.stringify(data), true);
            this.json2iob.parse(id, data, {
              forceIndex: forceIndex,
              preferedArrayName: preferedArrayName,
              channelName: element.desc,
            });
          })
          .catch((error) => {
            if (error.response) {
              if (error.response.status === 401) {
                error.response && this.log.debug(JSON.stringify(error.response.data));
                this.log.info(element.path + ' receive 401 error. Refresh Token in 60 seconds');
                this.refreshTokenTimeout && clearTimeout(this.refreshTokenTimeout);
                this.refreshTokenTimeout = setTimeout(() => {
                  this.refreshToken();
                }, 1000 * 60);

                return;
              }
            }
            this.log.error(url);
            this.log.error(error);
            error.response && this.log.error(JSON.stringify(error.response.data));
          });
      }
    }
  }

  async refreshToken() {
    await this.login();
  }

  /**
   * Is called when adapter shuts down - callback has to be called under any circumstances!
   * @param {() => void} callback
   */
  onUnload(callback) {
    try {
      this.setState('info.connection', false, true);
      this.refreshTimeout && clearTimeout(this.refreshTimeout);
      this.reLoginTimeout && clearTimeout(this.reLoginTimeout);
      this.refreshTokenTimeout && clearTimeout(this.refreshTokenTimeout);
      this.updateInterval && clearInterval(this.updateInterval);
      this.refreshTokenInterval && clearInterval(this.refreshTokenInterval);
      callback();
    } catch (e) {
      callback();
    }
  }

  /**
   * Is called if a subscribed state changes
   * @param {string} id
   * @param {ioBroker.State | null | undefined} state
   */
  async onStateChange(id, state) {
    if (state) {
      if (!state.ack) {
        const deviceId = id.split('.')[2];
        const command = id.split('.')[4];
        if (id.split('.')[3] !== 'remote') {
          return;
        }

        if (command === 'Refresh') {
          this.updateDevices();
          return;
        }
        this.log.debug(deviceId);

        clearTimeout(this.refreshTimeout);
        this.refreshTimeout = setTimeout(async () => {
          await this.updateDevices();
        }, 20 * 1000);
      }
    }
  }
}
if (require.main !== module) {
  // Export the constructor in compact mode
  /**
   * @param {Partial<utils.AdapterOptions>} [options={}]
   */
  module.exports = (options) => new Navimow(options);
} else {
  // otherwise start the instance directly
  new Navimow();
}
