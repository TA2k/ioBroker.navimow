'use strict';

const { expect } = require('chai');
const crypto = require('node:crypto');
const {
  AppApiClient,
  AppApiError,
  pack,
  decodeResponse,
  pyJson,
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
} = require('./appApi');

// Reference values below are produced by the proven NaviMower Python code
// (api/crypto.py, api/passport.py) for the same fixed inputs and are byte-for-byte
// identical to what this module computes. They pin the wire format so a refactor that
// changes a single byte of an envelope, a signature or a decoded response is caught here.
const SESSION_KEY = Buffer.from('d0db95e2b4b2eeb99af3cfb638386209', 'hex');

/**
 * Wrap a business answer in a response envelope the client can decode, for the http mock.
 *
 * @param {object} business the answer
 * @returns {{r: string}} the envelope
 */
function wrapEnvelope(business) {
  const inner = JSON.stringify({ data: Buffer.from(JSON.stringify(business)).toString('base64') });
  const cipher = crypto.createCipheriv('aes-128-cbc', SESSION_KEY, Buffer.alloc(16));
  return { r: Buffer.concat([cipher.update(inner), cipher.final()]).toString('base64') };
}

describe('appApi envelope crypto', () => {
  const business = {
    vehicle_sn: 'S2RUH2410C0265',
    cmdCode: 's:mower',
    data: { partitionSetup: 17, partitionIds: 'c304c404' },
  };
  const env = pack(business, { timeStamp: 1762600000, requestKey: Buffer.from('ABCDEFGHIJKLMNOP') });

  it('writes the reference MD5 of the plain text', () => {
    expect(env.h).to.equal('8b66d8f179c4b85b9117c9abe4e11a34');
  });

  it('writes the reference AES cipher text', () => {
    expect(env.d).to.equal(
      'yJkPIcFugISahQJT62pX25mIiVYD9t3iNRhaB9M34O0bLrdrm81sOUkdvQ4vTbzRYbEu/4EYxyURL4FySZPcn7oj8B3gFr6vxE1bJuJwbHXbSD9EBuIgGgXEz0M+vBgGhzLuFj0uuOkcfY6MRZTNhgqUsyft4DWBTIsTF7G4qy2wHwOZSq64Y2dzHjzxoZyJru7RS/ebQ0dWSZbHZoyIK7V3S6DMPEjgwIYFNQa6Isgs8FhuLwbJXAYggmw/EfEP45wMvWvHfwX+xbj8VG9YP652VzHsLezOo7fYtrSSv+jOHngarkXDuHz7Vg15ocS46h5H4ExsBsN2M/XFz5hzs/OhRaRjgk29Y32kgtc/1zjXJj1f6STt0UeueIdk7Jx77PM0+noQvvlNWfHdCecedw==',
    );
  });

  it('wraps a 128-byte RSA block and tags p/t', () => {
    expect(Buffer.from(env.k, 'base64')).to.have.length(128);
    expect(env.p).to.equal('101');
    expect(env.t).to.equal('0');
  });

  it('decodes a response envelope back to its business object', () => {
    const payload = { code: 1, data: { uid: '42' }, desc: 'ok' };
    const inner = JSON.stringify({ data: Buffer.from(JSON.stringify(payload)).toString('base64') });
    const cipher = crypto.createCipheriv('aes-128-cbc', SESSION_KEY, Buffer.alloc(16));
    const r = Buffer.concat([cipher.update(inner), cipher.final()]).toString('base64');
    expect(decodeResponse({ r })).to.deep.equal(payload);
  });

  it('passes a body without an envelope through unchanged', () => {
    expect(decodeResponse({ code: 1 })).to.deep.equal({ code: 1 });
  });
});

describe('appApi pyJson', () => {
  it('matches Python json.dumps(separators, ensure_ascii) for non-ASCII', () => {
    expect(pyJson({ name: 'Vor Carport äöü €' })).to.equal('{"name":"Vor Carport \\u00e4\\u00f6\\u00fc \\u20ac"}');
  });
  it('uses compact separators', () => {
    expect(pyJson({ a: 1, b: [2, 3] })).to.equal('{"a":1,"b":[2,3]}');
  });
});

describe('appApi passport signature', () => {
  it('writes the reference signature', () => {
    const headers = passportHeaders(
      '/v3/user/login',
      { username: 'a@b.de', password: 'pw', device: 'ANDROID' },
      '1762600000000',
    );
    expect(headers.sign).to.equal('0ba0b6af68694deb4b335cbbb010e6751e810559256234a4a77e4d8273d4dca6');
    expect(headers.clientId).to.equal('mowerbot_app_prod');
  });
});

