import { randomBytes } from "node:crypto";
import {
  bearer,
  ConnectorError,
  providerFailure,
  requiredEnv,
  requestJson,
} from "./http";

const requiredScopes = ["openid", "profile", "w_member_social"] as const;
function scopes(value: unknown): string[] {
  return typeof value === "string"
    ? value.split(/[\s,+]+/).filter(Boolean)
    : [];
}
function verifyScopes(values: string[]) {
  if (!requiredScopes.every((s) => values.includes(s)))
    throw new ConnectorError(
      "LinkedIn",
      "Authorize the member profile and post publishing permissions in LinkedIn.",
      403,
    );
}
function redirectUri() {
  const configured = requiredEnv("LINKEDIN_REDIRECT_URI");
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new ConnectorError(
      "LinkedIn",
      "Configure the exact OAuth callback URL.",
      503,
    );
  }
  if (
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    url.pathname !== "/api/oauth/callback" ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    )
  )
    throw new ConnectorError(
      "LinkedIn",
      "Configure an HTTPS callback at /api/oauth/callback or use local loopback HTTP.",
      503,
    );
  return url.href;
}
function apiVersion() {
  const version = requiredEnv("LINKEDIN_API_VERSION");
  if (!/^20\d{2}(0[1-9]|1[0-2])$/u.test(version))
    throw new ConnectorError(
      "LinkedIn",
      "Set a supported LinkedIn API release in YYYYMM format.",
      503,
    );
  return version;
}
export function linkedInConfigured() {
  try {
    requiredEnv("LINKEDIN_CLIENT_ID");
    requiredEnv("LINKEDIN_CLIENT_SECRET");
    redirectUri();
    apiVersion();
    return true;
  } catch {
    return false;
  }
}
export function beginLinkedInOAuth() {
  if (!linkedInConfigured())
    throw new ConnectorError(
      "LinkedIn",
      "Set the LinkedIn client ID, client secret, callback URL and supported API release on the server.",
      503,
    );
  const state = randomBytes(32).toString("base64url");
  const url = new URL("https://www.linkedin.com/oauth/v2/authorization");
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: requiredEnv("LINKEDIN_CLIENT_ID"),
    redirect_uri: redirectUri(),
    scope: requiredScopes.join(" "),
    state,
  }).toString();
  return { url: url.href, state };
}
type TokenReply = {
  access_token?: string;
  expires_in?: number;
  scope?: string;
  refresh_token?: string;
  refresh_token_expires_in?: number;
};
export type LinkedInToken = {
  accessToken: string;
  expiresAt: number;
  scopes: string[];
  refreshToken?: string;
  refreshExpiresAt?: number;
};
export async function inspectLinkedInToken(token: string) {
  const check = await requestJson<{
    active: boolean;
    scope?: string;
    client_id?: string;
    expires_at?: number;
  }>("LinkedIn", "https://www.linkedin.com/oauth/v2/introspectToken", {
    method: "POST",
    body: new URLSearchParams({
      token,
      client_id: requiredEnv("LINKEDIN_CLIENT_ID"),
      client_secret: requiredEnv("LINKEDIN_CLIENT_SECRET"),
    }),
  });
  if (
    check.active !== true ||
    (check.client_id && check.client_id !== process.env.LINKEDIN_CLIENT_ID)
  )
    throw new ConnectorError(
      "LinkedIn",
      "LinkedIn authorization expired or belongs to a different application. Reconnect the member account.",
      401,
    );
  const values = scopes(check.scope);
  verifyScopes(values);
  return values;
}
async function getToken(
  params: Record<string, string>,
): Promise<LinkedInToken> {
  const result = await requestJson<TokenReply>(
    "LinkedIn OAuth",
    "https://www.linkedin.com/oauth/v2/accessToken",
    {
      method: "POST",
      body: new URLSearchParams({
        ...params,
        client_id: requiredEnv("LINKEDIN_CLIENT_ID"),
        client_secret: requiredEnv("LINKEDIN_CLIENT_SECRET"),
      }),
    },
  );
  if (
    !result.access_token ||
    !Number.isFinite(result.expires_in) ||
    result.expires_in! <= 0
  )
    throw new ConnectorError(
      "LinkedIn",
      "Incomplete authorization returned by LinkedIn.",
      502,
    );
  const values = result.scope
    ? scopes(result.scope)
    : await inspectLinkedInToken(result.access_token);
  verifyScopes(values);
  return {
    accessToken: result.access_token,
    expiresAt: Date.now() + result.expires_in! * 1000,
    scopes: values,
    refreshToken: result.refresh_token,
    refreshExpiresAt: result.refresh_token_expires_in
      ? Date.now() + result.refresh_token_expires_in * 1000
      : undefined,
  };
}
export function exchangeLinkedInCode(code: string) {
  if (!code || code.length > 4096)
    throw new ConnectorError(
      "LinkedIn",
      "LinkedIn authorization was declined. Start a new connection.",
      403,
    );
  return getToken({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(),
  });
}
export function refreshLinkedInToken(refreshToken: string) {
  return getToken({ grant_type: "refresh_token", refresh_token: refreshToken });
}
export async function linkedInProfile(token: string) {
  const profile = await requestJson<{ sub?: string; name?: string }>(
    "LinkedIn",
    "https://api.linkedin.com/v2/userinfo",
    { headers: bearer(token) },
  );
  if (!profile.sub || !/^[\w-]{1,200}$/u.test(profile.sub))
    throw new ConnectorError(
      "LinkedIn",
      "Could not identify the authorized LinkedIn member.",
      502,
    );
  return {
    sub: profile.sub,
    name: (profile.name?.trim() || "LinkedIn member").slice(0, 160),
  };
}
// LinkedIn's little text grammar treats punctuation as markup. Keep reviewed
// text literal and encode standalone hashtags as the provider's hashtag type.
function encodeCommentary(text: string) {
  return text.replace(
    /(?<!\S)#([\p{L}\p{N}_][\p{L}\p{M}\p{N}_]*)|[\\|{}@[\]()<>#*_~]/gu,
    (match, tag?: string) =>
      tag ? "{hashtag|\\#|" + tag.replaceAll("_", "\\_") + "}" : "\\" + match,
  );
}
export async function publishLinkedIn(
  token: string,
  author: string,
  text: string,
) {
  if (
    !/^urn:li:person:[\w-]{1,200}$/u.test(author) ||
    !text.trim() ||
    text.length > 3000
  )
    throw new ConnectorError(
      "LinkedIn",
      "A bound member and a post of up to 3,000 characters are required.",
    );
  const version = apiVersion();
  try {
    const response = await fetch("https://api.linkedin.com/rest/posts", {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
      headers: {
        ...bearer(token),
        "Content-Type": "application/json",
        "LinkedIn-Version": version,
        "X-Restli-Protocol-Version": "2.0.0",
      },
      body: JSON.stringify({
        author,
        commentary: encodeCommentary(text),
        visibility: "PUBLIC",
        distribution: {
          feedDistribution: "MAIN_FEED",
          targetEntities: [],
          thirdPartyDistributionChannels: [],
        },
        lifecycleState: "PUBLISHED",
        isReshareDisabledByAuthor: false,
      }),
    });
    await response.body?.cancel();
    if (!response.ok) throw providerFailure("LinkedIn", response.status);
    const id = response.headers.get("x-restli-id") || "";
    if (response.status !== 201 || !/^urn:li:(?:share|ugcPost):\d+$/u.test(id))
      throw new ConnectorError(
        "LinkedIn",
        "Publication outcome is unconfirmed. Check LinkedIn before posting again.",
        502,
      );
    return { id, url: "https://www.linkedin.com/feed/update/" + id + "/" };
  } catch (e) {
    if (e instanceof ConnectorError) throw e;
    throw new ConnectorError(
      "LinkedIn",
      "Publication outcome is unknown. Check your LinkedIn activity before retrying.",
      502,
    );
  }
}
