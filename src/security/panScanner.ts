/**
 * PCI-DSS PAN (Primary Account Number) scanning middleware.
 *
 * Detects raw credit card numbers in tool input parameters to prevent
 * accidental PAN ingestion through the MCP layer. Card numbers are
 * validated with the Luhn algorithm to minimise false positives.
 *
 * IMPORTANT: Error messages deliberately omit the detected PAN value
 * so the number is never echoed to logs or client responses.
 */

/**
 * Regex that matches 13–19 digit sequences with optional spaces or dashes.
 *
 * Examples:
 *  - 4111111111111111
 *  - 4111 1111 1111 1111
 *  - 4111-1111-1111-1111
 *  - 5500000000000004
 */
export const PAN_REGEX = /\b(?:\d[ -]*?){13,19}\b/g;

/**
 * Custom error thrown when a potential credit card number is found in
 * tool input parameters.  The actual PAN is never included in the
 * message to comply with PCI-DSS data-exposure rules.
 */
export class PANDetectedError extends Error {
  override readonly name = 'PANDetectedError';

  constructor() {
    super('Potential credit card number detected in input');
  }
}

/**
 * Validate a digit-only string against the Luhn (mod-10) algorithm.
 *
 * @param digits - String of digits to check (no spaces / dashes).
 * @returns `true` when the checksum passes.
 */
export function isValidLuhn(digits: string): boolean {
  if (digits.length === 0) return false;

  let sum = 0;
  let alternate = false;

  // Walk right-to-left
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);

    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }

    sum += n;
    alternate = !alternate;
  }

  return sum % 10 === 0;
}

/**
 * Recursively walk an arbitrary value (object / array / string) and
 * return every substring that looks like a valid PAN (matches
 * {@link PAN_REGEX} **and** passes the Luhn check).
 *
 * @param value - The value to scan — can be any JSON-compatible type.
 * @returns Array of detected PAN strings (digits only, separators stripped).
 */
export function scanForPAN(value: unknown): string[] {
  const found: string[] = [];

  if (typeof value === 'string') {
    // Reset lastIndex for the global regex
    PAN_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = PAN_REGEX.exec(value)) !== null) {
      const digits = match[0].replace(/[ -]/g, '');
      if (digits.length >= 13 && digits.length <= 19 && isValidLuhn(digits)) {
        found.push(digits);
      }
    }
  } else if (Array.isArray(value)) {
    for (const item of value) {
      found.push(...scanForPAN(item));
    }
  } else if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      found.push(...scanForPAN((value as Record<string, unknown>)[key]));
    }
  }
  // numbers, booleans, null, undefined — ignored safely

  return found;
}

/**
 * Assert that none of the tool parameters contain a PAN.
 *
 * @param params - The raw tool input parameters to scan.
 * @throws {PANDetectedError} When at least one valid PAN is detected.
 */
export function assertNoPAN(params: Record<string, unknown>): void {
  const hits = scanForPAN(params);
  if (hits.length > 0) {
    throw new PANDetectedError();
  }
}
