'use strict';

/*
 * Client for the Navimow mobile-app cloud ("private cloud", envelope p:101).
 *
 * The official Smart Home API this adapter uses accepts a zone in StartStop but ignores it, so
 * starting single zones and reading the progress per zone is only possible through the cloud the
 * Navimow app itself talks to. This module speaks that protocol and nothing else: it knows no
 * ioBroker object, which is what lets lib/appApi.test.js drive it without an adapter.
 *
 * The protocol is ported from NaviMower, a Home Assistant integration:
 * https://github.com/vahesoo/NaviMower - custom_components/navimower/api/{crypto,passport,client,
 * regions,__init__}.py and const.py (encode_partition_ids, mow_setup), version 0.5.0-beta31.
 *
 *   MIT License
 *
 *   Copyright (c) 2026 Roberto Gualandris
 *   Copyright (c) 2026 Navimower contributors
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a copy
 *   of this software and associated documentation files (the "Software"), to deal
 *   in the Software without restriction, including without limitation the rights
 *   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 *   copies of the Software, and to permit persons to whom the Software is
 *   furnished to do so, subject to the following conditions:
 *
 *   The above copyright notice and this permission notice shall be included in all
 *   copies or substantial portions of the Software.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *   SOFTWARE.
 *
 * The keys below are the app's, not a user's: they identify the app to the cloud and are the same
 * for everyone. A new app release can change them, and then this module stops working until they
 * are updated - the price of an unofficial API, and the reason the feature is off by default.
 */

const crypto = require('node:crypto');
const { URL, URLSearchParams } = require('node:url');
const axios = require('axios');

// ---- Envelope crypto (NaviMower api/crypto.py) ----

const SESSION_KEY = Buffer.from('d0db95e2b4b2eeb99af3cfb638386209', 'hex');
const WRAP_PUB_PEM = [
  '-----BEGIN PUBLIC KEY-----',
  'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDRiEqrCME5SI2er9B+ZDweKWGe',
  'TWnMn2dFG8rt+M6iKDv4Lui4p6BdHX2dbTgCRHNpJNz1tAsOGSPfcmcIkGxt3x+a',
  'gs5YEmpkQq0zEYBSw8Stin2WVaPrUur00dEYr0qlNqDWIbMIuDOG554Sk11mUjY/',
  'rzN0+TxJ5YNsU3kbwQIDAQAB',
  '-----END PUBLIC KEY-----',
].join('\n');
const KEY_DATA = {
  keyDataOne: '4c9239e5377',
  keyDataTwo: 'c416f9ed',
  keyDataThree: '230d8ee5',
  keyDataFour: '53a22?h}',
};

// ---- App identity (NaviMower api/passport.py, api/client.py) ----

const CLIENT_ID = 'mowerbot_app_prod';
const CLIENT_KEY = '830247f0-da96-5c21-8cf0-ca09299795f9';
const APP_VERSION = '402000003';
const OS_NAME = 'Android';
const OS_VERSION = '13';
const OS_LANGUAGE = 'en';
const DEVICE = 'ANDROID';
const LANGUAGE = 'en';
const PASSPORT_OK = '90000';
const PASSPORT_ACCOUNT_NOT_EXISTS = '00002';
const CLOUD_HEADERS = { 'Content-Type': 'text/html', 'ninebot-version': '1' };
const CODE_OK = 1;
// Business codes that mean the session is gone: refresh, log in to the mower cloud, retry once.
const AUTH_ERROR_CODES = new Set([90015, 90016, 401900, 401901, 401902, 401903, 401905, 1005]);
/** "Logged in from another device": another client of the same account took the session. */
const CODE_OTHER_DEVICE = 1005;
/** The mower refuses the command in its current state (seen while it is out mowing). */
const CODE_REFUSED = 5001;

// ---- Regional routing (NaviMower api/regions.py) ----

