/**
 * Official WHMCS 8.13 `clientarea:*` vocabulary (SSO Client Area destinations).
 *
 * These are NOT proven External API grants on production 8.13.7. Jobs map to
 * this vocabulary; missing/unproven scope → capability_unavailable, never
 * Admin API impersonation (ADR-0002.5).
 */

export const CLIENTAREA_SCOPES = [
  'clientarea:sso',
  'clientarea:profile',
  'clientarea:emails',
  'clientarea:contacts',
  'clientarea:products',
  'clientarea:services',
  'clientarea:domains',
  'clientarea:invoices',
  'clientarea:tickets',
  'clientarea:affiliates',
  'clientarea:orders',
  'clientarea:quotes',
  'clientarea:announcements',
  'clientarea:knowledgebase',
  'clientarea:downloads',
  'clientarea:network_status',
  'clientarea:addfunds',
  'clientarea:security',
] as const;

export type ClientareaScope = (typeof CLIENTAREA_SCOPES)[number];

export const OIDC_SCOPES = ['openid', 'profile', 'email'] as const;

export const CLIENTAREA_SCOPE_STATUS = 'sso_destinations_unproven_as_api' as const;

export function clientareaScopeCatalog(): {
  status: typeof CLIENTAREA_SCOPE_STATUS;
  scopes: ClientareaScope[];
  oidc_scopes: typeof OIDC_SCOPES;
  missing_scope: 'capability_unavailable';
  never: 'admin_api_impersonation';
  note: string;
} {
  return {
    status: CLIENTAREA_SCOPE_STATUS,
    scopes: [...CLIENTAREA_SCOPES],
    oidc_scopes: OIDC_SCOPES,
    missing_scope: 'capability_unavailable',
    never: 'admin_api_impersonation',
    note: 'Official WHMCS 8.13 CreateOAuthCredential / SSO Client Area destinations. Not proven as user-delegated External API grants on this install.',
  };
}
