import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('WHMCS_API_URL host guard (MCP_ENV)', () => {
  const envBackup = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...envBackup };
  });

  it('allows localhost when MCP_ENV=local', async () => {
    process.env.MCP_ENV = 'local';
    process.env.WHMCS_API_URL = 'http://localhost:8080/includes/api.php';
    process.env.WHMCS_ALLOW_HTTP = 'true';
    process.env.WHMCS_IDENTIFIER = 'id';
    process.env.WHMCS_SECRET = 'secret';
    const { config } = await import('../src/config.js');
    expect(config.WHMCS_API_URL).toContain('localhost');
  });

  it('rejects private hosts when MCP_ENV=production', async () => {
    process.env.MCP_ENV = 'production';
    process.env.WHMCS_API_URL = 'https://192.168.1.10/includes/api.php';
    process.env.WHMCS_IDENTIFIER = 'id';
    process.env.WHMCS_SECRET = 'secret';
    await expect(import('../src/config.js')).rejects.toThrow();
  });
});