const DEFAULT_REGION = 'fra';
const REGION_ALIASES = { eu: 'fra', sea: 'sg', ore: 'us' };
const PASSPORT_HOSTS = {
  fra: ['api-passport-fra.willand.com', 'api-passport-fra.ninebot.com'],
  sg: ['api-passport-sg.willand.com', 'api-passport-sg.ninebot.com'],
  us: ['api-passport-ore.willand.com', 'api-passport-us.ninebot.com', 'api-passport-ore.ninebot.com'],
  bj: ['api-passport-bj.willand.com', 'api-passport-bj.ninebot.com'],
};
const MOWER_HOSTS = {
  fra: ['navimow-fra.ninebot.com', 'navimow-fra.willand.com'],
  sg: ['navimow-sg.willand.com'],
  us: ['navimow-fra.ninebot.com', 'navimow-ore.willand.com'],
  bj: ['navimow-bj.ninebot.com', 'navimow-bj.willand.com'],
};
const ALL_PASSPORT_HOSTS = [
  ...new Set([
    ...Object.values(PASSPORT_HOSTS).map((hosts) => hosts[0]),
    ...Object.values(PASSPORT_HOSTS).flatMap((hosts) => hosts.slice(1)),
  ]),
];
const ALL_MOWER_HOSTS = [...new Set(Object.values(MOWER_HOSTS).flat())];

// ---- Mower knowledge (NaviMower const.py, model_support.py) ----

/** First-generation H series: zones can be chosen, their order cannot - the mower picks it. */
const H1_GENERATION_MODELS = new Set(['H500', 'H500E', 'H800', 'H800E', 'H1500', 'H1500E', 'H3000', 'H3000E']);
const H1_GENERATION_VEHICLE_TYPES = new Set([20000002]);

const REAUTH_WINDOW_MS = 10 * 60 * 1000;
const REAUTH_MAX_IN_WINDOW = 3;
const HTTP_TIMEOUT_MS = 30000;

class AppApiError extends Error {
  /**
   * @param {string} kind where it failed: 'passport', 'cloud' or 'network'
   * @param {any} code the code the server answered with, or a short tag of our own
   * @param {string} desc what it said, safe for the log
   */
  constructor(kind, code, desc) {
    super(`${kind} ${code}: ${desc}`);
    this.name = 'AppApiError';
    this.kind = kind;
    this.code = code;
    this.desc = desc;
  }
}

/**
 * The account refuses the session. `fatal` means the credentials themselves were refused: trying
 * again with the same ones only hammers the account, so the caller stops until the settings change.
 */
class AppApiAuthError extends AppApiError {
  /**
   * @param {string} kind where it failed
   * @param {any} code the server's code
   * @param {string} desc what it said
   * @param {boolean} [fatal] the credentials were refused
   */
  constructor(kind, code, desc, fatal = false) {
    super(kind, code, desc);
    this.name = 'AppApiAuthError';
    this.fatal = fatal;
  }
}

/**
 * A code as a number, whether the cloud sent it as one or as a string.
 *
 * @param {any} code the code as it arrived
 * @returns {number|null} the number, or null where there is none
 */
function asCode(code) {
  const text = String(code ?? '').trim();
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {any} code a business code
 * @returns {boolean} whether it means the session must be renewed
 */
function isAuthErrorCode(code) {
  const n = asCode(code);
  return n !== null && AUTH_ERROR_CODES.has(n);
}

/**
 * JSON the way Python's json.dumps(..., separators=(",", ":")) writes it, ensure_ascii included.
 * The MD5 of the envelope and the checkcode of the login are taken over exactly these bytes.
 *
 * @param {any} value what to serialise
 * @returns {string} compact JSON with every non-ASCII character escaped
 */
function pyJson(value) {
  const json = JSON.stringify(value);
  let out = '';
  for (let i = 0; i < json.length; i++) {
    const code = json.charCodeAt(i);
    out += code > 0x7f ? '\\u' + code.toString(16).padStart(4, '0') : json[i];
  }
  return out;
}

/**
 * @param {Buffer} key 16-byte key
 * @param {Buffer} data plain text
 * @returns {Buffer} AES-128-CBC with a zero IV and PKCS#7 padding, as the app uses it
 */
function aesEncrypt(key, data) {
  const cipher = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16));
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

/**
 * @param {Buffer} key 16-byte key
 * @param {Buffer} data cipher text
 * @returns {Buffer} the plain text
 */
function aesDecrypt(key, data) {
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16));
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

/**
 * The encrypted request envelope for one business payload: AES under a fresh key, the key
 * wrapped with the app's RSA key, and the MD5 of the plain text.
 *
 * @param {object} business the payload
 * @param {object} [opts] for tests only
 * @param {number} [opts.timeStamp] seconds since the epoch
 * @param {Buffer} [opts.requestKey] the AES key instead of a random one
 * @returns {{d: string, h: string, k: string, p: string, t: string}} the envelope
 */
