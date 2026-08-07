/**
 * Opt-in WHMCS database access for the owner-transfer feature. The pool is
 * created LAZILY on first use and ONLY when a DSN is configured — the default
 * deployment (no MCP_WHMCS_DB_*) opens no connection and holds no credentials.
 * Direct DB writes are used solely because the WHMCS API cannot reassign
 * service/invoice owners (see docs/runbooks/write-capability-probe.md).
 */
import mysql from 'mysql2/promise';
import { config } from '../config.js';

export interface DbConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  name: string;
  ssl: boolean;
}
export interface DbTx {
  query(sql: string, params: unknown[]): Promise<{ affectedRows: number; rows: unknown[] }>;
}

export function dbConfigFromEnv(): DbConfig {
  return {
    host: config.MCP_WHMCS_DB_HOST,
    port: config.MCP_WHMCS_DB_PORT,
    user: config.MCP_WHMCS_DB_USER,
    password: config.MCP_WHMCS_DB_PASSWORD,
    name: config.MCP_WHMCS_DB_NAME,
    ssl: config.MCP_WHMCS_DB_SSL,
  };
}
export function isDbConfigured(cfg: DbConfig = dbConfigFromEnv()): boolean {
  return cfg.host !== '' && cfg.user !== '' && cfg.name !== '';
}

let pool: mysql.Pool | undefined;
function getPool(cfg: DbConfig): mysql.Pool {
  if (!pool) {
    pool = mysql.createPool({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.name,
      connectionLimit: 4,
      waitForConnections: true,
      ...(cfg.ssl ? { ssl: {} } : {}),
    });
  }
  return pool;
}

export interface WhmcsDb {
  withTransaction<T>(fn: (tx: DbTx) => Promise<T>): Promise<T>;
}
export function getWhmcsDb(cfg: DbConfig = dbConfigFromEnv()): WhmcsDb {
  if (!isDbConfigured(cfg)) throw new Error('WhmcsDb: DB not configured');
  return {
    async withTransaction<T>(fn: (tx: DbTx) => Promise<T>): Promise<T> {
      const conn = await getPool(cfg).getConnection();
      try {
        await conn.beginTransaction();
        const tx: DbTx = {
          async query(sql, params) {
            const [res] = await conn.query(sql, params);
            const r = res as { affectedRows?: number };
            return {
              affectedRows: r.affectedRows ?? 0,
              rows: Array.isArray(res) ? (res as unknown[]) : [],
            };
          },
        };
        const out = await fn(tx);
        await conn.commit();
        return out;
      } catch (e) {
        try {
          await conn.rollback();
        } catch {
          /* best effort */
        }
        throw e;
      } finally {
        conn.release();
      }
    },
  };
}

/** Test-only: drop the cached pool so a new config takes effect. */
export function __resetPoolForTests(): void {
  pool = undefined;
}
