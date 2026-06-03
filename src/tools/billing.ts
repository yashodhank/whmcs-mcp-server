/**
 * Billing Tools for WHMCS MCP Server
 *
 * Tools: get_invoice, mark_invoice_paid, record_refund, capture_payment
 */

import { z } from 'zod';
import { createHash } from 'node:crypto';
import { McpServer, type ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WhmcsClient, WhmcsBusinessError } from '../whmcs/WhmcsClient.js';
import { Logger } from '../logging.js';
import { RateLimiter, RateLimitError } from '../rateLimiter.js';
import { config, isToolAllowed, legacyWriteToolsEnabled } from '../config.js';
import {
  ensureToolAuth,
  clientModeDenied,
  isClientMode,
  ensureClientOwnership,
  AUTH_SHAPE,
} from '../security.js';
import { normalizeToArray, parseNumber } from '../whmcs/normalizers.js';

const TOOL_VERSION = 'v1';

/**
 * Invoice item structure
 */
interface InvoiceItem {
  id: number;
  type: string;
  relid: number;
  description: string;
  amount: string;
  taxed: number;
}

/**
 * Transaction structure
 */
interface Transaction {
  id: number;
  transid: string;
  date: string;
  gateway: string;
  amount: string;
  amountin: string;
  amountout: string;
}

/**
 * Invoice structure from GetInvoice
 */
interface WhmcsInvoice {
  invoiceid: number;
  invoicenum?: string;
  userid: number;
  date: string;
  duedate: string;
  datepaid?: string;
  status: string;
  subtotal: string;
  total: string;
  balance: string;
  tax: string;
  tax2: string;
  credit: string;
  paymentmethod?: string;
  items?: { item?: InvoiceItem[] };
  transactions?: { transaction?: Transaction[] };
}

/**
 * Get invoice input schema
 */
const invoiceIdSchema = z.number().int().positive('Invoice ID must be positive');
const getInvoiceSchema = z
  .object({
    invoiceid: invoiceIdSchema
      .or(
        z
          .array(invoiceIdSchema)
          .min(1, 'At least one invoice ID is required')
          .max(config.MCP_MAX_PAGE_SIZE)
      )
      .optional()
      .describe('Single invoice ID, or an array of invoice IDs.'),
    invoiceids: z
      .array(invoiceIdSchema)
      .min(1, 'At least one invoice ID is required')
      .max(config.MCP_MAX_PAGE_SIZE)
      .optional()
      .describe('One or more invoice IDs to fetch in a single call.'),
  })
  .superRefine((value, ctx) => {
    if (value.invoiceid !== undefined || value.invoiceids !== undefined) {
      return;
    }
    ctx.addIssue({
      code: 'custom',
      message: 'invoiceid or invoiceids is required',
    });
  });

interface InvoiceResponse {
  invoiceid: number;
  invoicenum: string | null;
  clientid: number;
  date: string;
  duedate: string;
  datepaid: string | null;
  status: string;
  subtotal: string;
  total: string;
  balance: string;
  tax: string;
  credit_applied: string;
  payment_method: string | null;
  items: {
    id: number;
    type: string;
    description: string;
    amount: string;
    taxed: boolean;
  }[];
  transactions: {
    id: number;
    transid: string;
    date: string;
    gateway: string;
    amount_in: string;
    amount_out: string;
  }[];
}

function resolveInvoiceIds(params: z.infer<typeof getInvoiceSchema>): number[] {
  if (params.invoiceids && params.invoiceids.length > 0) {
    return params.invoiceids;
  }

  if (Array.isArray(params.invoiceid)) {
    return params.invoiceid;
  }

  if (params.invoiceid !== undefined) {
    return [params.invoiceid];
  }

  return [];
}

function firstNonEmptyInvoiceText(...values: (string | undefined)[]): string | null {
  for (const value of values) {
    if (value !== undefined && value.length > 0) {
      return value;
    }
  }

  return null;
}

function formatInvoice(invoice: WhmcsInvoice): InvoiceResponse {
  const items = normalizeToArray<InvoiceItem>(invoice.items?.item);
  const transactions = normalizeToArray<Transaction>(invoice.transactions?.transaction);

  return {
    invoiceid: invoice.invoiceid,
    invoicenum: firstNonEmptyInvoiceText(invoice.invoicenum),
    clientid: invoice.userid,
    date: invoice.date,
    duedate: invoice.duedate,
    datepaid: firstNonEmptyInvoiceText(invoice.datepaid),
    status: invoice.status,
    subtotal: invoice.subtotal,
    total: invoice.total,
    balance: invoice.balance,
    tax: invoice.tax,
    credit_applied: invoice.credit,
    payment_method: firstNonEmptyInvoiceText(invoice.paymentmethod),
    items: items.map((i) => ({
      id: i.id,
      type: i.type,
      description: i.description,
      amount: i.amount,
      taxed: i.taxed === 1,
    })),
    transactions: transactions.map((t) => ({
      id: t.id,
      transid: t.transid,
      date: t.date,
      gateway: t.gateway,
      amount_in: t.amountin,
      amount_out: t.amountout,
    })),
  };
}