function pack(business, opts = {}) {
  const plain = Buffer.from(
    pyJson({
      data: Buffer.from(pyJson(business)).toString('base64'),
      ...KEY_DATA,
      platform: 2,
      timeStamp: opts.timeStamp ?? Math.floor(Date.now() / 1000),
    }),
  );
  // Sixteen random capital letters, like the app makes them.
  const requestKey = opts.requestKey || Buffer.from([...crypto.randomBytes(16)].map((b) => 0x41 + (b % 26)));
  const wrapped = crypto.publicEncrypt({ key: WRAP_PUB_PEM, padding: crypto.constants.RSA_PKCS1_PADDING }, requestKey);
  return {
    d: aesEncrypt(requestKey, plain).toString('base64'),
    h: crypto.createHash('md5').update(plain).digest('hex'),
    k: wrapped.toString('base64'),
    p: '101',
    t: '0',
  };
}

/**
 * Opens a response envelope `{r: ...}`. Responses use a fixed session key, not the request key.
 *
 * @param {any} body the parsed response
 * @returns {any} the business response `{code, data, desc}`, or the body itself without an envelope
 */
function decodeResponse(body) {
  if (!body || typeof body !== 'object' || !('r' in body)) return body;
  const inner = JSON.parse(aesDecrypt(SESSION_KEY, Buffer.from(String(body.r), 'base64')).toString('utf8'));
  return JSON.parse(Buffer.from(String(inner.data), 'base64').toString('utf8'));
}

/**
 * The passport signature: SHA-256 over `key=value` pairs, sorted by key and joined with `&`.
 *
 * @param {Record<string, any>} values everything that is signed
 * @returns {string} the hex digest
 */
function sign(values) {
  return crypto
    .createHash('sha256')
    .update(
      Object.keys(values)
        .sort()
        .map((key) => `${key}=${values[key]}`)
        .join('&'),
    )
    .digest('hex');
}

/**
 * @param {string} urlPath the request path, which is signed too
 * @param {Record<string, any>} params the request parameters
 * @param {string} [timestamp] milliseconds since the epoch, for tests
 * @returns {Record<string, string>} the headers of a signed passport request
 */
function passportHeaders(urlPath, params, timestamp = String(Date.now())) {
  const signature = sign({
    app_version: APP_VERSION,
    clientKey: CLIENT_KEY,
    os: OS_NAME,
    os_language: OS_LANGUAGE,
    os_version: OS_VERSION,
    timestamp,
    url: urlPath,
    ...params,
  });
  return {
    app_version: APP_VERSION,
    clientId: CLIENT_ID,
    os: OS_NAME,
    os_language: OS_LANGUAGE,
    os_version: OS_VERSION,
    timestamp,
    sign: signature,
    'content-type': 'application/json',
    'user-agent': 'Segway_Mowerbot/4.02.0 (android)',
  };
}

/**
 * @param {any} region the region code as the account reports it
 * @returns {string} the routing region, an alias resolved
 */
function canonicalRegion(region) {
  const code = String(region || '')
    .trim()
    .toLowerCase();
  return code ? REGION_ALIASES[code] || code : DEFAULT_REGION;
}

/**
 * @param {any} region the account region
 * @returns {string[]} the passport hosts of the region, or all known ones for an unknown region
 */
function passportHosts(region) {
  return PASSPORT_HOSTS[canonicalRegion(region)] || ALL_PASSPORT_HOSTS;
}

/**
 * @param {any} region the account region
 * @returns {string[]} the mower-cloud hosts of the region first, then every other known one
 */
function mowerHosts(region) {
  const preferred = MOWER_HOSTS[canonicalRegion(region)] || [];
  return [...preferred, ...ALL_MOWER_HOSTS.filter((host) => !preferred.includes(host))];
}

/**
 * Zone ids for the start command: each one an unsigned 16-bit little-endian value in hex.
 *
 * @param {number[]} ids zone ids
 * @returns {string} e.g. [1219, 1220] -> 'c304c404'
 */
function encodePartitionIds(ids) {
  return ids
    .map((id) => (id & 0xff).toString(16).padStart(2, '0') + ((id >> 8) & 0xff).toString(16).padStart(2, '0'))
    .join('');
}

/**
 * The zones of the current task as index2 reports them. Big-endian, unlike the start command.
 *
 * @param {any} hex index2.partitionIdList, e.g. '04C3'
 * @returns {number[]} zone ids, e.g. [1219]; none for an empty or malformed value
 */
