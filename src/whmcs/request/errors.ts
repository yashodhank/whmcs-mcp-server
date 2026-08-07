/** WHMCS returned `result=error` over an otherwise successful HTTP exchange. */
export class WhmcsBusinessError extends Error {
  code?: string | number;
  details?: unknown;

  constructor(message: string, code?: string | number, details?: unknown) {
    super(message);
    this.name = 'WhmcsBusinessError';
    this.code = code;
    this.details = details;
  }
}

/** The WHMCS exchange failed at the HTTP, network, cancellation, or deadline layer. */
export class WhmcsTransportError extends Error {
  statusCode?: number;
  outcomeUnknown: boolean;

  constructor(message: string, statusCode?: number, outcomeUnknown = false) {
    super(message);
    this.name = 'WhmcsTransportError';
    this.statusCode = statusCode;
    this.outcomeUnknown = outcomeUnknown;
  }
}