function isBatchInvoiceRequest(params: z.infer<typeof getInvoiceSchema>): boolean {
  return params.invoiceids !== undefined || Array.isArray(params.invoiceid);
}

/**
 * Mark invoice paid input schema
 * Uses AddInvoicePayment per WHMCS API
 */
const markInvoicePaidSchema = z.object({
  invoiceid: z.number().int().positive('Invoice ID must be positive'),
  gateway: z.string().optional().describe('Payment gateway module name (e.g., mailin, stripe)'),
  transid: z
    .string()
    .optional()
    .describe('Transaction ID reference (will be generated if omitted)'),
  amount: z
    .number()
    .positive()
    .optional()
    .describe('Amount to record (defaults to invoice balance)'),
  fees: z.number().nonnegative().optional().describe('Payment processing fees'),
  date: z
    .string()
    .optional()
    .describe('Payment date/time (YYYY-MM-DD HH:mm:ss). Defaults to now UTC'),
  send_email: z.boolean().default(false).describe('Send payment confirmation email'),
});

/** Large refund threshold (SEC-007): from config, amounts above this require explicit confirmation */
function getLargeRefundThreshold(): number {
  return config.MCP_LARGE_REFUND_THRESHOLD;
}

/** Maximum credit per single add_credit operation */
const MAX_CREDIT_AMOUNT = 50_000;

/** Maximum amount per line item in create_invoice */
const MAX_INVOICE_ITEM_AMOUNT = 100_000;

/**
 * Record refund input schema
 */
const recordRefundSchema = z.object({
  invoiceid: z.number().int().positive('Invoice ID must be positive'),
  amount: z.number().positive('Refund amount must be greater than 0'),
  refund_type: z.enum(['Credit', 'GatewayRecord']),
  reason: z.string().optional(),
  paymentmethod: z
    .string()
    .optional()
    .describe('Payment method (required for GatewayRecord if invoice has no method)'),
  apply_to_invoice: z
    .boolean()
    .default(false)
    .describe('Apply credit refund to the invoice (if refund_type=Credit)'),
  confirm_large_refund: z.boolean().optional().describe('Required for refunds above threshold'),
});

/**
 * Capture payment input schema
 */
const capturePaymentSchema = z.object({
  invoiceid: z.number().int().positive('Invoice ID must be positive'),
  // SEC-006: PCI-sensitive. CVV must never be logged, cached, or otherwise persisted.
  // It is forwarded to WHMCS CapturePayment only and stripped before any logging.
  cvv: z.string().optional(),
  force: z.boolean().default(false),
});

/**
 * Format a JS Date to WHMCS expected format: YYYY-MM-DD HH:mm:ss (UTC)
 */
function formatWhmcsDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

/**
 * Build a deterministic synthetic payment transaction ID.
 * Stable for the same logical payment payload to avoid replay divergence.
 */
export function buildDeterministicPaymentTransId(input: {
  invoiceid: number;
  gateway: string;
  amount: number;
  fees: number;
  date: string;
}): string {
  const material = [
    String(input.invoiceid),
    input.gateway,
    input.amount.toFixed(2),
    input.fees.toFixed(2),
    input.date,
  ].join('|');
  const digest = createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 16);
  return `MCP-PAY-${input.invoiceid}-${digest}`;
}

/**
 * Build a deterministic synthetic refund transaction ID.
 * Anchored to the idempotency key so retries re-use the same reference.
 */
export function buildDeterministicRefundTransId(input: {
  invoiceid: number;
  idempotencyKey: string;
}): string {
  const digest = createHash('sha256')
    .update(`${input.invoiceid}|${input.idempotencyKey}`, 'utf8')
    .digest('hex')
    .slice(0, 16);
  return `REFUND-${input.invoiceid}-${digest}`;
}

/**
 * Register billing tools
 */