function decodePartitionIdList(hex) {
  const text = String(hex ?? '').trim();
  if (!text || text.length % 2 || /[^0-9a-f]/i.test(text)) return [];
  const bytes = Buffer.from(text, 'hex');
  const ids = [];
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const id = bytes.readUInt16BE(i);
    if (id) ids.push(id);
  }
  return ids;
}

/**
 * partitionSetup of the start command.
 *
 * @param {boolean} reset true: mow the zones from the beginning; false: continue where they stopped
 * @param {boolean} ordered true: in the order given; false: the mower picks the order
 * @returns {number} 0x11, 0x12, 0x21 or 0x22
 */
function mowSetup(reset, ordered) {
  return (reset ? 0x20 : 0x10) | (ordered ? 0x02 : 0x01);
}

/**
 * @param {any} model e.g. 'H3000'
 * @param {any} vehicleType the vehicle type the cloud reports
 * @returns {boolean} a first-generation H mower, which takes zones but not their order
 */
function isH1Generation(model, vehicleType) {
  const normalized = String(model || '')
    .trim()
    .toUpperCase()
    .replace(/\s/g, '');
  return H1_GENERATION_MODELS.has(normalized) || H1_GENERATION_VEHICLE_TYPES.has(Number(vehicleType) || 0);
}

/**
 * @param {any} value a map id or map base id
 * @returns {boolean} usable for a map request; older H1 mowers report '0' while docked
 */
function validMapId(value) {
  return value != null && !['', '0'].includes(String(value).trim());
}

/**
 * The first usable map of a map-list (or location) answer.
 *
 * @param {any} mapList what /map/index/map-list returned
 * @returns {{mapId: string, mapBaseId: string, editTime: string}|null} the map, or null
 */
function resolveMapIds(mapList) {
  const candidates = [];
  if (Array.isArray(mapList)) candidates.push(...mapList);
  else if (mapList && typeof mapList === 'object') {
    candidates.push(mapList);
    for (const key of ['list', 'maps', 'data']) {
      if (Array.isArray(mapList[key])) candidates.push(...mapList[key]);
    }
  }
  for (const item of candidates) {
    if (!item || typeof item !== 'object') continue;
    const mapId = item.map_id ?? item.mapId;
    const mapBaseId = item.map_base_id ?? item.mapBaseId;
    if (validMapId(mapId) && validMapId(mapBaseId)) {
      return {
        mapId: String(mapId),
        mapBaseId: String(mapBaseId),
        editTime: String(item.map_edit_time ?? item.edittime ?? item.editTime ?? ''),
      };
    }
  }
  return null;
}

/**
 * The zones of a map: id, name and area from the sub_maps of /map/index/map-detail.
 *
 * @param {any} data what map-detail returned; its map_detail is a JSON string
 * @returns {{id: number, name: string, area: number|null}[]|null} the zones, or null if unreadable
 */
function parseZonesFromMapDetail(data) {
  let detail = data;
  try {
    if (typeof detail === 'string') detail = JSON.parse(detail);
    let geometry = detail?.map_detail;
    if (typeof geometry === 'string') geometry = JSON.parse(geometry);
    if (!geometry || !Array.isArray(geometry.sub_maps)) return null;
    return geometry.sub_maps
      .filter((sub) => sub && typeof sub === 'object' && Number.isInteger(Number(sub.id)) && Number(sub.id) > 0)
      .map((sub) => ({
        id: Number(sub.id),
        name: String(sub.name || `Zone ${sub.id}`),
        area: Number.isFinite(Number(sub.area)) && sub.area !== null && sub.area !== '' ? Number(sub.area) : null,
      }));
  } catch {
    return null;
  }
}

/**
 * The command number of a set/send answer, whatever shape it came in.
 *
 * @param {any} value the answer
 * @returns {string|null} the command number
 */
function commandNumber(value) {
  if (value == null || typeof value === 'boolean') return null;
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim() || null;
  if (typeof value === 'object') {
    for (const key of ['cmd_num', 'cmdNum', 'command_num', 'commandNum']) {
      const found = commandNumber(value[key]);
      if (found) return found;
    }
  }
  return null;
}

/**
 * @returns {string} a new client id: 32 hex characters, kept for the life of the session
 */
function newDeviceId() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * One session against the app cloud. Calls run one at a time: a poll and a command must not
 * refresh the same session at once, and the cloud gives each account one session per device id.
 */
