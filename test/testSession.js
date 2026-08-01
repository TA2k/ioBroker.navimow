'use strict';

const { expect } = require('chai');
const { parseSession, mapFileName, mapUrl } = require('../lib/session');

describe('session.parseSession', () => {
  it('reads a session written as JSON string', () => {
    expect(parseSession('{"access_token":"a","refresh_token":"r","expires_in":3600}')).to.deep.equal({
      access_token: 'a',
      refresh_token: 'r',
      expires_in: 3600,
    });
  });

  it('reads a session delivered as Buffer by the file storage', () => {
    expect(parseSession(Buffer.from('{"access_token":"a"}', 'utf8'))).to.deep.equal({ access_token: 'a' });
  });

  it('accepts the legacy state value that held a bare access token', () => {
    expect(parseSession('plain-token-value')).to.deep.equal({ access_token: 'plain-token-value' });
  });

  it('rejects empty, missing and structurally unusable input', () => {
    expect(parseSession(null)).to.equal(null);
    expect(parseSession(undefined)).to.equal(null);
    expect(parseSession('')).to.equal(null);
    expect(parseSession('   ')).to.equal(null);
    expect(parseSession('{}')).to.equal(null);
    expect(parseSession('{"refresh_token":"r"}')).to.equal(null);
    expect(parseSession('[1,2,3]')).to.equal(null);
  });
});

describe('session map paths', () => {
  it('builds file name and URL from the sanitized device id', () => {
    expect(mapFileName('DEV1')).to.equal('map/DEV1.png');
    expect(mapUrl('navimow.0', 'DEV1')).to.equal('/files/navimow.0/map/DEV1.png');
  });
});
