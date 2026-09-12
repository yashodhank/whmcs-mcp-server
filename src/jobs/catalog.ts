/**
 * ops_ask job catalog for WHMCS 8.13.7.
 *
 * Audience is derived from the consumer allow-list, never from the model.
 * Customer jobs stay link/handoff until a user-delegated API is proven.
 */

import type { JobAudience } from '../auth/audience.js';

export const STAFF_JOBS = [
  'morning_digest',
  'overdue_digest',
  'ticket_inbox',
  'next_best_action',
  'close_pack',
  'system_health',
  'draft_work',
  'billing_card',
  'gdpr_export_pack',
] as const;

export const CUSTOMER_JOBS = [
  'billing_card',
  'renewal_digest',
  'ticket_status',
  'handoff_pack',
] as const;

export const ALL_JOBS = [
  ...STAFF_JOBS,
  'renewal_digest',
  'ticket_status',
  'handoff_pack',
  'credit_notes',
] as const;

export type StaffJob = (typeof STAFF_JOBS)[number];
export type CustomerJob = (typeof CUSTOMER_JOBS)[number];
export type OpsJob = (typeof ALL_JOBS)[number];

const STAFF_SET = new Set<string>(STAFF_JOBS);
const CUSTOMER_SET = new Set<string>(CUSTOMER_JOBS);

export function isOpsJob(value: string): value is OpsJob {
  return (ALL_JOBS as readonly string[]).includes(value);
}

export function jobAllowedForAudience(job: OpsJob, audience: JobAudience): boolean {
  if (job === 'credit_notes') return audience === 'staff';
  if (audience === 'staff') return STAFF_SET.has(job);
  return CUSTOMER_SET.has(job);
}

export function jobDeniedMessage(job: OpsJob, audience: JobAudience): string {
  return `job '${job}' is not available to ${audience} audience`;
}