class AppApiClient {
  /**
   * @param {object} opts options
   * @param {{deviceId: string, tokens?: object, uid?: string, host?: string}} opts.session the
   *   persisted session; deviceId must stay the same for good, a new one registers a new client
   * @param {() => ({email: string, password: string}|null)} opts.credentials the login, asked for
   *   only when the stored session cannot be refreshed
   * @param {{debug: Function, info: Function, warn: Function}} opts.log logger; never sees a secret
   * @param {(session: object) => void} [opts.onSessionChange] called after every change, to persist
   * @param {import('axios').AxiosInstance} [opts.http] for tests
   */
  constructor(opts) {
    if (!opts?.session?.deviceId || !/^[0-9a-f]{32}$/.test(opts.session.deviceId)) {
      throw new Error('AppApiClient needs a session with a 32-character hex deviceId');
    }
    this.session = {
      deviceId: opts.session.deviceId,
      tokens: { access_token: '', refresh_token: '', uuid: '', region: '', ...(opts.session.tokens || {}) },
      uid: opts.session.uid || '',
      host: opts.session.host || '',
    };
    this.credentials = opts.credentials;
    this.log = opts.log;
    this.onSessionChange = opts.onSessionChange || (() => {});
    this.http = opts.http || axios.create({ timeout: HTTP_TIMEOUT_MS });
    this.queue = Promise.resolve();
    this.reauthTimes = [];
    this.otherDeviceWarned = false;
  }

  // ---- Transport ----

  /**
   * @param {string} url full URL
   * @param {'GET'|'POST'} method HTTP method
   * @param {Record<string, string>} headers request headers
   * @param {string} [body] request body
   * @returns {Promise<any>} the parsed JSON, also for an HTTP error status that carries some
   */
  async request(url, method, headers, body) {
    let res;
    try {
      res = await this.http.request({
        url,
        method,
        headers,
        data: body,
        responseType: 'text',
        transformResponse: [(data) => data],
        validateStatus: () => true,
      });
    } catch (error) {
      throw new AppApiError('network', 'network', `${new URL(url).host}: ${error?.code || error?.message || error}`);
    }
    try {
      return JSON.parse(String(res.data));
    } catch {
      throw new AppApiError('network', res.status, `${new URL(url).host}: no JSON in the answer (HTTP ${res.status})`);
    }
  }

  /**
   * @param {string} host passport host
   * @param {string} urlPath path
   * @param {Record<string, any>} params parameters, signed and sent as query (GET) or body (POST)
   * @param {'GET'|'POST'} method HTTP method
   * @returns {Promise<any>} the answer
   */
  passportRequest(host, urlPath, params, method) {
    let url = `https://${host}${urlPath}`;
    let body;
    if (method === 'POST') body = JSON.stringify(params);
    else if (Object.keys(params).length) url += '?' + new URLSearchParams(params).toString();
    return this.request(url, method, passportHeaders(urlPath, params), body);
  }

  /**
   * One encrypted call, no session handling.
   *
   * @param {string} host mower-cloud host
   * @param {string} urlPath path
   * @param {object} business the payload
   * @returns {Promise<any>} the business answer `{code, data, desc}`
   */
  async raw(host, urlPath, business) {
    const answer = await this.request(
      `https://${host}${urlPath}`,
      'POST',
      CLOUD_HEADERS,
      JSON.stringify(pack(business)),
    );
    return decodeResponse(answer);
  }

  // ---- Passport ----

  /**
   * The region that owns the account, asked for without the password.
   *
   * @param {string} email the account
   * @returns {Promise<string|null>} the region code as the account reports it, null if unknown
   */
  async lookupRegion(email) {
    /** @type {AppApiError|null} */
    let transportError = null;
    for (const host of ALL_PASSPORT_HOSTS) {
      let answer;
      try {
        answer = await this.passportRequest(host, '/v3/region', { account: email, device: DEVICE }, 'GET');
      } catch (error) {
        transportError = error;
        continue;
      }
      const code = String(answer?.resultCode);
      if (code === PASSPORT_OK) return String(answer?.data?.region || '') || null;
      if (code !== PASSPORT_ACCOUNT_NOT_EXISTS) this.log.debug(`App region lookup on ${host}: ${code}`);
    }
    // A directory that could not be asked proves nothing about the account. The password goes
    // nowhere until the owning region is known.
    if (transportError) {
      throw new AppApiError(
        'network',
        'network',
        `no passport server reachable for the region lookup (${transportError.desc})`,
      );
    }
    return null;
  }

