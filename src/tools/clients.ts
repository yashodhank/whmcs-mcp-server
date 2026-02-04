/**
 * Client Management Tools for WHMCS MCP Server
 * 
 * Tools: create_client, search_clients, get_client_details
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WhmcsClient, WhmcsBusinessError } from '../whmcs/WhmcsClient.js';
import { Logger } from '../logging.js';
import { RateLimiter, RateLimitError } from '../rateLimiter.js';
import { config, isToolAllowed } from '../config.js';
import { ensureToolAuth, clientModeDenied, isClientMode, ensureClientAllowed, ensureClientOwnership, AUTH_SHAPE } from '../security.js';
import { normalizeToArray } from '../whmcs/normalizers.js';
import crypto from 'node:crypto';

const TOOL_VERSION = 'v1';

/**
 * Client summary from GetClients
 */
interface WhmcsClientSummary {
  id: number;
  firstname: string;
  lastname: string;
  email: string;
  companyname?: string;
}

/**
 * Full client details from GetClientsDetails
 */
interface WhmcsClientDetails {
  id: number;
  firstname: string;
  lastname: string;
  fullname: string;
  email: string;
  companyname?: string;
  address1?: string;
  address2?: string;
  city?: string;
  state?: string;
  postcode?: string;
  country?: string;
  phonenumber?: string;
  status: string;
  credit: string;
  currency_code: string;
  defaultgateway?: string;
  numproducts?: number;
  numdomains?: number;
  customfields?: Array<{ id: number; value: string }>;
}

/**
 * Sanitize text input to prevent injection attacks
 * Removes potentially dangerous characters while preserving legitimate input
 */
function sanitizeTextInput(input: string): string {
  return input
    .replaceAll(/[<>]/g, '') // Remove HTML-like angle brackets
    .replaceAll(/[\x00-\x1F\x7F]/g, '') // Remove control characters
    .trim();
}

/**
 * Normalize email address to lowercase for consistent matching
 */
function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}

/**
 * Generate a secure random password with guaranteed character diversity
 * Ensures at least one lowercase, uppercase, digit, and special character
 */
function generateSecurePassword(length: number = 16): string {
  const lowercase = 'abcdefghijklmnopqrstuvwxyz';
  const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const digits = '0123456789';
  const special = '!@#$%^&*';
  const allChars = lowercase + uppercase + digits + special;
  
  // Ensure at least one character from each category
  const bytes = crypto.randomBytes(length);
  const required = [
    lowercase[bytes[0] % lowercase.length],
    uppercase[bytes[1] % uppercase.length],
    digits[bytes[2] % digits.length],
    special[bytes[3] % special.length],
  ];
  
  // Fill remaining with random characters
  let password = '';
  for (let i = 4; i < length; i++) {
    password += allChars[bytes[i] % allChars.length];
  }
  
  // Combine and shuffle
  const combined = required.join('') + password;
  const shuffled = combined.split('').sort(() => Math.random() - 0.5).join('');
  
  return shuffled;
}

/**
 * Create client input schema
 */
const createClientSchema = z.object({
  firstname: z.string().min(1, 'First name is required'),
  lastname: z.string().min(1, 'Last name is required'),
  email: z.string().email('Valid email is required'),
  country: z.string().length(2, 'Country must be 2-letter ISO code'),
  company: z.string().optional(),
  address1: z.string().optional(),
  address2: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  postcode: z.string().optional(),
  phonenumber: z.string().optional(),
  password: z.string().optional(),
  owner_user_id: z.number().int().optional(),
  send_email: z.boolean().default(false).describe('Send welcome email'),
  skip_validation: z.boolean().default(false).describe('Bypass WHMCS required-field validation'),
  mode: z.enum(['create_only', 'reuse_if_exists']).default('reuse_if_exists'),
}).superRefine((val, ctx) => {
  if (val.skip_validation) {
    return;
  }
  const requiredFields: Array<keyof typeof val> = [
    'address1',
    'city',
    'state',
    'postcode',
    'phonenumber',
  ];
  for (const field of requiredFields) {
    if (!val[field] || String(val[field]).trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `${field} is required unless skip_validation=true`,
      });
    }
  }
});

