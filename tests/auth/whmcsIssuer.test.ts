import { describe, it, expect } from 'vitest';
import {
  collectForbiddenWhmcsIssuers,
  issuerIsForbidden,
  normalizeIssuerUrl,
  oauthIssuersIncludeWhmcs,
  originFromApiUrl,
} from '../../src/auth/whmcsIssuer.js';

describe('whmcsIssuer', () => {
  it('strips /includes/api.php from the API URL', () => {
    expect(originFromApiUrl('https://my.securiace.com/includes/api.php')).toBe(
      'https://my.securiace.com'
    );
    expect(originFromApiUrl('https://my.securiace.com/')).toBe('https://my.securiace.com');
  });

  it('treats trailing slashes as the same issuer', () => {
    expect(normalizeIssuerUrl('https://my.securiace.com/')).toBe('https://my.securiace.com');
    expect(issuerIsForbidden('https://my.securiace.com/', ['https://my.securiace.com'])).toBe(true);
  });

  it('flags MCP_OAUTH_ISSUERS that include the WHMCS origin', () => {
    const forbidden = collectForbiddenWhmcsIssuers({
      apiUrl: 'https://my.securiace.com',
      oidcIssuer: 'https://my.securiace.com',
    });
    expect(oauthIssuersIncludeWhmcs(['https://as.example.com'], forbidden)).toBe(false);
    expect(oauthIssuersIncludeWhmcs(['https://my.securiace.com/'], forbidden)).toBe(true);
  });
});
