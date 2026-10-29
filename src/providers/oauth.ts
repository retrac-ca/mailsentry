import { randomBytes, createHash } from "node:crypto";
import { redactString } from "../security/redact.js";
import { AppError } from "../core/errors.js";

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  scope: string;
  idToken: string | null;
}

export interface OAuthCredentials {
  clientId: string;
  clientSecret?: string;
}

export interface AuthorizeParams {
  credentials: OAuthCredentials;
  redirectUri: string;
  scopes: string;
  state: string;
  codeChallenge: string;
}

export interface ExchangeParams {
  credentials: OAuthCredentials;
  redirectUri: string;
  code: string;
  codeVerifier: string;
  scopes: string;
}

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  id_token?: unknown;
  error?: unknown;
  error_description?: unknown;
}

export interface OAuthClient {
  buildAuthorizeUrl(params: AuthorizeParams): string;
  exchangeCode(params: ExchangeParams): Promise<TokenSet>;
  refresh(refreshToken: string, credentials: OAuthCredentials, scopes: string): Promise<TokenSet>;
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export { pkcePair };

function tokenSetFrom(payload: TokenResponse, previousRefresh: string | null): TokenSet {
  if (typeof payload.access_token !== "string" || payload.access_token.length === 0) {
    const description =
      typeof payload.error_description === "string"
        ? redactString(payload.error_description).slice(0, 200)
        : typeof payload.error === "string"
          ? redactString(payload.error).slice(0, 100)
          : "No access token was returned.";
    throw new AppError("PROVIDER_ERROR", `Authorization failed: ${description}`, 502);
  }
  const expiresIn = Number(payload.expires_in);
  return {
    accessToken: payload.access_token,
    refreshToken:
      typeof payload.refresh_token === "string" && payload.refresh_token.length > 0
        ? payload.refresh_token
        : previousRefresh,
    expiresAt: Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000,
    scope: typeof payload.scope === "string" ? payload.scope : "",
    idToken: typeof payload.id_token === "string" ? payload.id_token : null,
  };
}

async function postToken(url: string, body: URLSearchParams): Promise<TokenResponse> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: body.toString(),
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
  } catch {
    throw new AppError("PROVIDER_ERROR", "The authorization server could not be reached.", 502);
  }
  const text = await response.text();
  let payload: TokenResponse;
  try {
    payload = JSON.parse(text) as TokenResponse;
  } catch {
    throw new AppError("PROVIDER_ERROR", "The authorization server returned an unreadable response.", 502);
  }
  if (!response.ok) {
    const description =
      typeof payload.error_description === "string"
        ? redactString(payload.error_description).slice(0, 200)
        : `HTTP ${response.status}`;
    throw new AppError("PROVIDER_ERROR", `Authorization failed: ${description}`, 502);
  }
  return payload;
}

export class GoogleOAuthClient implements OAuthClient {
  buildAuthorizeUrl(params: AuthorizeParams): string {
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", params.credentials.clientId);
    url.searchParams.set("redirect_uri", params.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", params.scopes);
    url.searchParams.set("state", params.state);
    url.searchParams.set("code_challenge", params.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("include_granted_scopes", "true");
    return url.toString();
  }

  async exchangeCode(params: ExchangeParams): Promise<TokenSet> {
    const body = new URLSearchParams({
      code: params.code,
      client_id: params.credentials.clientId,
      redirect_uri: params.redirectUri,
      grant_type: "authorization_code",
      code_verifier: params.codeVerifier,
    });
    if (params.credentials.clientSecret) body.set("client_secret", params.credentials.clientSecret);
    const payload = await postToken("https://oauth2.googleapis.com/token", body);
    return tokenSetFrom(payload, null);
  }

  async refresh(refreshToken: string, credentials: OAuthCredentials): Promise<TokenSet> {
    const body = new URLSearchParams({
      refresh_token: refreshToken,
      client_id: credentials.clientId,
      grant_type: "refresh_token",
    });
    if (credentials.clientSecret) body.set("client_secret", credentials.clientSecret);
    const payload = await postToken("https://oauth2.googleapis.com/token", body);
    return tokenSetFrom(payload, refreshToken);
  }
}

export class MicrosoftOAuthClient implements OAuthClient {
  constructor(private readonly tenant: string) {}

  private endpoint(path: "authorize" | "token"): string {
    return `https://login.microsoftonline.com/${encodeURIComponent(this.tenant)}/oauth2/v2.0/${path}`;
  }

  buildAuthorizeUrl(params: AuthorizeParams): string {
    const url = new URL(this.endpoint("authorize"));
    url.searchParams.set("client_id", params.credentials.clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", params.redirectUri);
    url.searchParams.set("response_mode", "query");
    url.searchParams.set("scope", params.scopes);
    url.searchParams.set("state", params.state);
    url.searchParams.set("code_challenge", params.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("prompt", "select_account");
    return url.toString();
  }

  async exchangeCode(params: ExchangeParams): Promise<TokenSet> {
    const body = new URLSearchParams({
      code: params.code,
      client_id: params.credentials.clientId,
      redirect_uri: params.redirectUri,
      grant_type: "authorization_code",
      code_verifier: params.codeVerifier,
      scope: params.scopes,
    });
    if (params.credentials.clientSecret) body.set("client_secret", params.credentials.clientSecret);
    const payload = await postToken(this.endpoint("token"), body);
    return tokenSetFrom(payload, null);
  }

  async refresh(refreshToken: string, credentials: OAuthCredentials, scopes: string): Promise<TokenSet> {
    const body = new URLSearchParams({
      client_id: credentials.clientId,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: scopes,
    });
    if (credentials.clientSecret) body.set("client_secret", credentials.clientSecret);
    const payload = await postToken(this.endpoint("token"), body);
    return tokenSetFrom(payload, refreshToken);
  }
}

/** Decode an id_token payload for display only (the token came directly from the TLS token endpoint). */
export function accountFromIdToken(idToken: string | null): string | null {
  if (!idToken) return null;
  const parts = idToken.split(".");
  if (parts.length < 2 || !parts[1]) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    const value = payload["preferred_username"] ?? payload["email"] ?? payload["upn"];
    return typeof value === "string" ? value.slice(0, 254) : null;
  } catch {
    return null;
  }
}