/**
 * Search clients input schema
 */
const searchClientsSchema = z.object({
  search: z.string().optional(),
  limit: z.number().int().min(1).max(config.MCP_MAX_PAGE_SIZE).default(25),
  offset: z.number().int().min(0).default(0),
});

/**
 * Get client details input schema
 */
const getClientDetailsSchema = z.object({
  clientid: z.number().int().positive('Client ID must be positive'),
});

/**
 * Check if a client exists by email (for reuse_if_exists mode)
 */
async function checkClientExists(
  whmcsClient: WhmcsClient,
  normalizedEmail: string
): Promise<WhmcsClientSummary | undefined> {
  const searchResult = await whmcsClient.read<{
    clients?: { client?: WhmcsClientSummary[] };
    totalresults?: number;
  }>('GetClients', {
    search: normalizedEmail,
    limitnum: 1,
  });
  
  const clients = normalizeToArray<WhmcsClientSummary>(
    searchResult.clients?.client
  );
  
  return clients.find(
    (c) => normalizeEmail(c.email) === normalizedEmail
  );
}

/**
 * Perform client creation via WHMCS API
 */
async function performClientCreation(
  whmcsClient: WhmcsClient,
  params: z.infer<typeof createClientSchema>,
  normalizedEmail: string
): Promise<{ clientid: number; created: boolean }> {
  const sanitizedFirstname = sanitizeTextInput(params.firstname);
  const sanitizedLastname = sanitizeTextInput(params.lastname);
  const sanitizedCompany = params.company ? sanitizeTextInput(params.company) : undefined;
  
  // Generate password if not provided
  const password = params.password || generateSecurePassword();
  
  const createResult = await whmcsClient.mutate<{
    clientid: number;
    owner_id?: number;
  }>('AddClient', {
    firstname: sanitizedFirstname,
    lastname: sanitizedLastname,
    email: normalizedEmail,
    country: params.country.toUpperCase(), // Normalize country code
    companyname: sanitizedCompany,
    address1: params.address1 ? sanitizeTextInput(params.address1) : undefined,
    address2: params.address2 ? sanitizeTextInput(params.address2) : undefined,
    city: params.city ? sanitizeTextInput(params.city) : undefined,
    state: params.state ? sanitizeTextInput(params.state) : undefined,
    postcode: params.postcode ? sanitizeTextInput(params.postcode) : undefined,
    phonenumber: params.phonenumber || undefined,
    password2: password,
    owner_user_id: params.owner_user_id,
    noemail: params.send_email ? false : true,
    skipvalidation: params.skip_validation ? true : undefined,
  }, {
    clientid: Math.floor(Math.random() * 10000) + 1000,
  });
  
  return {
    clientid: createResult.clientid,
    created: true,
  };
}

/**
 * Register client management tools
 */
