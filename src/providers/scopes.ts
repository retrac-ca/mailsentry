import type { AuthMode, ProviderId } from "../shared/types.js";
import { capabilitiesFor } from "../core/capabilities.js";

export interface ScopeAssessment {
  grantedScopes: string[];
  requiredScope: string;
  scopeWarning: string | null;
}

/** Token responses use space-separated scope strings; normalize without exposing tokens. */
export function parseGrantedScopes(scopeString: string | null | undefined): string[] {
  if (!scopeString) return [];
  return [
    ...new Set(
      scopeString
        .split(/\s+/)
        .map((scope) => scope.trim())
        .filter(Boolean),
    ),
  ];
}

function normalized(scope: string): string {
  return scope
    .replace(/^https:\/\/www\.googleapis\.com\/auth\//i, "")
    .replace(/^https:\/\/graph\.microsoft\.com\//i, "")
    .replace(/^api:\/\//i, "")
    .toLowerCase();
}

export function hasScope(grantedScopes: readonly string[], requiredScope: string): boolean {
  const required = normalized(requiredScope);
  return grantedScopes.some((scope) => normalized(scope) === required);
}

/** Unknown/empty scope lists produce no warning; missing reported scopes do. */
export function assessScopes(
  provider: ProviderId,
  mode: AuthMode,
  scopeString: string | null | undefined,
): ScopeAssessment {
  const caps = capabilitiesFor(provider);
  const requiredScope = mode === "cleanup" ? caps.auth.cleanupScope : caps.auth.readonlyScope;
  const grantedScopes = parseGrantedScopes(scopeString);
  const hasRequired =
    hasScope(grantedScopes, requiredScope) ||
    (mode === "readonly" && hasScope(grantedScopes, caps.auth.cleanupScope));
  if (grantedScopes.length === 0 || hasRequired) {
    return { grantedScopes, requiredScope, scopeWarning: null };
  }
  return {
    grantedScopes,
    requiredScope,
    scopeWarning: `The provider's token response did not report the expected ${requiredScope} permission. The connection may not support ${mode === "cleanup" ? "cleanup operations" : "the read-only feature set"}. Reconnect and grant the requested scope if actions fail.`,
  };
}
