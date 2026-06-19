/**
 * Centralized Error Handling for WHMCS MCP Server
 *
 * Provides human-readable error messages with actionable guidance
 * for common WHMCS API errors and tool failures.
 */

/**
 * Human-friendly error guidance for common WHMCS issues
 * Maps error patterns to actionable suggestions
 */
export const ERROR_GUIDANCE: Record<string, string> = {
  // Client-related errors
  'client not found': 'The client ID does not exist. Use search_clients to find valid client IDs.',
  'duplicate email':
    'A client with this email already exists. Use search_clients to find them, or set mode to "reuse_if_exists".',
  'invalid email': 'The email format is invalid. Ensure it follows the format: user@domain.com',

  // Invoice-related errors
  'invoice not found':
    "The invoice ID does not exist. Check the client's invoice list with get_invoice.",
  'invoice already paid':
    'This invoice has already been paid. Check the current status before attempting payment.',
  'invalid invoice status': 'The operation cannot be performed on an invoice with this status.',

  // Payment-related errors
  'payment declined':
    'The payment gateway rejected the transaction. Check card details or try a different payment method.',
  'gateway error':
    'The payment gateway returned an error. This may be a temporary issue - try again later.',
  'insufficient funds': 'The payment was declined due to insufficient funds on the payment method.',

  // Service-related errors
  'service not found':
    "The service ID does not exist. Use the client's product list to find valid service IDs.",
  'service already suspended': 'The service is already in suspended state. No action needed.',
  'service not suspended': 'Cannot unsuspend a service that is not currently suspended.',
  'service already terminated':
    'The service has already been terminated. This action cannot be undone.',

  // Domain-related errors
  'domain not available': 'The domain is already registered or the TLD is not configured in WHMCS.',
  'invalid domain': 'The domain format is invalid. Expected format: example.com',
  'tld not configured':
    'This TLD is not configured for registration. Check WHMCS domain pricing settings.',

  // Permission-related errors
  'access denied':
    'API credentials lack permission for this action. Check WHMCS Setup → Staff Management → API Roles.',
  'authentication failed':
    'API authentication failed. Verify WHMCS_IDENTIFIER and WHMCS_SECRET are correct.',
  'ip not allowed':
    'Your server IP is not in the WHMCS API whitelist. Add it in Setup → General Settings → Security.',

  // Rate limiting
  'rate limit exceeded': 'Too many requests in a short time. Wait 10-30 seconds before retrying.',

  // Mode restrictions
  'read_only mode':
    'This operation is not allowed in read_only mode. Change MCP_MODE to "simulate" or "full".',
  'simulate mode': 'Running in simulate mode - no actual changes were made to WHMCS.',
};

/**
 * Error code constants for programmatic error handling
 */
export const ERROR_CODES = {
  // Validation errors
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  INVALID_INPUT: 'INVALID_INPUT',
  MISSING_REQUIRED: 'MISSING_REQUIRED',

  // Business logic errors
  BUSINESS_ERROR: 'BUSINESS_ERROR',
  RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',
  DUPLICATE_RESOURCE: 'DUPLICATE_RESOURCE',
  INVALID_STATE: 'INVALID_STATE',

  // Permission errors
  ACCESS_DENIED: 'ACCESS_DENIED',
  MODE_RESTRICTED: 'MODE_RESTRICTED',

  // Rate limiting
  RATE_LIMITED: 'RATE_LIMITED',
  IDEMPOTENT_CACHED: 'IDEMPOTENT_CACHED',

  // Transport errors
  TRANSPORT_ERROR: 'TRANSPORT_ERROR',
  TIMEOUT: 'TIMEOUT',
  CONNECTION_FAILED: 'CONNECTION_FAILED',

  // Safety checks
  REQUIRES_CONFIRMATION: 'REQUIRES_CONFIRMATION',
  THRESHOLD_EXCEEDED: 'THRESHOLD_EXCEEDED',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/**
 * Get human-readable error message with actionable guidance
 *
 * @param error - The original error message
 * @returns Enhanced error message with suggestion, or original if no match found
 */
export function getHumanReadableError(error: string): string {
  const lowerError = error.toLowerCase();

  for (const [pattern, guidance] of Object.entries(ERROR_GUIDANCE)) {
    if (lowerError.includes(pattern.toLowerCase())) {
      return `${error}\n\n💡 Suggestion: ${guidance}`;
    }
  }

  return error;
}

/**
 * Get guidance for a specific error without modifying the original message
 *
 * @param error - The error message to get guidance for
 * @returns Guidance string or undefined if no match
 */
export function getErrorGuidance(error: string): string | undefined {
  const lowerError = error.toLowerCase();

  for (const [pattern, guidance] of Object.entries(ERROR_GUIDANCE)) {
    if (lowerError.includes(pattern.toLowerCase())) {
      return guidance;
    }
  }

  return undefined;
}

/**
 * Sanitize error messages to remove sensitive data
 *
 * @param error - The error message to sanitize
 * @returns Sanitized error message
 */
export function sanitizeErrorMessage(error: string): string {
  let sanitized = error;

  // Query/form style: key=value
  const queryPatterns = [
    /identifier=\S+/gi,
    /secret=\S+/gi,
    /password=\S+/gi,
    /token=\S+/gi,
    /api[_-]?key=\S+/gi,
    /accesskey=\S+/gi,
  ];
  for (const pattern of queryPatterns) {
    sanitized = sanitized.replaceAll(pattern, '[REDACTED]');
  }

  // JSON style: "key":"value" (preserve the key, redact the value)
  sanitized = sanitized.replace(
    /"(identifier|secret|password|token|api[_-]?key|accesskey)"\s*:\s*"[^"]*"/gi,
    '"$1":"[REDACTED]"'
  );

  // HTTP Authorization headers: Bearer / Basic credentials
  sanitized = sanitized.replace(
    /Authorization:\s*(Bearer|Basic)\s+\S+/gi,
    'Authorization: $1 [REDACTED]'
  );

  return sanitized;
}
