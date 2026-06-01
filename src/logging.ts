/**
 * Logging module for WHMCS MCP Server
 * 
 * CRITICAL: All logs go to stderr ONLY
 * stdout is reserved for JSON-RPC protocol communication
 */

import { v4 as uuidv4 } from 'uuid';
import { config } from './config.js';

/**
 * Log levels
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Log entry structure
 */
interface LogEntry {
  timestamp: string;
  level: LogLevel;
  correlationId: string;
  message: string;
  data?: Record<string, unknown>;
}

/**
 * Fields that should be redacted in logs
 */
/**
 * Fields that should be redacted in logs
 * Includes common sensitive data patterns for security
 */
const SENSITIVE_FIELDS = [
  // API credentials
  'secret',
  'password',
  'WHMCS_SECRET',
  'WHMCS_IDENTIFIER',
  'token',
  'apikey',
  'api_key',
  'authorization',
  'bearer',
  'auth_token',
  'mcp_auth_token',
  'accesskey',
  'access_key',
  'WHMCS_ACCESS_KEY',
  // Payment data (PCI compliance)
  'cvv',
  'cardnumber',
  'cardcvv',
  'card_number',
  'credit_card',
  'ccnumber',
  'cardexpiry',
  // Session & auth
  'cookie',
  'session',
  'sessionid',
  'session_id',
  // Personal identifiers
  'ssn',
  'pin',
  'taxid',
  'tax_id',
];

/**
 * Redact sensitive fields from an object
 */
function redactSensitive(data: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  
  for (const [key, value] of Object.entries(data)) {
    if (SENSITIVE_FIELDS.some((field) => key.toLowerCase().includes(field.toLowerCase()))) {
      redacted[key] = '[REDACTED]';
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      redacted[key] = redactSensitive(value as Record<string, unknown>);
    } else {
      redacted[key] = value;
    }
  }
  
  return redacted;
}

/**
 * Logger class for MCP server
 * Writes ALL output to stderr to avoid corrupting JSON-RPC on stdout
 */
export class Logger {
  private readonly correlationId: string;
  private readonly debugEnabled: boolean;

  constructor(correlationId?: string) {
    this.correlationId = correlationId ?? uuidv4();
    this.debugEnabled = config.MCP_DEBUG;
  }

  /**
   * Create a child logger with the same correlation ID
   */
  child(): Logger {
    return new Logger(this.correlationId);
  }

  /**
   * Create a new logger with a fresh correlation ID
   */
  static create(): Logger {
    return new Logger();
  }

  /**
   * Get the current correlation ID
   */
  getCorrelationId(): string {
    return this.correlationId;
  }

  /**
   * Format and write a log entry to stderr
   */
  private log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    // Skip debug logs if not enabled
    if (level === 'debug' && !this.debugEnabled) {
      return;
    }

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      correlationId: this.correlationId,
      message,
      data: data ? redactSensitive(data) : undefined,
    };

    // Write to stderr with JSON format for structured logging
    const output = JSON.stringify(entry);
    process.stderr.write(`${output}\n`);
  }

  /**
   * Debug level log (only shown when MCP_DEBUG is true)
   */
  debug(message: string, data?: Record<string, unknown>): void {
    this.log('debug', message, data);
  }

  /**
   * Info level log
   */
  info(message: string, data?: Record<string, unknown>): void {
    this.log('info', message, data);
  }

  /**
   * Warning level log
   */
  warn(message: string, data?: Record<string, unknown>): void {
    this.log('warn', message, data);
  }

  /**
   * Error level log
   */
  error(message: string, data?: Record<string, unknown>): void {
    this.log('error', message, data);
  }

  /**
   * Log a tool invocation
   */
  logToolCall(
    toolName: string,
    inputs: Record<string, unknown>,
    isMutating: boolean
  ): void {
    this.info(`Tool invoked: ${toolName}`, {
      toolName,
      inputs,
      isMutating,
    });
  }

  /**
   * Log a tool result
   */
  logToolResult(
    toolName: string,
    success: boolean,
    executionTimeMs: number,
    error?: string
  ): void {
    const level = success ? 'info' : 'error';
    this.log(level, `Tool completed: ${toolName}`, {
      toolName,
      success,
      executionTimeMs,
      error,
    });
  }

  /**
   * Log a WHMCS API call
   */
  logWhmcsCall(
    action: string,
    params: Record<string, unknown>,
    isMutating: boolean
  ): void {
    this.debug(`WHMCS API call: ${action}`, {
      whmcsAction: action,
      params,
      isMutating,
    });
  }
}

// Export default logger instance
export const logger = Logger.create();