export function registerBillingTools(
  server: McpServer,
  whmcsClient: WhmcsClient,
  logger: Logger,
  rateLimiter: RateLimiter
): void {
  // ============================================
  // Tool: get_invoice
  // ============================================
  if (isToolAllowed('get_invoice')) {
    // Boundary cast: SDK v1.29 `ToolCallback` declares a return shape with an
    // open `[x: string]: unknown` index signature; our shared `ensure*`/result
    // helpers return the local closed `McpToolResponse`, which is structurally
    // a subtype but not assignable through the inferred overload. Lift the
    // handler and cast once at the boundary — pure type-only refactor.
    const handler: ToolCallback<z.ZodRawShape> = (async (rawParams: Record<string, unknown>) => {
      const params = rawParams as z.infer<typeof getInvoiceSchema> & { auth_token?: string };

      const toolLogger = logger.child();
      const startTime = Date.now();

      try {
        const authError = ensureToolAuth(params as Record<string, unknown>);
        if (authError) return authError;

        const invoiceIds = resolveInvoiceIds(params);
        if (invoiceIds.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  isError: true,
                  error: 'invoiceid or invoiceids is required.',
                }),
              },
            ],
            isError: true,
          };
        }

        toolLogger.logToolCall('get_invoice', params, false);

        const invoices: InvoiceResponse[] = [];
        for (const invoiceId of invoiceIds) {
          if (!rateLimiter.tryConsume()) {
            throw new RateLimitError();
          }

          const invoice = await whmcsClient.read<WhmcsInvoice>('GetInvoice', {
            invoiceid: invoiceId,
          });

          if (isClientMode()) {
            const ownershipError = ensureClientOwnership(
              invoice.userid,
              params as Record<string, unknown>
            );
            if (ownershipError) return ownershipError;
          }

          invoices.push(formatInvoice(invoice));
        }

        toolLogger.logToolResult('get_invoice', true, Date.now() - startTime);

        const batchResponse = isBatchInvoiceRequest(params);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                batchResponse
                  ? {
                      invoices,
                      total: invoices.length,
                    }
                  : invoices[0]
              ),
            },
          ],
        };
      } catch (error) {
        toolLogger.logToolResult(
          'get_invoice',
          false,
          Date.now() - startTime,
          error instanceof Error ? error.message : String(error)
        );

        if (error instanceof RateLimitError || error instanceof WhmcsBusinessError) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ isError: true, error: error.message }),
              },
            ],
            isError: true,
          };
        }

        throw error;
      }
    }) as unknown as ToolCallback<z.ZodRawShape>;

    server.tool(
      'get_invoice',
      `Get full invoice details for one or more invoices, including line items and transactions. Use invoiceid for one invoice, invoiceid as an array, or invoiceids for multiple invoices. Version: ${TOOL_VERSION}`,
      { ...getInvoiceSchema.shape, ...AUTH_SHAPE },
      handler
    );
  }

  // ============================================
  // Tool: mark_invoice_paid
  // ============================================
  if (legacyWriteToolsEnabled() && isToolAllowed('mark_invoice_paid')) {
    // Boundary cast: SDK v1.29 `ToolCallback` declares a return shape with an
    // open `[x: string]: unknown` index signature; our shared `ensure*`/result
    // helpers return the local closed `McpToolResponse`, which is structurally
    // a subtype but not assignable through the inferred overload. Lift the
    // handler and cast once at the boundary — pure type-only refactor.
    const handler: ToolCallback<z.ZodRawShape> = (async (rawParams: Record<string, unknown>) => {
      const params = rawParams as z.infer<typeof markInvoicePaidSchema> & { auth_token?: string };

      const toolLogger = logger.child();
      const startTime = Date.now();

      try {
        const authError = ensureToolAuth(params as Record<string, unknown>);
        if (authError) return authError;

        if (isClientMode()) {
          return clientModeDenied('mark_invoice_paid');
        }

        toolLogger.logToolCall('mark_invoice_paid', params, true);

        if (!rateLimiter.tryConsume()) {
          throw new RateLimitError();
        }

        if (whmcsClient.isReadOnly()) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  isError: true,
                  error: 'Tool not available in read_only mode',
                }),
              },
            ],
            isError: true,
          };
        }

        const idempotencyKey = rateLimiter.generateIdempotencyKey(
          'mark_invoice_paid',
          params.invoiceid
        );
        const cachedMarkPaid = rateLimiter.getCachedResult(idempotencyKey);
        if (cachedMarkPaid) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(cachedMarkPaid) }],
          };
        }

        // Fetch invoice first to check status and defaults
        const invoice = await whmcsClient.read<WhmcsInvoice>('GetInvoice', {
          invoiceid: params.invoiceid,
        });

        if (invoice.status !== 'Unpaid') {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  isError: true,
                  error: `Cannot mark invoice as Paid because status is '${invoice.status}'`,
                }),
              },
            ],
            isError: true,
          };
        }

        const warnings: string[] = [];

        // Determine gateway
        const gateway = params.gateway || invoice.paymentmethod;
        if (!gateway) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  isError: true,
                  error:
                    'Payment gateway is required. Provide gateway or ensure invoice has paymentmethod set.',
                }),
              },
            ],
            isError: true,
          };
        }

        // Determine transaction id
        const effectiveAmount =
          typeof params.amount === 'number' ? params.amount : parseNumber(invoice.balance);
        const effectiveFees = typeof params.fees === 'number' ? params.fees : 0;
        const transid =
          params.transid ||
          buildDeterministicPaymentTransId({
            invoiceid: params.invoiceid,
            gateway,
            amount: effectiveAmount,
            fees: effectiveFees,
            date: params.date || 'auto',
          });
        if (!params.transid) {
          warnings.push('No transid provided; generated a deterministic synthetic transaction ID.');
        }

        // Determine date
        const paymentDate = params.date || formatWhmcsDate(new Date());

        // Record invoice payment
        await whmcsClient.mutate('AddInvoicePayment', {
          invoiceid: params.invoiceid,
          transid,
          gateway,
          date: paymentDate,
          amount: params.amount,
          fees: params.fees,
          noemail: params.send_email ? false : true,
        });

        const markPaidResult = {
          invoiceid: params.invoiceid,
          previous_status: invoice.status,
          new_status: 'Paid',
          gateway,
          transid,
          amount_recorded: effectiveAmount,
          payment_date: paymentDate,
          email_sent: params.send_email,
          warnings: warnings.length ? warnings : undefined,
          success: true,
        };

        rateLimiter.cacheResult(idempotencyKey, markPaidResult);
        toolLogger.logToolResult('mark_invoice_paid', true, Date.now() - startTime);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(markPaidResult),
            },
          ],
        };
      } catch (error) {
        toolLogger.logToolResult(
          'mark_invoice_paid',
          false,
          Date.now() - startTime,
          error instanceof Error ? error.message : String(error)
        );

        if (error instanceof RateLimitError || error instanceof WhmcsBusinessError) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ isError: true, error: error.message }),
              },
            ],
            isError: true,
          };
        }

        throw error;
      }
    }) as unknown as ToolCallback<z.ZodRawShape>;

    server.tool(
      'mark_invoice_paid',
      `Record a payment for an invoice using AddInvoicePayment. Only works on invoices with 'Unpaid' status. Version: ${TOOL_VERSION}`,
      { ...markInvoicePaidSchema.shape, ...AUTH_SHAPE },
      handler
    );
  }

  // ============================================
  // Tool: record_refund
  // ============================================
  if (legacyWriteToolsEnabled() && isToolAllowed('record_refund')) {
    // Boundary cast: SDK v1.29 `ToolCallback` declares a return shape with an
    // open `[x: string]: unknown` index signature; our shared `ensure*`/result
    // helpers return the local closed `McpToolResponse`, which is structurally
    // a subtype but not assignable through the inferred overload. Lift the
    // handler and cast once at the boundary — pure type-only refactor.
    const handler: ToolCallback<z.ZodRawShape> = (async (rawParams: Record<string, unknown>) => {
      const params = rawParams as z.infer<typeof recordRefundSchema> & { auth_token?: string };

      const toolLogger = logger.child();
      const startTime = Date.now();

      try {
        const authError = ensureToolAuth(params as Record<string, unknown>);
        if (authError) return authError;

        if (isClientMode()) {
          return clientModeDenied('record_refund');
        }

        toolLogger.logToolCall('record_refund', params, true);

        if (!rateLimiter.tryConsume()) {
          throw new RateLimitError();
        }

        if (whmcsClient.isReadOnly()) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  isError: true,
                  error: 'Tool not available in read_only mode',
                }),
              },
            ],
            isError: true,
          };
        }

        // Apply idempotency for high-risk operation
        const idempotencyKey = rateLimiter.generateIdempotencyKey(
          'record_refund',
          params.invoiceid
        );
        const cached = rateLimiter.getCachedResult(idempotencyKey);
        if (cached) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(cached) }],
          };
        }

        // Safety guard: Require confirmation for large refunds (SEC-007: configurable threshold)
        const largeRefundThreshold = getLargeRefundThreshold();
        if (params.amount > largeRefundThreshold && !params.confirm_large_refund) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  requires_confirmation: true,
                  warning: `This refund of $${params.amount.toFixed(2)} exceeds the large refund threshold of $${largeRefundThreshold}. Please confirm by calling this tool again with 'confirm_large_refund: true'.`,
                  amount: params.amount,
                  threshold: largeRefundThreshold,
                  action: 'record_refund',
                }),
              },
            ],
          };
        }

        // Fetch invoice to validate refund amount and get client/payment method
        const invoice = await whmcsClient.read<WhmcsInvoice>('GetInvoice', {
          invoiceid: params.invoiceid,
        });

        const transactions = normalizeToArray<Transaction>(invoice.transactions?.transaction);
        const totalPaid = transactions.reduce((sum, t) => sum + parseNumber(t.amountin), 0);
        const totalRefunded = transactions.reduce((sum, t) => sum + parseNumber(t.amountout), 0);
        const maxRefundable = totalPaid - totalRefunded;

        if (params.amount > maxRefundable) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  isError: true,
                  error: `Refund amount ${params.amount} exceeds maximum refundable amount ${maxRefundable.toFixed(2)}`,
                  max_refundable: maxRefundable,
                }),
              },
            ],
            isError: true,
          };
        }

        let note = 'Refund recorded in WHMCS. Gateway reversal (if needed) must be done manually.';
        let creditApplied = false;

        if (params.refund_type === 'Credit') {
          // Add credit to client account
          await whmcsClient.mutate('AddCredit', {
            clientid: invoice.userid,
            amount: params.amount,
            description: params.reason ? `Refund credit: ${params.reason}` : 'Refund credit',
          });

          // Optionally apply credit to invoice
          if (params.apply_to_invoice) {
            await whmcsClient.mutate('ApplyCredit', {
              invoiceid: params.invoiceid,
              amount: params.amount,
              noemail: true,
            });
            creditApplied = true;
          }

          note = params.apply_to_invoice
            ? 'Credit added and applied to invoice.'
            : 'Credit added to client account. Apply to an invoice separately if desired.';
        } else {
          const paymentmethod = params.paymentmethod || invoice.paymentmethod;
          if (!paymentmethod) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    isError: true,
                    error:
                      'paymentmethod is required to record a gateway refund (invoice has no paymentmethod set).',
                  }),
                },
              ],
              isError: true,
            };
          }

          // Record the refund transaction
          const transactionParams: Record<string, unknown> = {
            invoiceid: params.invoiceid,
            description: params.reason ? `Refund: ${params.reason}` : 'Refund',
            amountout: params.amount,
            transid: buildDeterministicRefundTransId({
              invoiceid: params.invoiceid,
              idempotencyKey,
            }),
            paymentmethod,
          };

          await whmcsClient.mutate('AddTransaction', transactionParams);
        }

        const result = {
          invoiceid: params.invoiceid,
          amount: params.amount,
          refund_type: params.refund_type,
          new_invoice_status: invoice.status,
          credit_applied: creditApplied,
          note,
        };

        // Cache result for idempotency
        rateLimiter.cacheResult(idempotencyKey, result);

        toolLogger.logToolResult('record_refund', true, Date.now() - startTime);

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        };
      } catch (error) {
        toolLogger.logToolResult(
          'record_refund',
          false,
          Date.now() - startTime,
          error instanceof Error ? error.message : String(error)
        );

        if (error instanceof RateLimitError || error instanceof WhmcsBusinessError) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ isError: true, error: error.message }),
              },
            ],
            isError: true,
          };
        }

        throw error;
      }
    }) as unknown as ToolCallback<z.ZodRawShape>;

    server.tool(
      'record_refund',
      `Record a refund in WHMCS. IMPORTANT: This ONLY records the refund in WHMCS - it does NOT process the actual refund at the payment gateway (Stripe/PayPal/etc). Gateway reversal must be done manually. Version: ${TOOL_VERSION}`,
      { ...recordRefundSchema.shape, ...AUTH_SHAPE },
      handler
    );
  }

  // ============================================
  // Tool: capture_payment
  // ============================================
  if (legacyWriteToolsEnabled() && isToolAllowed('capture_payment')) {
    // Boundary cast: SDK v1.29 `ToolCallback` declares a return shape with an
    // open `[x: string]: unknown` index signature; our shared `ensure*`/result
    // helpers return the local closed `McpToolResponse`, which is structurally
    // a subtype but not assignable through the inferred overload. Lift the
    // handler and cast once at the boundary — pure type-only refactor.
    const handler: ToolCallback<z.ZodRawShape> = (async (rawParams: Record<string, unknown>) => {
      const params = rawParams as z.infer<typeof capturePaymentSchema> & { auth_token?: string };

      const toolLogger = logger.child();
      const startTime = Date.now();

      try {
        const authError = ensureToolAuth(params as Record<string, unknown>);
        if (authError) return authError;

        if (isClientMode()) {
          return clientModeDenied('capture_payment');
        }

        // SEC-006: strip CVV before logging (defense-in-depth on top of key-name redaction)
        const { cvv: _cvv, ...loggableParams } = params;
        toolLogger.logToolCall('capture_payment', loggableParams, true);

        if (!rateLimiter.tryConsume()) {
          throw new RateLimitError();
        }

        if (whmcsClient.isReadOnly()) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  isError: true,
                  error: 'Tool not available in read_only mode',
                }),
              },
            ],
            isError: true,
          };
        }

        // Apply idempotency
        const idempotencyKey = rateLimiter.generateIdempotencyKey(
          'capture_payment',
          params.invoiceid
        );
        const cached = rateLimiter.getCachedResult(idempotencyKey);
        if (cached) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(cached) }],
          };
        }

        // Fetch invoice first
        const invoice = await whmcsClient.read<WhmcsInvoice>('GetInvoice', {
          invoiceid: params.invoiceid,
        });

        if (invoice.status !== 'Unpaid') {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  isError: true,
                  error: `Cannot capture payment for invoice with status '${invoice.status}'`,
                }),
              },
            ],
            isError: true,
          };
        }

        const balance = parseNumber(invoice.balance);
        if (balance <= 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  isError: true,
                  error: 'Invoice has no balance due',
                }),
              },
            ],
            isError: true,
          };
        }

        // Check for recent failed captures (unless force=true)
        if (!params.force) {
          // Look at transactions for failed attempts
          const transactions = normalizeToArray<Transaction>(invoice.transactions?.transaction);

          // Check for failed transactions in the last 24 hours
          const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
          const recentFailures = transactions.filter(
            (tx: { date?: string; gateway?: string; transid?: string; amount?: string }) => {
              // Failed transactions often have specific gateway response patterns
              // or transid containing 'fail' or empty transid
              if (!tx.date) return false;
              const txDate = new Date(tx.date);
              if (txDate < twentyFourHoursAgo) return false;
              // Check for failed transaction indicators
              return (
                tx.transid === '' ||
                tx.transid?.toLowerCase().includes('fail') ||
                tx.transid?.toLowerCase().includes('decline')
              );
            }
          );

          if (recentFailures.length > 0) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    requires_confirmation: true,
                    warning: `Found ${recentFailures.length} failed capture attempt(s) in the last 24 hours. Multiple failed attempts may trigger fraud detection or rate limiting by payment processors.`,
                    failed_attempt_count: recentFailures.length,
                    action: 'capture_payment',
                    suggestion:
                      'Call this tool with force=true to attempt capture anyway, or wait 24 hours.',
                  }),
                },
              ],
            };
          }
        }

        // Capture payment
        const captureResult = await whmcsClient.mutate<{
          result: string;
          message?: string;
        }>('CapturePayment', {
          invoiceid: params.invoiceid,
          cvv: params.cvv,
        });

        const success = captureResult.result === 'success';

        const result = {
          invoiceid: params.invoiceid,
          success,
          gateway_response:
            captureResult.message || (success ? 'Payment captured' : 'Capture failed'),
          new_status: success ? 'Paid' : 'Unpaid',
        };

        if (success) {
          rateLimiter.cacheResult(idempotencyKey, result);
        }

        toolLogger.logToolResult('capture_payment', success, Date.now() - startTime);

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          isError: !success,
        };
      } catch (error) {
        toolLogger.logToolResult(
          'capture_payment',
          false,
          Date.now() - startTime,
          error instanceof Error ? error.message : String(error)
        );

        if (error instanceof RateLimitError || error instanceof WhmcsBusinessError) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ isError: true, error: error.message }),
              },
            ],
            isError: true,
          };
        }

        throw error;
      }
    }) as unknown as ToolCallback<z.ZodRawShape>;

    server.tool(
      'capture_payment',
      `Capture payment for an unpaid invoice using stored payment method. Version: ${TOOL_VERSION}`,
      { ...capturePaymentSchema.shape, ...AUTH_SHAPE },
      handler
    );
  }

  // ============================================
  // Tool: create_invoice
  // ============================================
  if (legacyWriteToolsEnabled() && isToolAllowed('create_invoice')) {
    const createInvoiceSchema = z.object({
      userid: z.number().int().positive('User ID must be positive'),
      paymentmethod: z.string().optional().describe('Payment method code (e.g., paypal, stripe)'),
      sendinvoice: z.boolean().default(false).describe('Send invoice email to client'),
      items: z
        .array(
          z.object({
            description: z.string(),
            amount: z
              .number()
              .max(
                MAX_INVOICE_ITEM_AMOUNT,
                `Invoice item amount cannot exceed ${MAX_INVOICE_ITEM_AMOUNT}`
              ),
            taxed: z.boolean().default(false),
          })
        )
        .min(1, 'At least one line item is required'),
    });

    // Boundary cast: SDK v1.29 `ToolCallback` declares a return shape with an
    // open `[x: string]: unknown` index signature; our shared `ensure*`/result
    // helpers return the local closed `McpToolResponse`, which is structurally
    // a subtype but not assignable through the inferred overload. Lift the
    // handler and cast once at the boundary — pure type-only refactor.
    const handler: ToolCallback<z.ZodRawShape> = (async (rawParams: Record<string, unknown>) => {
      const params = rawParams as z.infer<typeof createInvoiceSchema> & { auth_token?: string };

      const toolLogger = logger.child();
      const startTime = Date.now();

      try {
        const authError = ensureToolAuth(params as Record<string, unknown>);
        if (authError) return authError;

        if (isClientMode()) {
          return clientModeDenied('create_invoice');
        }

        toolLogger.logToolCall('create_invoice', params, true);

        if (!rateLimiter.tryConsume()) {
          throw new RateLimitError();
        }

        if (whmcsClient.isReadOnly()) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  isError: true,
                  error: 'Tool not available in read_only mode',
                }),
              },
            ],
            isError: true,
          };
        }

        // Create the invoice
        const lineItemFields = Object.fromEntries(
          params.items.flatMap((item, i) => {
            const idx = i + 1; // WHMCS expects 1-based item indexes
            return [
              [`itemdescription${idx}`, item.description],
              [`itemamount${idx}`, item.amount],
              [`itemtaxed${idx}`, item.taxed ? 1 : 0],
            ];
          })
        ) as Record<string, unknown>;
        const invoiceParams: Record<string, unknown> = {
          userid: params.userid,
          paymentmethod: params.paymentmethod,
          sendinvoice: params.sendinvoice,
          ...lineItemFields,
        };
        const invoiceResult = await whmcsClient.mutate<{
          result: string;
          invoiceid?: number;
          status?: string;
        }>('CreateInvoice', invoiceParams);

        const success = invoiceResult.result === 'success' && !!invoiceResult.invoiceid;

        toolLogger.logToolResult('create_invoice', success, Date.now() - startTime);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success,
                invoiceid: invoiceResult.invoiceid,
                status: invoiceResult.status || 'Unpaid',
                items_count: params.items.length,
                email_sent: params.sendinvoice,
              }),
            },
          ],
        };
      } catch (error) {
        toolLogger.logToolResult(
          'create_invoice',
          false,
          Date.now() - startTime,
          error instanceof Error ? error.message : String(error)
        );

        if (error instanceof RateLimitError || error instanceof WhmcsBusinessError) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ isError: true, error: error.message }),
              },
            ],
            isError: true,
          };
        }

        throw error;
      }
    }) as unknown as ToolCallback<z.ZodRawShape>;

    server.tool(
      'create_invoice',
      `Create a new invoice for a client with line items. Version: ${TOOL_VERSION}`,
      { ...createInvoiceSchema.shape, ...AUTH_SHAPE },
      handler
    );
  }

  // ============================================
  // Tool: add_credit
  // ============================================
  if (legacyWriteToolsEnabled() && isToolAllowed('add_credit')) {
    const addCreditSchema = z.object({
      clientid: z.number().int().positive('Client ID must be positive'),
      amount: z
        .number()
        .positive('Amount must be positive')
        .max(MAX_CREDIT_AMOUNT, `Credit amount cannot exceed ${MAX_CREDIT_AMOUNT}`),
      description: z.string().default('Credit added via API'),
    });

    // Boundary cast: SDK v1.29 `ToolCallback` declares a return shape with an
    // open `[x: string]: unknown` index signature; our shared `ensure*`/result
    // helpers return the local closed `McpToolResponse`, which is structurally
    // a subtype but not assignable through the inferred overload. Lift the
    // handler and cast once at the boundary — pure type-only refactor.
    const handler: ToolCallback<z.ZodRawShape> = (async (rawParams: Record<string, unknown>) => {
      const params = rawParams as z.infer<typeof addCreditSchema> & { auth_token?: string };

      const toolLogger = logger.child();
      const startTime = Date.now();

      try {
        const authError = ensureToolAuth(params as Record<string, unknown>);
        if (authError) return authError;

        if (isClientMode()) {
          return clientModeDenied('add_credit');
        }

        toolLogger.logToolCall('add_credit', params, true);

        if (!rateLimiter.tryConsume()) {
          throw new RateLimitError();
        }

        if (whmcsClient.isReadOnly()) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  isError: true,
                  error: 'Tool not available in read_only mode',
                }),
              },
            ],
            isError: true,
          };
        }

        const addCreditIdempotencyKey = rateLimiter.generateIdempotencyKey(
          'add_credit',
          params.clientid
        );
        const cachedAddCredit = rateLimiter.getCachedResult(addCreditIdempotencyKey);
        if (cachedAddCredit) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(cachedAddCredit) }],
          };
        }

        const result = await whmcsClient.mutate<{
          result: string;
          newbalance?: string;
        }>('AddCredit', {
          clientid: params.clientid,
          amount: params.amount,
          description: params.description,
        });

        const success = result.result === 'success';

        const addCreditResponse = {
          clientid: params.clientid,
          success,
          amount_added: params.amount,
          new_balance: result.newbalance,
        };

        if (success) {
          rateLimiter.cacheResult(addCreditIdempotencyKey, addCreditResponse);
        }

        toolLogger.logToolResult('add_credit', success, Date.now() - startTime);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(addCreditResponse),
            },
          ],
        };
      } catch (error) {
        toolLogger.logToolResult(
          'add_credit',
          false,
          Date.now() - startTime,
          error instanceof Error ? error.message : String(error)
        );

        if (error instanceof RateLimitError || error instanceof WhmcsBusinessError) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ isError: true, error: error.message }),
              },
            ],
            isError: true,
          };
        }

        throw error;
      }
    }) as unknown as ToolCallback<z.ZodRawShape>;

    server.tool(
      'add_credit',
      `Add credit to a client's account balance. Version: ${TOOL_VERSION}`,
      { ...addCreditSchema.shape, ...AUTH_SHAPE },
      handler
    );
  }

  // ============================================
  // Tool: apply_credit
  // ============================================
  if (legacyWriteToolsEnabled() && isToolAllowed('apply_credit')) {
    const applyCreditSchema = z.object({
      invoiceid: z.number().int().positive('Invoice ID must be positive'),
      amount: z
        .number()
        .positive('Amount must be positive')
        .optional()
        .describe('Amount to apply. If omitted, applies up to the invoice balance.'),
    });

    // Boundary cast: SDK v1.29 `ToolCallback` declares a return shape with an
    // open `[x: string]: unknown` index signature; our shared `ensure*`/result
    // helpers return the local closed `McpToolResponse`, which is structurally
    // a subtype but not assignable through the inferred overload. Lift the
    // handler and cast once at the boundary — pure type-only refactor.
    const handler: ToolCallback<z.ZodRawShape> = (async (rawParams: Record<string, unknown>) => {
      const params = rawParams as z.infer<typeof applyCreditSchema> & { auth_token?: string };

      const toolLogger = logger.child();
      const startTime = Date.now();

      try {
        const authError = ensureToolAuth(params as Record<string, unknown>);
        if (authError) return authError;

        if (isClientMode()) {
          return clientModeDenied('apply_credit');
        }

        toolLogger.logToolCall('apply_credit', params, true);

        if (!rateLimiter.tryConsume()) {
          throw new RateLimitError();
        }

        if (whmcsClient.isReadOnly()) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  isError: true,
                  error: 'Tool not available in read_only mode',
                }),
              },
            ],
            isError: true,
          };
        }

        const result = await whmcsClient.mutate<{
          result: string;
          invoiceid?: number;
          amount?: string;
          invoicepaid?: string;
        }>('ApplyCredit', {
          invoiceid: params.invoiceid,
          amount: params.amount,
          noemail: true,
        });

        const success = result.result === 'success';

        toolLogger.logToolResult('apply_credit', success, Date.now() - startTime);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                invoiceid: params.invoiceid,
                success,
                amount_applied: result.amount,
                invoice_paid: result.invoicepaid === 'true' || result.invoicepaid === '1',
              }),
            },
          ],
        };
      } catch (error) {
        toolLogger.logToolResult(
          'apply_credit',
          false,
          Date.now() - startTime,
          error instanceof Error ? error.message : String(error)
        );

        if (error instanceof RateLimitError || error instanceof WhmcsBusinessError) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ isError: true, error: error.message }),
              },
            ],
            isError: true,
          };
        }

        throw error;
      }
    }) as unknown as ToolCallback<z.ZodRawShape>;

    server.tool(
      'apply_credit',
      `Apply client credit to an invoice. Reduces invoice balance using available credit. Version: ${TOOL_VERSION}`,
      { ...applyCreditSchema.shape, ...AUTH_SHAPE },
      handler
    );
  }
}