describe('appApi zone encoding', () => {
  it('encodes zone ids little-endian for the start command', () => {
    expect(encodePartitionIds([18])).to.equal('1200');
    expect(encodePartitionIds([1219])).to.equal('c304');
    expect(encodePartitionIds([1219, 1220])).to.equal('c304c404');
    expect(encodePartitionIds([18, 1219, 1220, 1427, 1728])).to.equal('1200c304c4049305c006');
  });

  it('decodes partitionIdList big-endian, the other way round', () => {
    expect(decodePartitionIdList('04C3')).to.deep.equal([1219]);
    expect(decodePartitionIdList('0012')).to.deep.equal([18]);
    expect(decodePartitionIdList('')).to.deep.equal([]);
    expect(decodePartitionIdList('0000')).to.deep.equal([]);
    expect(decodePartitionIdList('zz')).to.deep.equal([]);
  });

  it('builds partitionSetup from reset and order', () => {
    expect(mowSetup(false, false)).to.equal(0x11);
    expect(mowSetup(false, true)).to.equal(0x12);
    expect(mowSetup(true, false)).to.equal(0x21);
    expect(mowSetup(true, true)).to.equal(0x22);
  });
});

describe('appApi model and region helpers', () => {
  it('knows the H3000 is a first-generation H mower (no custom zone order)', () => {
    expect(isH1Generation('H3000', 190000003)).to.equal(true);
    expect(isH1Generation('h3000', 0)).to.equal(true);
    expect(isH1Generation('H215', 0)).to.equal(false);
  });

  it('resolves region aliases and routes the password only to the owning region', () => {
    expect(canonicalRegion('eu')).to.equal('fra');
    expect(canonicalRegion('ore')).to.equal('us');
    expect(canonicalRegion('')).to.equal('fra');
    expect(passportHosts('eu')).to.include('api-passport-fra.willand.com');
    expect(mowerHosts('fra')[0]).to.equal('navimow-fra.ninebot.com');
  });
});

describe('appApi map parsing', () => {
  it('finds a usable map id and rejects the placeholder 0', () => {
    expect(
      resolveMapIds([
        { map_id: '0', map_base_id: '0' },
        { map_id: '1', map_base_id: '6201504' },
      ]),
    ).to.deep.equal({
      mapId: '1',
      mapBaseId: '6201504',
      editTime: '',
    });
    expect(resolveMapIds([])).to.equal(null);
  });

  it('parses zones from a map-detail string', () => {
    const data = {
      map_detail: JSON.stringify({ sub_maps: [{ id: 1219, name: 'Hauptzone', area: 1647.75 }, { id: 0 }] }),
    };
    expect(parseZonesFromMapDetail(data)).to.deep.equal([{ id: 1219, name: 'Hauptzone', area: 1647.75 }]);
    expect(parseZonesFromMapDetail('not json')).to.equal(null);
  });

  it('extracts the command number as the set/send answer carries it', () => {
    expect(commandNumber({ cmd_num: 'X1', status: 0 })).to.equal('X1');
    expect(commandNumber({ cmdNum: 'X2' })).to.equal('X2');
    expect(commandNumber('X3')).to.equal('X3');
    expect(commandNumber(true)).to.equal(null);
    expect(commandNumber({ status: 0 })).to.equal(null);
  });
});

describe('appApi client', () => {
  it('needs a 32-char hex device id', () => {
    const base = { credentials: () => null, log: { debug() {}, info() {}, warn() {} } };
    expect(() => new AppApiClient({ ...base, session: { deviceId: 'short' } })).to.throw();
    const client = new AppApiClient({ ...base, session: { deviceId: newDeviceId() } });
    expect(client.snapshot().deviceId).to.match(/^[0-9a-f]{32}$/);
  });

  it('keeps identity out of the HTTP headers (it travels encrypted)', () => {
    const client = new AppApiClient({
      session: { deviceId: newDeviceId(), uid: '42', tokens: { access_token: 'secret-token', region: 'fra' } },
      credentials: () => null,
      log: { debug() {}, info() {}, warn() {} },
    });
    const params = client.commonParams('secret-token', '42');
    expect(params.access_token).to.equal('secret-token');
    expect(JSON.stringify(Object.keys(params))).to.not.contain('Authorization');
  });

  it('returns data on code 1 and throws an AppApiError on a business error', async () => {
    // Seed a live session so callNow does not go through the login path; the http mock then
    // only answers the business call. The request body is the encrypted envelope, so the mock
    // keys off the path, not its contents.
    const answers = [
      { code: 1, data: { vehicle_state: '0101', soc: '54' } },
      { code: 4001, desc: 'nope' },
    ];
    const http = {
      request: async () => ({ status: 200, data: JSON.stringify(wrapEnvelope(answers.shift())) }),
    };
    const client = new AppApiClient({
      session: {
        deviceId: newDeviceId(),
        uid: '42',
        host: 'navimow-fra.ninebot.com',
        tokens: { access_token: 't', region: 'fra' },
      },
      credentials: () => null,
      log: { debug() {}, info() {}, warn() {} },
      http,
    });
    expect(await client.status('SN')).to.deep.equal({ vehicle_state: '0101', soc: '54' });
    let thrown = null;
    try {
      await client.status('SN');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).to.be.instanceOf(AppApiError);
    expect(String(thrown.code)).to.equal('4001');
  });
});
