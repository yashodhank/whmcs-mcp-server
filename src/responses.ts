/**
 * Standardized Response Builders for WHMCS MCP Server
 * 
 * Provides consistent response formatting across all tools,
 * making it easier for AI agents to parse and handle responses.
 */

import { getErrorGuidance, sanitizeErrorMessage, ErrorCode, ERROR_CODES } from './errors.js';

/**
 * Standard success response structure
 */
export interface SuccessResponse<T = unknown> {
  success: true;
  data: T;
  message?: string;
  warnings?: string[];
}

/**
 * Standard error response structure
 */
export interface ErrorResponse {
  success: false;
  isError: true;
  error: string;
  code?: ErrorCode;
  suggestion?: string;
  details?: unknown;
}

/**
 * Confirmation required response structure
 */
export interface ConfirmationResponse {
  success: false;
  requires_confirmation: true;
  confirmation_key: string;
  warning: string;
  action: string;
  threshold?: number;
}

/**
 * MCP tool content structure
 */
interface McpContent {
  type: 'text';
  text: string;
}

/**
 * MCP tool response structure
 */
interface McpToolResponse {
  content: McpContent[];
  isError?: boolean;
}

/**
 * Build a successful tool response
 * 
 * @param data - The response data
 * @param message - Optional success message
 * @param warnings - Optional warning messages
 * @returns Formatted MCP tool response
 */
export function success(
  data: unknown,
  message?: string,
  warnings?: string[]
): McpToolResponse {
  const response: SuccessResponse = {
    success: true,
    data,
    ...(message && { message }),
    ...(warnings?.length && { warnings }),
  };
  
  return {
    content: [{
      type: 'text',
      text: JSON.stringify(response),
    }],
  };
}

/**
 * Build an error tool response with optional guidance
 * 
 * @param errorMessage - The error message
 * @param code - Optional error code for programmatic handling
 * @param details - Optional additional error details
 * @returns Formatted MCP tool error response
 */
export function error(
  errorMessage: string,
  code?: ErrorCode,
  details?: unknown
): McpToolResponse {
  const sanitizedMessage = sanitizeErrorMessage(errorMessage);
  const suggestion = getErrorGuidance(sanitizedMessage);
  
  const response: ErrorResponse = {
    success: false,
    isError: true,
    error: sanitizedMessage,
  };
  
  if (code) {
    response.code = code;
  }
  if (suggestion) {
    response.suggestion = suggestion;
  }
  if (details !== undefined) {
    response.details = details;
  }
  
  return {
    content: [{
      type: 'text',
      text: JSON.stringify(response),
    }],
    isError: true,
  };
}

/**
 * Build a confirmation-required response for high-risk operations
 * 
 * @param action - The action requiring confirmation
 * @param warning - Warning message explaining why confirmation is needed
 * @param confirmationKey - The key to use for confirmation
 * @param threshold - Optional threshold that was exceeded
 * @returns Formatted MCP tool response requesting confirmation
 */
export function requiresConfirmation(
  action: string,
  warning: string,
  confirmationKey: string,
  threshold?: number
): McpToolResponse {
  const response: ConfirmationResponse = {
    success: false,
    requires_confirmation: true,
    confirmation_key: confirmationKey,
    warning,
    action,
    ...(threshold !== undefined && { threshold }),
  };
  
  return {
    content: [{
      type: 'text',
      text: JSON.stringify(response),
    }],
  };
}

/**
 * Build a rate limit exceeded response
 * 
 * @param retryAfterSeconds - Optional seconds until retry is allowed
 * @returns Formatted MCP tool error response
 */
export function rateLimited(retryAfterSeconds?: number): McpToolResponse {
  const message = retryAfterSeconds 
    ? `Rate limit exceeded. Please wait ${retryAfterSeconds} seconds before retrying.`
    : 'Rate limit exceeded. Please wait a moment before retrying.';
  
  return error(message, ERROR_CODES.RATE_LIMITED, { retryAfterSeconds });
}

/**
 * Build a mode restriction response
 * 
 * @param currentMode - The current MCP mode
 * @param requiredMode - The mode required for this operation
 * @returns Formatted MCP tool error response
 */
export function modeRestricted(
  currentMode: string,
  requiredMode = 'full'
): McpToolResponse {
  return error(
    `Operation not allowed in ${currentMode} mode. Requires ${requiredMode} mode.`,
    ERROR_CODES.MODE_RESTRICTED,
    { currentMode, requiredMode }
  );
}

/**
 * Build a validation error response
 * 
 * @param field - The field that failed validation
 * @param reason - The reason for validation failure
 * @returns Formatted MCP tool error response
 */
export function validationError(field: string, reason: string): McpToolResponse {
  return error(
    `Validation failed for '${field}': ${reason}`,
    ERROR_CODES.VALIDATION_FAILED,
    { field, reason }
  );
}

/**
 * Build a resource not found response
 * 
 * @param resourceType - The type of resource (client, invoice, etc.)
 * @param resourceId - The ID that was not found
 * @returns Formatted MCP tool error response
 */
export function notFound(resourceType: string, resourceId: string | number): McpToolResponse {
  return error(
    `${resourceType} not found: ${resourceId}`,
    ERROR_CODES.RESOURCE_NOT_FOUND,
    { resourceType, resourceId }
  );
}
