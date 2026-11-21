import { z } from "zod";
import { createHash } from "node:crypto";
import { audit, must, query, quota, type Row, Problem } from "./db";
import { connection, putConnection } from "./security";
import { discoverModels, verifyWhatsAppPhone, searchWeb } from "./connectors";
import { bearer, requestJson } from "./providers/http";
import { linkedInConfigured } from "./providers/linkedin";
import { testLinkedIn } from "./linkedin-workspace";
import { localModelEnabled } from "./local-model";

export const serviceKind = z.enum([
  "model",
  "ollama",
  "email",
  "calendar",
  "whatsapp",
  "search",
  "linkedin",
  "browser",
  "files",
  "images",
]);
export type ServiceKind = z.infer<typeof serviceKind>;
export const builtins = ["browser", "files", "images"] as const;
export type HealthState =
  | "CONNECTED"
  | "DISCONNECTED"
  | "SETUP REQUIRED"
  | "AUTHORIZATION REQUIRED"
  | "UNAVAILABLE"
  | "ERROR";
export const serviceCatalog = [
  {
    id: "model",
    name: "Model gateway",
    family: "Intelligence",
    auth: "API key",
    scope: "Send permitted content to the chosen model.",
    actions: ["chat", "plan", "analyze"],
    setup:
      "Choose a provider, supply its API key and select a discovered model. One model gateway is active per workspace.",
  },
  {
    id: "ollama",
    name: "Ollama",
    family: "Intelligence",
    auth: "Local host",
    scope: "Send prompts to the operator's loopback Ollama service.",
    actions: ["discover", "chat"],
    setup:
      "Enable local discovery and set the compatible endpoint to http://127.0.0.1:11434/v1. Install a chat model in Ollama. This option shares the model gateway slot.",
  },
  {
    id: "email",
    name: "Gmail",
    family: "Communication",
    auth: "Google OAuth",
    scope: "Read inbox messages and send explicitly approved email.",
    actions: ["mail.read", "mail.draft", "mail.send"],
    setup:
      "Enable the Gmail API. Configure the Google OAuth client and exact callback URL, then authorize the read and send scopes.",
  },
  {
    id: "calendar",
    name: "Google Calendar",
    family: "Productivity",
    auth: "Google OAuth",
    scope: "Read owned calendar events and create approved events.",
    actions: ["calendar.read", "calendar.publish"],
    setup:
      "Enable the Calendar API and configure the Google web OAuth client. Authorize the owned-calendar scopes.",
  },
  {
    id: "whatsapp",
    name: "WhatsApp Business",
    family: "Communication",
    auth: "Business token",
    scope:
      "Read signed business messages and send reviewed or policy-authorized replies.",
    actions: ["wa.receive", "wa.draft", "wa.send"],
    setup:
      "Configure the signed Meta webhook and Graph API version. Verify a registered business phone number ID and its authorized access token.",
  },
  {
    id: "linkedin",
    name: "LinkedIn",
    family: "Communication",
    auth: "LinkedIn OAuth",
    scope:
      "openid, profile and w_member_social. Publish only to the bound member after revision approval.",
    actions: ["post.draft", "post.rewrite", "post.publish"],
    setup:
      "Enable Sign In with LinkedIn using OpenID Connect and Share on LinkedIn in the developer app. Set the client ID, secret, callback and supported API version.",
  },
  {
    id: "search",
    name: "Brave Search",
    family: "Research",
    auth: "API key",
    scope: "Send public search queries to Brave.",
    actions: ["web.search"],
    setup:
      "Connect a Brave Web Search API subscription key. The connection test uses one query.",
  },
  {
    id: "browser",
    name: "Browser reader",
    family: "Research",
    auth: "Workspace permission",
    scope: "Read public HTTPS pages on the administrator's allowed hosts.",
    actions: ["source.inspect"],
    setup:
      "Set RESEARCH_HOSTS and install sandbox-capable Chromium in the worker. The test launches the isolated, offline reader.",
  },
  {
    id: "files",
    name: "File analysis",
    family: "Workspace",
    auth: "Workspace permission",
    scope: "Parse files uploaded to this workspace.",
    actions: ["file.upload", "file.extract"],
    setup:
      "Enable file intake to process permitted uploads. The test parses a short text file through the upload extractor.",
  },
  {
    id: "images",
    name: "Image generation",
    family: "Creative",
    auth: "Deployment provider",
    scope:
      "Send image prompts to the configured service. Generation may be billed.",
    actions: ["image.generate"],
    setup:
      "Set the deployment's cloud or local image-provider configuration. A catalog probe checks model availability without generating an image.",
  },
] as const;
const isBuiltin = (k: ServiceKind) => builtins.some((b) => b === k);
function configKey(kind: ServiceKind) {
  const keys: Partial<Record<ServiceKind, string[]>> = {
    images: [
      "IMAGE_PROVIDER",
      "OPENAI_IMAGE_MODEL",
      "OPENAI_API_KEY",
      "LOCAL_IMAGE_BASE_URL",
      "LOCAL_IMAGE_MODEL",
      "LOCAL_IMAGE_API_KEY",
    ],
    browser: ["RESEARCH_HOSTS", "CHROMIUM_PATH", "PLAYWRIGHT_BROWSERS_PATH"],
    files: ["CLAMAV_SOCKET"],
  };
  return createHash("sha256")
    .update(JSON.stringify((keys[kind] || []).map((k) => process.env[k] || "")))
    .digest("hex");
}
export async function requireToolEnabled(
  uid: string,
  kind: (typeof builtins)[number],
) {
  const [row] = await query(
    "SELECT enabled FROM connector_checks WHERE user_id=$1 AND kind=$2",
    [uid, kind],
  );
  must(
    row?.enabled !== false,
    "Enable " + kind + " in Integrations to use this tool.",
    403,
  );
}
export async function recordCheck(
  uid: string,
  kind: ServiceKind,
  status: HealthState,
  detail: string,
) {
  await query(
    "INSERT INTO connector_checks(user_id,kind,status,detail,config_key,last_success) VALUES($1,$2,$3,$4,$5,CASE WHEN $3='CONNECTED' THEN now() ELSE NULL END) ON CONFLICT(user_id,kind) DO UPDATE SET status=excluded.status,detail=excluded.detail,config_key=excluded.config_key,checked_at=now(),last_success=COALESCE(excluded.last_success,connector_checks.last_success)",
    [uid, kind, status, detail.slice(0, 400), configKey(kind)],
  );
}
export async function toggleBuiltin(
  uid: string,
  kind: ServiceKind,
  enabled: boolean,
) {
  must(isBuiltin(kind), "This connector needs an account connection.");
  await query(
    "INSERT INTO connector_checks(user_id,kind,status,detail,enabled) VALUES($1,$2,'DISCONNECTED',$3,$4) ON CONFLICT(user_id,kind) DO UPDATE SET enabled=excluded.enabled,status='DISCONNECTED',detail=excluded.detail,checked_at=now()",
    [
      uid,
      kind,
      enabled
        ? "Enabled. Run a connection test."
        : "Disabled in this workspace.",
      enabled,
    ],
  );
  await audit(
    uid,
    enabled ? "Workspace tool enabled" : "Workspace tool disabled",
    "integration",
    kind,
  );
}
export async function connectOllama(uid: string) {
  must(
    localModelEnabled(),
    "Local Ollama discovery is unavailable on this deployment.",
    503,
  );
  const models = await discoverModels("compatible", "local-ollama");
  const model = process.env.LOCAL_MODEL_ID || models[0];
  must(
    model && models.includes(model),
    "Install or select an available local chat model.",
    409,
  );
  await putConnection(
    uid,
    "model",
    { provider: "compatible", model, apiKey: "local-ollama" },
    "Ollama · " + model,
  );
  await Promise.all([
    recordCheck(uid, "model", "CONNECTED", "Local model catalog verified."),
    recordCheck(uid, "ollama", "CONNECTED", "Local model catalog verified."),
  ]);
}
export async function healthRows(uid: string, connections: Row[]) {
  const rows = await query(
    "SELECT kind,status,detail,last_success,checked_at,enabled,config_key FROM connector_checks WHERE user_id=$1",
    [uid],
  );
  const { imageProviderStatus } = await import("./providers/images");
  const img = imageProviderStatus();
  const google = !!(
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    process.env.GOOGLE_REDIRECT_URI
  );
  const prerequisites: Partial<Record<ServiceKind, boolean>> = {
    email: google,
    calendar: google,
    whatsapp: !!(
      process.env.META_APP_SECRET &&
      process.env.META_VERIFY_TOKEN &&
      process.env.META_GRAPH_VERSION
    ),
    linkedin: linkedInConfigured(),
    browser: !!process.env.RESEARCH_HOSTS?.trim(),
    images: img.configured,
    ollama: localModelEnabled(),
  };
  return serviceCatalog.map((c) => {
    const kind = c.id,
      active =
        kind === "ollama"
          ? connections.find(
              (r) => r.kind === "model" && r.label.startsWith("Ollama ·"),
            )
          : connections.find((r) => r.kind === kind);
    const health = rows.find((r) => r.kind === kind),
      enabled = health?.enabled !== false,
      metadata = active?.public_meta || {};
    let status: HealthState = "DISCONNECTED",
      detail = "";
    const last =
      health?.last_success ??
      (kind === "linkedin" && !metadata.author
        ? null
        : active?.updated_at || null);
    const recent =
      health &&
      (!isBuiltin(kind) || health.config_key === configKey(kind)) &&
      (!active ||
        new Date(health.checked_at).getTime() >=
          new Date(active.updated_at).getTime());
    if (prerequisites[kind] === false) {
      status = kind === "ollama" ? "UNAVAILABLE" : "SETUP REQUIRED";
      detail = kind === "images" ? img.reason || c.setup : c.setup;
    } else if (isBuiltin(kind) && !enabled) {
      detail = "Disabled in this workspace.";
    } else if (
      kind === "linkedin" &&
      active &&
      (!metadata.author ||
        (!metadata.refreshable && Number(metadata.expiresAt) <= Date.now()))
    ) {
      status = "AUTHORIZATION REQUIRED";
      detail = "Reconnect LinkedIn and verify the member and publishing scope.";
    } else if (
      recent &&
      health.status !== "CONNECTED" &&
      (isBuiltin(kind) || active)
    ) {
      status = health.status;
      detail = health.detail;
    } else if (active) {
      status = "CONNECTED";
      detail = active.label;
    } else if (isBuiltin(kind)) {
      status = recent ? health.status : "DISCONNECTED";
      detail = recent
        ? health.detail
        : "Enabled. Run a connection test to verify the installed service.";
    } else if (["email", "calendar", "linkedin"].includes(kind)) {
      status = "AUTHORIZATION REQUIRED";
      detail = "Authorize the account in this workspace.";
    } else {
      detail = "Connect a service to this workspace.";
    }
    return {
      ...c,
      status,
      detail,
      enabled,
      account: active?.label || null,
      meta: metadata,
      lastSuccess: last,
      checkedAt: health?.checked_at || null,
      hosted: isBuiltin(kind),
    };
  });
}
async function probe(uid: string, kind: ServiceKind) {
  if (isBuiltin(kind))
    await requireToolEnabled(uid, kind as (typeof builtins)[number]);
  if (kind === "files") {
    const { extractDocument } = await import("./documents");
    const result = await extractDocument(
      "health.txt",
      Buffer.from("SCARLET file check"),
      "text/plain",
    );
    must(result.text === "SCARLET file check", "File extraction failed.", 502);
    return "Text extraction verified.";
  }
  if (kind === "images") {
    const { probeImageProvider } = await import("./providers/images");
    const r = await probeImageProvider();
    return "Model catalog verified · " + r.provider + " / " + r.model;
  }
  if (kind === "browser") {
    must(
      process.env.RESEARCH_HOSTS?.trim(),
      "Configure the research allowlist first.",
      503,
    );
    const { renderSource } = await import("./research");
    const page = await renderSource({
      url: "https://example.org/",
      html: "<title>Workspace health check</title><main>Reader check</main>",
    });
    must(
      page.text.includes("Reader check"),
      "Source reader verification failed.",
      502,
    );
    return "Sandboxed Chromium rendered an offline document.";
  }
  if (kind === "linkedin") {
    const linked = await testLinkedIn(uid);
    return "Member and publishing grant verified · " + linked.member;
  }
  if (kind === "email" || kind === "calendar") {
    const { googleToken } = await import("./engine");
    const token = await googleToken(uid, kind);
    const url =
      kind === "email"
        ? "https://gmail.googleapis.com/gmail/v1/users/me/profile?fields=emailAddress"
        : "https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=1&fields=kind";
    await requestJson(kind, url, { headers: bearer(token) });
    return kind === "email"
      ? "Inbox access verified."
      : "Primary calendar access verified.";
  }
  const c = await connection(uid, kind === "ollama" ? "model" : kind);
  if (kind === "model" || kind === "ollama") {
    if (kind === "ollama")
      must(
        localModelEnabled() && c.apiKey === "local-ollama",
        "Select Ollama as the workspace model first.",
        409,
      );
    must(
      (await discoverModels(c.provider, c.apiKey)).includes(c.model),
      "The selected model is unavailable. Choose another model.",
      404,
    );
    return "Model catalog verified · " + c.model;
  }
  if (kind === "whatsapp") {
    const phone = await verifyWhatsAppPhone(c.token, c.phoneId);
    return (
      "Business account verified · " +
      (phone.name || phone.number || "phone ID ending " + phone.id.slice(-4))
    );
  }
  await searchWeb("workspace connection check", c.apiKey);
  return "Brave Web Search accepted the test query.";
}
export async function runConnectorTest(uid: string, kind: ServiceKind) {
  try {
    const detail = await probe(uid, kind);
    await recordCheck(uid, kind, "CONNECTED", detail);
    return { status: "CONNECTED", detail };
  } catch (e) {
    const status = Number((e as { status?: number }).status);
    const detail =
      e instanceof Error
        ? e.message.slice(0, 360)
        : "The service could not complete the connection test.";
    const result: HealthState =
      status === 401 || status === 403
        ? "AUTHORIZATION REQUIRED"
        : status === 503 || status === 404
          ? "UNAVAILABLE"
          : "ERROR";
    await recordCheck(uid, kind, result, detail);
    await audit(
      uid,
      "Connector health check failed",
      "integration",
      kind + " · " + detail,
    );
    throw new Problem(status >= 400 && status < 600 ? status : 502, detail);
  }
}
export async function requestConnectorTest(uid: string, kind: ServiceKind) {
  await quota("connector-test:" + uid, 30, 3600);
  if (kind === "browser" && process.env.REDIS_URL) {
    await requireToolEnabled(uid, "browser");
    const { createTask } = await import("./engine");
    return {
      queued: true,
      id: await createTask(uid, "connector.browser.test", "Test source reader"),
    };
  }
  return runConnectorTest(uid, kind);
}
