import type { OrgRole, OrgPermissionType } from './permissions';

/**
 * Cached organization membership stored in session
 */
export interface OrgMembership {
  orgId: string;
  orgSlug: string;
  orgName: string;
  role: OrgRole;
  permissions: OrgPermissionType[];
}

/**
 * Enhanced user type stored in session with multi-tenancy support
 */
export interface SessionUser {
  id: number;
  email: string;
  name: string;
  isSuperadmin: boolean;
  /** Cached organization memberships for quick access */
  memberships: OrgMembership[];
  /** Currently selected organization ID */
  currentOrgId: string | null;
  /** Currently selected organization slug */
  currentOrgSlug: string | null;
}

/**
 * Session data structure
 */
/**
 * The signed-in account, as the cookie carries it.
 *
 * Separate from {@link SessionUser} on purpose: `users` survives only for the
 * org/api-key surface, and authentication now lives on `accounts`. The two
 * keys coexist while the sign-in bridge lands.
 */
export interface SessionAccount {
  id: number;
  /** The opaque per-server identifier. Cosmetic here — the token beside it is the credential. */
  handle: string;
  /**
   * The raw opaque `access` token (`app/lib/e2ee/tokens.ts`), 15-minute TTL.
   *
   * IT IS SAFE HERE AND NOWHERE ELSE. This cookie is `httpOnly`, signed and
   * `sameSite: 'lax'`, so injected script cannot read it; the same string in
   * `localStorage` would be exfiltrable by one XSS. Only its SHA-256 digest is
   * persisted server-side, so a dumped `account_tokens` table replays nothing.
   * See `app/services/account-session.server.ts` for the full argument.
   */
  accessToken: string;
  /** The raw opaque `refresh` token, 30-day TTL and rotating. Spent only by `POST /api/v1/auth/refresh`. */
  refreshToken: string;
}

export interface SessionData {
  /**
   * The stack's original session user. Authentication no longer writes it —
   * that moved to `account` — and `users` survives only for the org and
   * api-key surface, which `app/middleware/auth.ts` resolves from
   * `users.accountId` instead.
   */
  user: SessionUser;
  /** The signed-in account. A session without it is signed out. */
  account: SessionAccount;
}

/**
 * Tenant context available in org-scoped routes
 */
export interface TenantContextValue {
  userId: number;
  orgId: string;
  orgSlug: string;
  orgRole: OrgRole;
  permissions: OrgPermissionType[];
  isSuperadmin: boolean;
}