  /**
   * Full login with the password, then the mower-cloud login.
   *
   * @param {string} email the account
   * @param {string} password its password; used for this request only
   * @returns {Promise<void>}
   */
  async login(email, password) {
    const region = await this.lookupRegion(email);
    if (!region) {
      throw new AppApiAuthError('passport', PASSPORT_ACCOUNT_NOT_EXISTS, 'account not found in any region', true);
    }
    const params = { username: email, password, device: DEVICE };
    /** @type {Error|null} */
    let lastError = null;
    for (const host of passportHosts(region)) {
      let answer;
      try {
        answer = await this.passportRequest(host, '/v3/user/login', params, 'POST');
      } catch (error) {
        lastError = error;
        continue;
      }
      const code = String(answer?.resultCode);
      if (code === PASSPORT_OK) {
        this.session.tokens = AppApiClient.tokensFrom(answer.data, { region });
        this.session.uid = '';
        await this.mowerLogin();
        return;
      }
      lastError = new AppApiAuthError('passport', code, String(answer?.resultDesc || ''), true);
      // Wrong credentials must not be sprayed across the other servers of the region.
      if (code !== PASSPORT_ACCOUNT_NOT_EXISTS) throw lastError;
    }
    throw lastError || new AppApiError('network', 'network', 'no passport server reachable');
  }

  /**
   * @returns {Promise<void>} new tokens from the refresh token; rejects with an AppApiAuthError
   *   when the refresh token is no longer accepted
   */
  async refreshTokens() {
    const old = this.session.tokens;
    const params = { access_token: old.access_token, refresh_token: old.refresh_token, device: DEVICE };
    /** @type {Error|null} */
    let lastError = null;
    for (const host of passportHosts(old.region)) {
      let answer;
      try {
        answer = await this.passportRequest(host, '/v3/user/refresh', params, 'POST');
      } catch (error) {
        lastError = error;
        continue;
      }
      const code = String(answer?.resultCode);
      if (code !== PASSPORT_OK) throw new AppApiAuthError('passport', code, String(answer?.resultDesc || ''));
      this.session.tokens = AppApiClient.tokensFrom(answer.data, old);
      this.onSessionChange(this.snapshot());
      return;
    }
    throw lastError || new AppApiError('network', 'network', 'no passport server reachable');
  }

  /**
   * @param {any} data the token part of a passport answer
   * @param {{uuid?: string, region?: string}} fallback what to keep where the answer is silent
   * @returns {{access_token: string, refresh_token: string, uuid: string, region: string}} tokens
   */
  static tokensFrom(data, fallback) {
    return {
      access_token: String(data?.access_token || ''),
      refresh_token: String(data?.refresh_token || ''),
      uuid: String(data?.uuid || fallback.uuid || ''),
      // The raw code, not the routing alias: the mower-cloud login wants e.g. 'ore', not 'us'.
      region: String(data?.region || fallback.region || ''),
    };
  }

  // ---- Mower cloud session ----

  /**
   * The parameters the app sends with every call. Identity travels inside the encrypted body.
   *
   * @param {string} accessToken the access token, empty on the login itself
   * @param {string} uid the mower-cloud user id, empty before the login
   * @returns {Record<string, string>} the parameters
   */
  commonParams(accessToken, uid) {
    return {
      manufacturer: 'samsung_samsung_SM-G930F',
      systemVersion: OS_VERSION,
      platform: 'and',
      uid,
      device_id: this.session.deviceId,
      client_ver: APP_VERSION,
      language: LANGUAGE,
      access_token: accessToken,
    };
  }

  /** @returns {string[]} the host that worked last, then the hosts of the region */
  hostCandidates() {
    return [...new Set([this.session.host, ...mowerHosts(this.session.tokens.region)].filter(Boolean))];
  }

  /**
   * @param {any} answer a /user/user/login answer
   * @returns {string|null} the uid it carries
   */
  static uidFrom(answer) {
    const uid = answer && answer.data && typeof answer.data === 'object' ? answer.data.uid : null;
    return uid ? String(uid) : null;
  }

