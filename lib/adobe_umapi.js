'use strict';
// Adobe Admin Console connection, through Adobe's official User Management API (UMAPI).
//
// Adobe licenses belong to PEOPLE (named users), assigned by adding them to product profiles in
// the Admin Console. UMAPI is Adobe's documented API for exactly that, so — unlike Maxon — the
// tracker can see every profile, its members and its license count, and later move a license
// between people. Only the connection is here for now: the views get built against Adobe's real
// answers, not assumptions.
//
// The credential is an OAuth Server-to-Server one a System Admin creates in the Adobe Developer
// Console (it also shows up, and can be revoked, in Admin Console > Users > API credentials).
// Its secret is written to the server's config only and never sent back to any browser.
const https = require('node:https');

const IMS = 'https://ims-na1.adobelogin.com/ims/token/v3';
const API = 'https://usermanagement.adobe.io/v2/usermanagement';

function request(method, url, { headers = {}, body = null, timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!/^https:/.test(url)) return reject(new Error('refusing non-https URL'));
    const req = https.request(url, { method, headers, timeout }, (res) => {
      let d = ''; res.setEncoding('utf8');
      res.on('data', (c) => { d += c; if (d.length > 5e6) req.destroy(new Error('response too large')); });
      res.on('end', () => {
        let json = null; try { json = JSON.parse(d); } catch { /* not json */ }
        resolve({ status: res.statusCode, json, text: d, retryAfter: res.headers['retry-after'] });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Adobe did not answer in time')));
    if (body) req.write(body);
    req.end();
  });
}

function createAdobe(getConfig) {
  let token = null;   // { value, until }
  let lastTest = null;

  const cred = () => (getConfig().adobe || {});
  const configured = () => { const c = cred(); return !!(c.orgId && c.clientId && c.clientSecret); };

  async function accessToken() {
    if (token && Date.now() < token.until - 5 * 60 * 1000) return token.value;
    const c = cred();
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: c.clientId, client_secret: c.clientSecret,
      scope: c.scopes || 'openid,AdobeID,user_management_sdk' }).toString();
    const r = await request('POST', IMS, { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }, body });
    if (r.status !== 200 || !r.json || !r.json.access_token) {
      const why = (r.json && (r.json.error_description || r.json.error)) || `HTTP ${r.status}`;
      throw new Error(`Adobe refused the credential: ${why}`);
    }
    token = { value: r.json.access_token, until: Date.now() + (Number(r.json.expires_in) || 86400) * 1000 };
    return token.value;
  }

  async function get(path) {
    const c = cred();
    const r = await request('GET', `${API}/${path}`, {
      headers: { Authorization: `Bearer ${await accessToken()}`, 'x-api-key': c.clientId, Accept: 'application/json' },
    });
    if (r.status === 429) throw new Error(`Adobe is rate-limiting requests — try again in ${r.retryAfter || 'a few'} seconds`);
    if (r.status !== 200 || !r.json) throw new Error(`Adobe answered HTTP ${r.status}${r.json && r.json.message ? `: ${r.json.message}` : ''}`);
    return r.json;
  }

  // One round trip each to users and groups: proves the credential, the org and the API access,
  // and reports only what Adobe itself said.
  async function test() {
    const c = cred();
    try {
      const users = await get(`users/${encodeURIComponent(c.orgId)}/0`);
      const groups = await get(`groups/${encodeURIComponent(c.orgId)}/0`);
      const profiles = (groups.groups || []).filter((g) => /PRODUCT_PROFILE/i.test(g.type || ''));
      lastTest = {
        ok: true, at: Date.now(),
        users: (users.users || []).length, usersMore: users.lastPage === false,
        groups: (groups.groups || []).length, groupsMore: groups.lastPage === false, productProfiles: profiles.length,
        message: 'Connected — Adobe answered for this organization.',
      };
    } catch (e) {
      token = null;
      lastTest = { ok: false, at: Date.now(), message: e.message };
    }
    return lastTest;
  }

  function status() {
    const c = cred();
    return {
      configured: configured(), orgId: c.orgId || null,
      clientId: c.clientId ? `${c.clientId.slice(0, 6)}…${c.clientId.slice(-4)}` : null,
      scopes: c.scopes || null, lastTest,
    };
  }

  function forget() { token = null; lastTest = null; }

  return { configured, test, status, forget };
}

module.exports = { createAdobe };
