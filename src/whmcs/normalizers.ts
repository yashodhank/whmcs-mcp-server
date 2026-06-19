/**
 * WHMCS Response Normalizers
 *
 * WHMCS API responses have quirky JSON structures where arrays may be:
 * - [] (proper array)
 * - {} (empty object)
 * - {"0": {...}, "1": {...}} (object with numeric keys)
 *
 * These utilities normalize such responses into proper arrays.
 */

/**
 * Check if a value is an object with numeric string keys (WHMCS array format)
 */
function isNumericKeyedObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const keys = Object.keys(value);
  if (keys.length === 0) {
    return false;
  }

  // Check if all keys are numeric strings
  return keys.every((key) => /^\d+$/.test(key));
}

/**
 * Normalize a WHMCS response field to a proper array
 * Handles: proper arrays, empty objects, and numeric-keyed objects
 */
export function normalizeToArray<T>(value: unknown): T[] {
  // Already an array
  if (Array.isArray(value)) {
    return value as T[];
  }

  // Null/undefined
  if (value === null || value === undefined) {
    return [];
  }

  // Not an object
  if (typeof value !== 'object') {
    return [];
  }

  // Empty object → empty array
  const obj = value as Record<string, unknown>;
  if (Object.keys(obj).length === 0) {
    return [];
  }

  // Numeric-keyed object → array
  if (isNumericKeyedObject(obj)) {
    const keys = Object.keys(obj)
      .map(Number)
      .sort((a, b) => a - b);
    return keys.map((key) => obj[String(key)] as T);
  }

  // Single object (not an array structure) → wrap in array
  // This handles cases where WHMCS returns a single item as an object
  return [obj as T];
}

/**
 * Known field paths in WHMCS responses that need normalization
 */
type NormalizerKey =
  | 'clients'
  | 'invoices'
  | 'items'
  | 'transactions'
  | 'tickets'
  | 'products'
  | 'services'
  | 'domains'
  | 'orders'
  | 'replies'
  | 'notes'
  | 'customfields';

/**
 * Plural container key → its WHMCS singular child key.
 * Explicit map (NOT naive `replace(/s$/, '')`, which mis-derives the
 * irregular plural 'replies' → 'replie' instead of 'reply').
 */
const SINGULAR: Record<NormalizerKey, string> = {
  clients: 'client',
  invoices: 'invoice',
  items: 'item',
  transactions: 'transaction',
  tickets: 'ticket',
  products: 'product',
  services: 'service',
  domains: 'domain',
  orders: 'order',
  replies: 'reply',
  notes: 'note',
  customfields: 'customfield',
};

/**
 * Field paths to normalize for each WHMCS action
 */
const NORMALIZER_PATHS: Record<string, NormalizerKey[]> = {
  GetClients: ['clients'],
  GetClientsDetails: ['customfields'],
  GetInvoice: ['items', 'transactions'],
  GetInvoices: ['invoices'],
  GetProducts: ['products'],
  GetTickets: ['tickets'],
  GetTicket: ['replies', 'notes'],
  GetOrders: ['orders'],
  GetClientsProducts: ['products', 'services'],
  GetClientsDomains: ['domains'],
};

export const NORMALIZER_ACTION_KEYS: ReadonlySet<string> = Object.freeze(
  new Set(Object.keys(NORMALIZER_PATHS))
);

/**
 * Apply normalization to specific fields in a WHMCS response
 */
export function normalizeWhmcsResponse<T extends Record<string, unknown>>(
  response: T,
  action: string
): T {
  if (!(action in NORMALIZER_PATHS)) {
    return response;
  }
  const paths = NORMALIZER_PATHS[action];

  const normalized = { ...response };

  for (const path of paths) {
    const value = response[path];
    if (value === undefined) {
      continue;
    }

    const singular = SINGULAR[path];

    // WHMCS commonly nests the list under the singular key:
    // {replies: {reply: [...]}}, {clients: {client: [...]}}. Normalize the
    // inner list and PRESERVE the {singular: [...]} wrapper (callers read
    // x.replies.reply / x.clients.client).
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.prototype.hasOwnProperty.call(value, singular)
    ) {
      const container = value as Record<string, unknown>;
      (normalized as Record<string, unknown>)[path] = {
        ...container,
        [singular]: normalizeToArray(container[singular]),
      };
    } else {
      // Flat array / numeric-keyed object / empty → normalized array.
      (normalized as Record<string, unknown>)[path] = normalizeToArray(value);
    }
  }

  return normalized;
}

/**
 * Convert JavaScript boolean to WHMCS expected format
 * WHMCS uses various formats: 1/0, "true"/"false", "on"/"off"
 */
export function boolToWhmcs(
  value: boolean,
  format: '10' | 'truefalse' | 'onoff' = '10'
): string | number {
  switch (format) {
    case '10':
      return value ? 1 : 0;
    case 'truefalse':
      return value ? 'true' : 'false';
    case 'onoff':
      return value ? 'on' : 'off';
  }
}

/**
 * Convert WHMCS value to JavaScript boolean
 */
export function whmcsToBool(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value === 'string') {
    return ['true', 'on', '1', 'yes'].includes(value.toLowerCase());
  }
  return false;
}

/**
 * Safe number parser with fallback
 */
export function parseNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = parseFloat(value);
    return isNaN(parsed) ? fallback : parsed;
  }
  return fallback;
}