  /**
   * /user/user/login on every candidate host, plain and signed. A shared account that gets no
   * uid there can still learn it from the auth-list, which is what NaviMower falls back to.
   *
   * @returns {Promise<void>}
   */
  async mowerLogin() {
    const tokens = this.session.tokens;
    const loginFields = {
      uuid: tokens.uuid,
      token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      region: tokens.region,
    };
    const attempts = [];
    /** @type {Error|null} */
    let lastError = null;
    for (const host of this.hostCandidates()) {
      try {
        let answer = await this.raw(host, '/user/user/login', { ...loginFields, ...this.commonParams('', '') });
        let uid = AppApiClient.uidFrom(answer);
        attempts.push(`${host}/plain=${answer?.code}`);
        if (!uid) {
          answer = await this.raw(
            host,
            '/user/user/login',
            this.withCheckcode({ ...loginFields, ...this.commonParams('', '') }),
          );
          uid = AppApiClient.uidFrom(answer);
          attempts.push(`${host}/signed=${answer?.code}`);
        }
        if (uid) {
          this.session.uid = uid;
          this.session.host = host;
          this.onSessionChange(this.snapshot());
          return;
        }
        lastError = new AppApiAuthError('cloud', answer?.code, `mower login returned no uid: ${answer?.desc || ''}`);
      } catch (error) {
        attempts.push(`${host}/${error.code}`);
        lastError = error;
      }
    }
    for (const host of this.hostCandidates()) {
      for (const accessToken of ['', tokens.access_token]) {
        try {
          const answer = await this.raw(host, '/vehicle/vehicle/auth-list', {
            ...loginFields,
            ...this.commonParams(accessToken, ''),
          });
          const items = AppApiClient.listFrom(answer?.data);
          const uid = items[0]?.auth_uid || items[0]?.authUid;
          if (answer?.code === CODE_OK && uid) {
            this.session.uid = String(uid);
            this.session.host = host;
            this.onSessionChange(this.snapshot());
            return;
          }
        } catch (error) {
          lastError = error;
        }
      }
    }
    this.log.debug(`App mower login attempts: ${attempts.join(', ')}`);
    throw lastError || new AppApiError('cloud', 'no_host', 'no mower-cloud host answered');
  }

  /**
   * @param {Record<string, any>} body the login body
   * @returns {Record<string, any>} the body with serviceTime, nonce and the MD5 checkcode over all of it
   */
  withCheckcode(body) {
    /** @type {Record<string, any>} */
    const signed = {
      ...body,
      serviceTime: Date.now(),
      nonce: crypto.createHash('sha256').update(crypto.randomBytes(16)).digest('hex').slice(0, 32),
    };
    signed.checkcode = crypto.createHash('md5').update(pyJson(signed)).digest('hex').toUpperCase();
    return signed;
  }

  /**
   * Gets the session back: refresh the tokens, log in to the mower cloud again. Where the refresh
   * token is refused too, the stored password logs in from scratch. More than three of these in
   * ten minutes means two clients are taking the session from each other, and it stops there.
   *
   * @returns {Promise<void>}
   */
  async reauth() {
    const now = Date.now();
    this.reauthTimes = this.reauthTimes.filter((t) => now - t < REAUTH_WINDOW_MS);
    if (this.reauthTimes.length >= REAUTH_MAX_IN_WINDOW) {
      throw new AppApiAuthError(
        'cloud',
        'reauth_loop',
        `more than ${REAUTH_MAX_IN_WINDOW} logins in ${REAUTH_WINDOW_MS / 60000} minutes - another client of the same account is probably taking the session`,
      );
    }
    this.reauthTimes.push(now);
    if (this.session.tokens.refresh_token) {
      try {
        await this.refreshTokens();
        await this.mowerLogin();
        return;
      } catch (error) {
        if (!(error instanceof AppApiAuthError) || error.kind !== 'passport') throw error;
        this.log.info('App session could not be refreshed, logging in again');
      }
    }
    const login = this.credentials();
    if (!login) throw new AppApiAuthError('passport', 'no_credentials', 'no e-mail/password configured', true);
    await this.login(login.email, login.password);
  }

  /**
   * One authenticated call: `data` on success, one re-login and retry on a session code.
   *
   * @param {string} urlPath path
   * @param {object} [extra] the call's own parameters
   * @returns {Promise<any>} the data of the answer
   */
  call(urlPath, extra = {}) {
    const run = this.queue.then(() => this.callNow(urlPath, extra));
    // The queue only orders the calls; one that fails must not fail the ones after it.
    this.queue = run.catch(() => {});
    return run;
  }

