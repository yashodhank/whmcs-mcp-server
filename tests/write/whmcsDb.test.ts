import { describe, it, expect } from 'vitest';
import { isDbConfigured } from '../../src/whmcs/WhmcsDb.js';

describe('isDbConfigured', () => {
  it('false when host/user/name missing', () => {
    expect(
      isDbConfigured({ host: '', port: 3306, user: '', password: '', name: '', ssl: false })
    ).toBe(false);
    expect(
      isDbConfigured({ host: 'h', port: 3306, user: 'u', password: '', name: '', ssl: false })
    ).toBe(false);
  });
  it('true when host+user+name all set', () => {
    expect(
      isDbConfigured({ host: 'h', port: 3306, user: 'u', password: 'p', name: 'db', ssl: false })
    ).toBe(true);
  });
});
