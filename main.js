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
  createSignature(data) {
    data.clientKey = 'ZV4B4KpBwymR';
    data.device = 'ANDROID';

    const keys = Object.keys(data).sort();
    let payload = '';
    keys.forEach((key) => {
      payload = payload + key + '=' + data[key] + '&';
    });
    payload = payload.slice(0, -1);
    //hash 256
    this.log.debug(payload);
    const hash = crypto.createHash('sha256').update(payload).digest('hex');
    return hash;
  }
  async createRequest() {
    //cn.ninebot.nbcrypto.NbEncryption
    //  System.loadLibrary("nbcrypto");
    //    public native int crypto_encrypt(byte[] bArr, int i, byte[] bArr2);
    // RSA ECB PKCS1Padding
    //KEY: 30819f300d06092a864886f70d010101050003818d0030818902818100d1884aab08c139488d9eafd07e643c1e29619e4d69cc9f67451bcaedf8cea2283bf82ee8b8a7a05d1d7d9d6d380244736924dcf5b40b0e1923df726708906c6ddf1f9a82ce58126a6442ad33118052c3c4ad8a7d9655a3eb52eaf4d1d118af4aa536a0d621b308b83386e79e12935d6652363faf3374f93c49e5836c53791bc10203010001xq
    //AES CTR
    //     AES/CTR/NoPadding key Base64:BBBeRCQotUa6UxMSCrBowVPA
    // AES/CTR/NoPadding key Hex:04105e442428b546ba5313120ab068c153c0
    // AES/CTR/NoPadding iv Base64:XkQkKLVGulMTEgqwaMFTwA==
    // AES/CTR/NoPadding iv Hex:5e442428b546ba5313120ab068c153c0
    // AES/CTR/NoPadding doFinal param Utf8:EncryptedSPInitialized
    // AES/CTR/NoPadding doFinal result Hex:aa2a07cb3cd6dcb4fa2f3a592109bd028008f53a4c7b
    //POST https://navimow-fra.ninebot.com/vehicle/vehicle/index
    //h = MD5 Hash of the payload
    //k = clientKey
    //d = postdata = AES 128 key: 66 b9 24 37 f7 d5 f4 c4 c1 32 c7 74 fa e9 18 86
    //aes key and four key is changing
    /*
     {"keyDataTwo":"5K0E8400-E29","data":"eyJjdXJyZW50X3ZlcnNpb24iO","platform":1,"keyDataOne":"segway.mower","timeStamp":1696799374783,"keyDataThree":"321A2EF1F010","keyDataFour":"52428.278076"}
     data:
     {"current_version":104090001,"checkcode":"1a478b9dcf053990c1900294a834cbff","platform":"iOS","vehicle_type":"20000001","vehicle_sn":"XXXXXX","language":"de","device_id":"XXX-xx-xxx-xxxx-XXXXXXX","serviceTime":1696799373292.8428,"ostype":"ios","platform_ver":"14.8","client_ver":104090001,"access_token":"x.x.w3-x-x","uid":"268XXX"}
    {"keyDataTwo":"5K0E8400-E29","data":"eyJ1a","platform":1,"keyDataOne":"segway.mower","timeStamp":1696801738116,"keyDataThree":"321A2EF1F010","keyDataFour":"75647.981201"}


     */
  }
  async decryptResponse() {
    /*

Value In: DY16mYCgyyHQ4VG4jYVR0btYFTQQJpJ/SRcPi3CyERusU1vWet/yIz3AmSXRa9k1iRwFbF7nZH7taH991MQGEz1/JTwi282AIbTH6S3RBZdgXIFmX9/U9+ylfS2u3gJvEdEKDoi408oR0BayH0tMbw==
Key: 45mR0bbO5t7v6d3/IUskGgAAAAAAAAAAAAAAAAAAAAA=
IV:
Value Out: eyJkYXRhIjoiZXlKamIyUmxJam94TENKa1lYUmhJam96TENKa1pYTmpJam9pVm05eVoyRnVaeUJsY21admJHZHlaV2xqYUNKOSIsInRpbWVTdGFtcCI6MTY5NjgwMTY3ODM1N33//38AAAAAAAAAAP//////////AAAAAAAAAAA=

    */
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
        if (res.data.resultCode != '90000') {
          this.log.error('Login failed');
          this.log.error(JSON.stringify(res.data));
          return;
        }
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