  /**
   * @param {string} urlPath path
   * @param {object} extra the call's own parameters
   * @returns {Promise<any>} the data of the answer
   */
  async callNow(urlPath, extra) {
    if (!this.session.uid) await this.reauth();
    const body = () => ({ ...this.commonParams(this.session.tokens.access_token, this.session.uid), ...extra });
    let answer = await this.raw(this.session.host || this.hostCandidates()[0], urlPath, body());
    if (answer?.code === CODE_OK) return answer.data;
    if (isAuthErrorCode(answer?.code)) {
      if (asCode(answer.code) === CODE_OTHER_DEVICE && !this.otherDeviceWarned) {
        this.otherDeviceWarned = true;
        this.log.warn(
          'App cloud: "logged in from another device" (1005). Another client uses the same account - give the adapter an account of its own, shared from the owner account.',
        );
      }
      await this.reauth();
      answer = await this.raw(this.session.host, urlPath, body());
      if (answer?.code === CODE_OK) return answer.data;
    }
    const desc = `${urlPath}: ${answer?.desc || JSON.stringify(answer).slice(0, 200)}`;
    if (isAuthErrorCode(answer?.code)) throw new AppApiAuthError('cloud', answer?.code, desc);
    throw new AppApiError('cloud', answer?.code ?? 'unknown', desc);
  }

  /**
   * @returns {{deviceId: string, tokens: object, uid: string, host: string}} a copy to persist
   */
  snapshot() {
    return {
      deviceId: this.session.deviceId,
      tokens: { ...this.session.tokens },
      uid: this.session.uid,
      host: this.session.host,
    };
  }

  /**
   * @param {any} data a data part that is a list, or an object holding one in `list`
   * @returns {any[]} the list
   */
  static listFrom(data) {
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.list)) return data.list;
    return [];
  }

  // ---- Reading ----

  /** @returns {Promise<any[]>} the mowers of the account, each with vehicle_sn, subType, vehicle_type */
  async vehicles() {
    return AppApiClient.listFrom(await this.call('/vehicle/vehicle/auth-list', {}));
  }

  /**
   * @param {string} sn serial number
   * @returns {Promise<any>} vehicle_state, soc, error_data, partitionIdList and more
   */
  async status(sn) {
    return (await this.call('/vehicle/vehicle/index2', { vehicle_sn: sn })) || {};
  }

  /**
   * @param {string} sn serial number
   * @returns {Promise<{mapId: string, mapBaseId: string, editTime: string}|null>} the current map
   */
  async currentMap(sn) {
    return resolveMapIds(await this.call('/map/index/map-list', { vehicle_sn: sn }));
  }

  /**
   * @param {string} sn serial number
   * @param {{mapId: string, mapBaseId: string}} map from currentMap
   * @returns {Promise<{id: number, name: string, area: number|null}[]|null>} its zones
   */
  async zones(sn, map) {
    const data = await this.call('/map/index/map-detail', {
      vehicle_sn: sn,
      map_id: map.mapId,
      map_base_id: map.mapBaseId,
    });
    return parseZonesFromMapDetail(data);
  }

  /**
   * @param {string} sn serial number
   * @returns {Promise<any[]>} per zone: partitionId, area, finishedArea, partitionPercentage,
   *   startTime, endTime (seconds) - also while docked
   */
  async progress(sn) {
    return AppApiClient.listFrom(await this.call('/vehicle/trail/get-path-info-time', { vehicle_sn: sn }));
  }

  // ---- Commands ----

  /**
   * Starts mowing the given zones.
   *
   * @param {string} sn serial number
   * @param {number[]} zoneIds the zones
   * @param {object} opts options
   * @param {boolean} opts.reset true: from the beginning; false: continue where they stopped
   * @param {boolean} opts.ordered true: in the order given (not on the first H generation)
   * @returns {Promise<string|null>} the command number
   */
  async startZones(sn, zoneIds, { reset, ordered }) {
    const answer = await this.call('/vehicle/set/send', {
      vehicle_sn: sn,
      cmdCode: 's:mower',
      data: { partitionSetup: mowSetup(reset, ordered), partitionIds: encodePartitionIds(zoneIds) },
    });
    return commandNumber(answer);
  }
}

module.exports = {
  AppApiClient,
  AppApiError,
  AppApiAuthError,
  CODE_REFUSED,
  pyJson,
  pack,
  decodeResponse,
  sign,
  passportHeaders,
  canonicalRegion,
  passportHosts,
  mowerHosts,
  encodePartitionIds,
  decodePartitionIdList,
  mowSetup,
  isH1Generation,
  resolveMapIds,
  parseZonesFromMapDetail,
  commandNumber,
  newDeviceId,
};