export function registerClientTools(
  server: McpServer,
  whmcsClient: WhmcsClient,
  logger: Logger,
  rateLimiter: RateLimiter
): void {
  
  // ============================================
  // Tool: create_client
  // ============================================
  if (isToolAllowed('create_client')) {
    server.tool(
      'create_client',
      `Create a new WHMCS client or reuse existing one by email. Version: ${TOOL_VERSION}`,
      { ...createClientSchema.shape, ...AUTH_SHAPE },
      async (params) => {
        const toolLogger = logger.child();
        const startTime = Date.now();
        
        try {
          const authError = ensureToolAuth(params as Record<string, unknown>);
          if (authError) return authError;

          if (isClientMode()) {
            return clientModeDenied('create_client');
          }

          toolLogger.logToolCall('create_client', params, true);
          
          // Check rate limit
          if (!rateLimiter.tryConsume()) {
            throw new RateLimitError();
          }
          
          // Check mode restriction for mutating operation
          if (whmcsClient.isReadOnly()) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  isError: true,
                  error: 'Tool not available in read_only mode',
                }),
              }],
              isError: true,
            };
          }
          
          // Normalize and sanitize inputs
          const normalizedEmail = normalizeEmail(params.email);
          
          // Reuse logic: search for existing client
          if (params.mode === 'reuse_if_exists') {
            const existing = await checkClientExists(whmcsClient, normalizedEmail);
            
            if (existing) {
              toolLogger.logToolResult('create_client', true, Date.now() - startTime);
              return {
                content: [{
                  type: 'text' as const,
                  text: JSON.stringify({
                    clientid: existing.id,
                    created: false,
                    message: 'Existing client found and reused',
                  }),
                }],
              };
            }
          }
          
          // Create new client
          const result = await performClientCreation(whmcsClient, params, normalizedEmail);
          
          toolLogger.logToolResult('create_client', true, Date.now() - startTime);
          
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify(result),
            }],
          };
          
        } catch (error) {
          toolLogger.logToolResult('create_client', false, Date.now() - startTime, 
            error instanceof Error ? error.message : String(error));
          
          if (error instanceof RateLimitError) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ isError: true, error: error.message }) }],
              isError: true,
            };
          }
          
          if (error instanceof WhmcsBusinessError) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ isError: true, error: error.message, code: error.code }) }],
              isError: true,
            };
          }
          
          throw error;
        }
      }
    );
  }
  
  // ============================================
  // Tool: search_clients
  // ============================================
  if (isToolAllowed('search_clients')) {
    server.tool(
      'search_clients',
      `Search for WHMCS clients by name, email, or company. Returns minimal summary. Version: ${TOOL_VERSION}`,
      { ...searchClientsSchema.shape, ...AUTH_SHAPE },
      async (params) => {
        const toolLogger = logger.child();
        const startTime = Date.now();
        
        try {
          const authError = ensureToolAuth(params as Record<string, unknown>);
          if (authError) return authError;

          if (isClientMode()) {
            return clientModeDenied('search_clients');
          }

          toolLogger.logToolCall('search_clients', params, false);
          
          if (!rateLimiter.tryConsume()) {
            throw new RateLimitError();
          }
          
          const result = await whmcsClient.read<{
            clients?: { client?: WhmcsClientSummary[] };
            totalresults?: number;
          }>('GetClients', {
            search: params.search,
            limitstart: params.offset,
            limitnum: params.limit,
          });
          
          const clients = normalizeToArray<WhmcsClientSummary>(result.clients?.client);
          
          // Return minimal summary
          const summary = clients.map((c) => ({
            clientid: c.id,
            firstname: c.firstname,
            lastname: c.lastname,
            email: c.email,
            companyname: c.companyname || null,
          }));
          
          toolLogger.logToolResult('search_clients', true, Date.now() - startTime);
          
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                clients: summary,
                total: result.totalresults || summary.length,
                offset: params.offset,
                limit: params.limit,
              }),
            }],
          };
          
        } catch (error) {
          toolLogger.logToolResult('search_clients', false, Date.now() - startTime,
            error instanceof Error ? error.message : String(error));
          
          if (error instanceof RateLimitError || error instanceof WhmcsBusinessError) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ isError: true, error: error.message }) }],
              isError: true,
            };
          }
          
          throw error;
        }
      }
    );
  }
  
  // ============================================
  // Tool: get_client_details
  // ============================================
  if (isToolAllowed('get_client_details')) {
    server.tool(
      'get_client_details',
      `Get full details for a specific WHMCS client including credit balance and custom fields. Version: ${TOOL_VERSION}`,
      { ...getClientDetailsSchema.shape, ...AUTH_SHAPE },
      async (params) => {
        const toolLogger = logger.child();
        const startTime = Date.now();
        
        try {
          const authError = ensureToolAuth(params as Record<string, unknown>);
          if (authError) return authError;

          if (isClientMode()) {
            const scopeError = ensureClientAllowed(params.clientid);
            if (scopeError) return scopeError;
          }

          toolLogger.logToolCall('get_client_details', params, false);
          
          if (!rateLimiter.tryConsume()) {
            throw new RateLimitError();
          }
          
          const result = await whmcsClient.read<WhmcsClientDetails>('GetClientsDetails', {
            clientid: params.clientid,
          });
          
          // Normalize custom fields
          const customfields = normalizeToArray<{ id: number; value: string }>(
            result.customfields
          ).map((cf) => ({ id: cf.id, value: cf.value }));
          
          toolLogger.logToolResult('get_client_details', true, Date.now() - startTime);
          
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                clientid: result.id,
                firstname: result.firstname,
                lastname: result.lastname,
                fullname: result.fullname,
                email: result.email,
                companyname: result.companyname || null,
                address1: result.address1 || null,
                city: result.city || null,
                state: result.state || null,
                postcode: result.postcode || null,
                country: result.country || null,
                phonenumber: result.phonenumber || null,
                status: result.status,
                credit_balance: result.credit,
                currency: result.currency_code,
                payment_gateway: result.defaultgateway || null,
                product_count: result.numproducts || 0,
                domain_count: result.numdomains || 0,
                custom_fields: customfields,
              }),
            }],
          };
          
        } catch (error) {
          toolLogger.logToolResult('get_client_details', false, Date.now() - startTime,
            error instanceof Error ? error.message : String(error));
          
          if (error instanceof RateLimitError || error instanceof WhmcsBusinessError) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ isError: true, error: error.message }) }],
              isError: true,
            };
          }
          
          throw error;
        }
      }
    );
  }
  
  // ============================================
  // Tool: update_client
  // ============================================
  if (isToolAllowed('update_client')) {
    const updateClientSchema = z.object({
      clientid: z.number().int().positive('Client ID must be positive'),
      firstname: z.string().optional(),
      lastname: z.string().optional(),
      email: z.string().email().optional(),
      companyname: z.string().optional(),
      address1: z.string().optional(),
      address2: z.string().optional(),
      city: z.string().optional(),
      state: z.string().optional(),
      postcode: z.string().optional(),
      country: z.string().optional(),
      phonenumber: z.string().optional(),
      notes: z.string().optional(),
    });
    
    server.tool(
      'update_client',
      `Update an existing client's details. Only provided fields will be updated. Version: ${TOOL_VERSION}`,
      { ...updateClientSchema.shape, ...AUTH_SHAPE },
      async (params) => {
        const toolLogger = logger.child();
        const startTime = Date.now();
        
        try {
          const authError = ensureToolAuth(params as Record<string, unknown>);
          if (authError) return authError;

          if (isClientMode()) {
            return clientModeDenied('update_client');
          }

          toolLogger.logToolCall('update_client', params, true);
          
          if (!rateLimiter.tryConsume()) {
            throw new RateLimitError();
          }
          
          if (whmcsClient.isReadOnly()) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ isError: true, error: 'Tool not available in read_only mode' }) }],
              isError: true,
            };
          }
          
          const { clientid, ...updateFields } = params;
          
          // Sanitize text inputs
          const sanitizedFields: Record<string, string | undefined> = {};
          for (const [key, value] of Object.entries(updateFields)) {
            if (value !== undefined) {
              sanitizedFields[key] = typeof value === 'string' ? sanitizeTextInput(value) : value;
            }
          }
          
          // Normalize email if provided
          if (sanitizedFields.email) {
            sanitizedFields.email = normalizeEmail(sanitizedFields.email);
          }
          
          const result = await whmcsClient.mutate<{ result: string; clientid?: number }>('UpdateClient', {
            clientid,
            ...sanitizedFields,
          });
          
          const success = result.result === 'success';
          
          toolLogger.logToolResult('update_client', success, Date.now() - startTime);
          
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                clientid,
                success,
                updated_fields: Object.keys(sanitizedFields),
              }),
            }],
          };
          
        } catch (error) {
          toolLogger.logToolResult('update_client', false, Date.now() - startTime,
            error instanceof Error ? error.message : String(error));
          
          if (error instanceof RateLimitError || error instanceof WhmcsBusinessError) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ isError: true, error: error.message }) }],
              isError: true,
            };
          }
          
          throw error;
        }
      }
    );
  }
  
  // ============================================
  // Tool: get_service_details
  // ============================================
  if (isToolAllowed('get_service_details')) {
    const getServiceDetailsSchema = z.object({
      serviceid: z.number().int().positive('Service ID must be positive'),
    });
    
    server.tool(
      'get_service_details',
      `Get detailed information about a client's service/product. Version: ${TOOL_VERSION}`,
      { ...getServiceDetailsSchema.shape, ...AUTH_SHAPE },
      async (params) => {
        const toolLogger = logger.child();
        const startTime = Date.now();
        
        try {
          const authError = ensureToolAuth(params as Record<string, unknown>);
          if (authError) return authError;

          toolLogger.logToolCall('get_service_details', params, false);
          
          if (!rateLimiter.tryConsume()) {
            throw new RateLimitError();
          }
          
          const result = await whmcsClient.read<{
            result: string;
            products?: {
              product?: Array<{
                id: number;
                clientid?: number;
                pid?: number;
                name?: string;
                domain?: string;
                status?: string;
                billingcycle?: string;
                nextduedate?: string;
                firstpaymentamount?: string;
                recurringamount?: string;
                paymentmethod?: string;
                regdate?: string;
                username?: string;
                server?: string;
                customfields?: unknown;
                configoptions?: unknown;
              }>;
            };
          }>('GetClientsProducts', {
            serviceid: params.serviceid,
            limitnum: 1,
          });
          
          const products = normalizeToArray<{
            id: number;
            clientid?: number;
            pid?: number;
            name?: string;
            domain?: string;
            status?: string;
            billingcycle?: string;
            nextduedate?: string;
            firstpaymentamount?: string;
            recurringamount?: string;
            paymentmethod?: string;
            regdate?: string;
            username?: string;
            server?: string;
            customfields?: unknown;
            configoptions?: unknown;
          }>(result.products?.product);
          const product = products[0];
          
          if (!product) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  isError: true,
                  error: `Service not found: ${params.serviceid}`,
                }),
              }],
              isError: true,
            };
          }

          if (isClientMode()) {
            if (!product.clientid) {
              return {
                content: [{
                  type: 'text' as const,
                  text: JSON.stringify({
                    isError: true,
                    error: 'Unable to validate service ownership for client access mode.',
                  }),
                }],
                isError: true,
              };
            }
            const ownershipError = ensureClientOwnership(product.clientid, params as Record<string, unknown>);
            if (ownershipError) return ownershipError;
          }
          
          // Normalize custom fields
          const customfieldsContainer = (product.customfields as { customfield?: unknown })?.customfield ?? product.customfields;
          const customfields = normalizeToArray<{ id: number; name: string; value: string }>(
            customfieldsContainer
          );
          
          const configoptionsContainer = (product.configoptions as { configoption?: unknown })?.configoption ?? product.configoptions;
          const configoptions = normalizeToArray<{ id: number; option: string; value: string }>(
            configoptionsContainer
          );
          
          toolLogger.logToolResult('get_service_details', true, Date.now() - startTime);
          
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                serviceid: product.id || params.serviceid,
                clientid: product.clientid,
                domain: product.domain,
                status: product.status,
                product: product.name,
                product_id: product.pid,
                billing_cycle: product.billingcycle,
                next_due_date: product.nextduedate,
                first_payment_amount: product.firstpaymentamount,
                recurring_amount: product.recurringamount,
                payment_method: product.paymentmethod,
                registration_date: product.regdate,
                username: product.username,
                server: product.server,
                custom_fields: customfields,
                config_options: configoptions,
              }),
            }],
          };
          
        } catch (error) {
          toolLogger.logToolResult('get_service_details', false, Date.now() - startTime,
            error instanceof Error ? error.message : String(error));
          
          if (error instanceof RateLimitError || error instanceof WhmcsBusinessError) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ isError: true, error: error.message }) }],
              isError: true,
            };
          }
          
          throw error;
        }
      }
    );
  }
}
