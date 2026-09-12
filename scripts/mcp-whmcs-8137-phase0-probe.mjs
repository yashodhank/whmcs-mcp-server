#!/usr/bin/env node
/**
 * Read-only Phase 0 probe for production WHMCS 8.13.7.
 * Never prints identifier/secret/token values.
 */
import { writeSync } from 'node:fs';

function originFromApiUrl(raw) {
  const trimmed = String(raw ?? '').trim().replace(/\/+$/, '');
  if (/\/includes\/api\.php$/i.test(trimmed)) {
    return trimmed.replace(/\/includes\/api\.php$/i, '');
  }
  return trimmed;
}

async function fetchJson(url) {
  try {
    const res = await fetch(url);
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

async function adminAction(endpoint, identifier, secret, action, extra = {}) {
  const body = new URLSearchParams({
    identifier,
    secret,
    action,
    responsetype: 'json',
    ...extra,
  });
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { parse_error: true };
  }
  return { http: res.status, result: parsed?.result, message: parsed?.message, keys: parsed && typeof parsed === 'object' ? Object.keys(parsed) : [] };
}

const apiUrl = process.env.WHMCS_API_URL;
const identifier = process.env.WHMCS_IDENTIFIER;
const secret = process.env.WHMCS_SECRET;
const origin = originFromApiUrl(apiUrl ?? 'https://my.securiace.com');

const out = {
  at: new Date().toISOString(),
  origin,
  oidc_php: await fetchJson(`${origin}/oauth/openid-configuration.php`),
  oidc_well_known: await fetchJson(`${origin}/.well-known/openid-configuration`),
  jwks: await fetchJson(`${origin}/oauth/certs.php`),
  admin_api: 'skipped_no_credentials',
};

if (out.jwks.body && Array.isArray(out.jwks.body.keys)) {
  out.jwks = { ...out.jwks, key_count: out.jwks.body.keys.length, body: { keys: `[${out.jwks.body.keys.length} keys]` } };
}
if (out.oidc_php.body) {
  out.oidc_php = {
    ok: out.oidc_php.ok,
    status: out.oidc_php.status,
    issuer: out.oidc_php.body.issuer,
    authorization_endpoint: out.oidc_php.body.authorization_endpoint,
    token_endpoint: out.oidc_php.body.token_endpoint,
    userinfo_endpoint: out.oidc_php.body.userinfo_endpoint,
    jwks_uri: out.oidc_php.body.jwks_uri,
    scopes_supported: out.oidc_php.body.scopes_supported,
    id_token_signing_alg_values_supported: out.oidc_php.body.id_token_signing_alg_values_supported,
    claims_supported: out.oidc_php.body.claims_supported,
    response_types_supported: out.oidc_php.body.response_types_supported,
  };
}

if (apiUrl && identifier && secret) {
  const endpoint = /\/includes\/api\.php$/i.test(apiUrl.trim())
    ? apiUrl.trim()
    : `${apiUrl.replace(/\/+$/, '')}/includes/api.php`;
  out.admin_api = {
    GetConfigurationValue_Version: await adminAction(endpoint, identifier, secret, 'GetConfigurationValue', {
      setting: 'Version',
    }),
    GetAdminDetails: await adminAction(endpoint, identifier, secret, 'GetAdminDetails'),
    WhmcsDetails: await adminAction(endpoint, identifier, secret, 'WhmcsDetails'),
    GetUsers: await adminAction(endpoint, identifier, secret, 'GetUsers', { limitnum: '1' }),
  };
}

writeSync(2, `${JSON.stringify(out, null, 2)}\n`);
