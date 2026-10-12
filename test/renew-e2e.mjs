/**
 * End-to-end proof that dsh-minimax-connect can keep its own sign-in alive.
 *
 * The renewal branch only runs while the stored token is inside RENEW_MARGIN_MS
 * of expiry, so the test rewrites `expiresAtMs` to "about to expire" and then
 * calls the plugin's own renewCredential — the same function the live provider
 * calls. Nothing here is reimplemented: the grant, the lock, the generation bump
 * and the auth-state mirror all run as shipped.
 *
 * Run with:  node test/renew-e2e.mjs <authFile>
 *
 * This file lives next to the plugin source, but the plugin's peer imports
 * (`@deepseek-ai/schemastery`, `@earendil-works/pi-ai`) resolve through the
 * profile's node_modules. Run it from an installed copy — i.e. from inside
 * `<profile>/node_modules/dsh-minimax-connect/` — or the bare imports fail with
 * ERR_MODULE_NOT_FOUND before any of this runs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { __diagnostics as D } from '../lib/index.js';

const authFile = process.argv[2];
if (!authFile) {
  console.error('usage: node _renew-e2e.mjs <auth.json>');
  process.exit(2);
}

const read = () => {
  const parsed = JSON.parse(fs.readFileSync(authFile, 'utf8'));
  const key = Object.keys(parsed.records)[0];
  return { parsed, key, record: parsed.records[key] };
};

const stateFile = path.join(path.dirname(authFile), 'auth-state.json');
const readState = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));

const line = (label, value) => console.log(`${label.padEnd(26)} ${value}`);

console.log('===== BEFORE =====');
const before = read();
const beforeState = readState();
line('auth.json generation', before.record.generation);
line('state.json generation', beforeState.generation);
line('expires in (s)', Math.round((before.record.expiresAtMs - Date.now()) / 1000));
line('access token', before.record.accessToken.slice(0, 18) + '…');
line('refresh token', before.record.refreshToken.slice(0, 18) + '…');
line('nextGeneration()', D.nextGeneration(authFile, before.record));

// Push the credential into the renewal window without touching either token:
// only `expiresAtMs` moves, so a grant that never happens costs nothing.
const staged = structuredClone(before.parsed);
staged.records[before.key].expiresAtMs = Date.now() + 60_000;
fs.writeFileSync(authFile, JSON.stringify(staged), 'utf8');
line('staged expiresAtMs', 'now + 60s (renewal window)');

console.log('\n===== GRANT =====');
line('endpoint', D.OAUTH_TOKEN_ENDPOINT);
line('client_id', D.OAUTH_CLIENT_ID);
line('scope', D.OAUTH_SCOPE);
line('audience', D.OAUTH_AUDIENCE);
line('renewMarginMs', D.RENEW_MARGIN_MS);

const started = Date.now();
const result = await D.renewCredential(authFile);
const elapsed = Date.now() - started;

console.log('');
line('result.ok', result.ok);
line('result.adopted', result.adopted ?? false);
line('result.reason', result.reason ?? '(none)');
line('result.fatal', result.fatal ?? false);
line('result.generation', result.generation ?? '(none)');
line('elapsed (ms)', elapsed);

console.log('\n===== AFTER =====');
if (!result.ok) {
  console.log('RENEWAL FAILED — restoring the untouched credential is unnecessary:');
  console.log('the grant never succeeded, so the refresh token on disk is still the same one.');
  process.exit(1);
}

const after = read();
const afterState = readState();
line('auth.json generation', after.record.generation);
line('state.json generation', afterState.generation);
line('generations equal', after.record.generation === afterState.generation);
line('generation advanced', after.record.generation > before.record.generation);
line('expires in (s)', Math.round((after.record.expiresAtMs - Date.now()) / 1000));
line('access token changed', after.record.accessToken !== before.record.accessToken);
line('refresh token rotated', after.record.refreshToken !== before.record.refreshToken);
line('new access token', after.record.accessToken.slice(0, 18) + '…');
line('new refresh token', after.record.refreshToken.slice(0, 18) + '…');
line('tokenType', after.record.tokenType);
line('clientId', after.record.clientId);
line('audience', after.record.audience);
line('scopes', JSON.stringify(after.record.scopes));
line('loginEpoch preserved', after.record.loginEpoch === before.record.loginEpoch);
line('state.status', afterState.status);

// The new token has to be accepted by the model endpoint, or none of the above
// matters. This is the same request shape the provider sends in production.
console.log('\n===== LIVE PROOF (new token -> model endpoint) =====');
const credential = { token: after.record.accessToken, tokenType: after.record.tokenType, expiresAtMs: after.record.expiresAtMs };
const response = await fetch('https://agent.minimax.cn/mavis/api/v1/llm/v1/messages', {
  method: 'POST',
  headers: {
    authorization: `${credential.tokenType} ${credential.token}`,
    'content-type': 'application/json',
    accept: 'application/json',
  },
  body: JSON.stringify({ model: 'MiniMax-M3', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
});
line('HTTP status', response.status);
const text = await response.text();
line('body', text.slice(0, 200).replace(/\s+/g, ' '));
console.log(response.ok ? '\n>>> PASS: self-renewal works without MiniMax Code running.' : '\n>>> FAIL: the renewed token was rejected.');
process.exit(response.ok ? 0 : 1);
