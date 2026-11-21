import sharp from "sharp";
import { Problem, must } from "../db";

export const imageSizes = ["1024x1024", "1536x1024", "1024x1536"] as const;
export type ImageSize = (typeof imageSizes)[number];
const maxImageBytes = 8 * 1024 * 1024;
export const defaultOpenAIImageModel = "gpt-image-1";
const cloudNotice =
  "Generate one image using the workspace’s OpenAI billing account. OpenAI prices depend on the selected model and size. A request already submitted to OpenAI may be billed if you stop it.";
const localNotice =
  "Generate one image on the configured local server. This uses local compute and one daily image attempt. Stopping a request may leave the model working until its current operation finishes.";

function configuration() {
  const provider = process.env.IMAGE_PROVIDER || "openai";
  if (provider !== "openai" && provider !== "local")
    throw new Problem(503, "Configure IMAGE_PROVIDER as openai or local.");
  const local = provider === "local";
  // The cloud path defaults to OpenAI's current GPT Image model so that setting
  // only OPENAI_API_KEY is enough. The local path has no safe default because
  // model IDs depend on what the operator installed.
  const model = (
    local
      ? process.env.LOCAL_IMAGE_MODEL
      : process.env.OPENAI_IMAGE_MODEL?.trim() || defaultOpenAIImageModel
  )?.trim();
  must(
    model && model.length <= 200 && /^[\w.:/-]+$/.test(model),
    "Configure an image-generation model on the server.",
    503,
  );
  if (!local) {
    must(
      process.env.OPENAI_API_KEY,
      "The server needs OpenAI image credentials.",
      503,
    );
    return {
      provider,
      model,
      key: process.env.OPENAI_API_KEY,
      base: "https://api.openai.com/v1",
      costNotice: cloudNotice,
    };
  }
  let base: URL;
  try {
    base = new URL(process.env.LOCAL_IMAGE_BASE_URL || "");
  } catch {
    throw new Problem(
      503,
      "Configure the local image server’s loopback /v1 endpoint.",
    );
  }
  must(
    ["http:", "https:"].includes(base.protocol) &&
      ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) &&
      !base.username &&
      !base.password &&
      !base.search &&
      !base.hash &&
      /^\/v1\/?$/.test(base.pathname),
    "The local image endpoint must use a loopback address (127.0.0.1, localhost or [::1]) and the /v1 path.",
    503,
  );
  return {
    provider,
    model,
    key: process.env.LOCAL_IMAGE_API_KEY,
    base: base.href.replace(/\/$/, ""),
    costNotice: localNotice,
  };
}
export function imageProviderStatus() {
  try {
    const { provider, model, costNotice } = configuration();
    return { configured: true, provider, model, costNotice, reason: "" };
  } catch (e) {
    return {
      configured: false,
      provider: process.env.IMAGE_PROVIDER === "local" ? "local" : "openai",
      model: null,
      costNotice:
        process.env.IMAGE_PROVIDER === "local" ? localNotice : cloudNotice,
      reason:
        e instanceof Problem ? e.message : "Image configuration unavailable.",
    };
  }
}

async function boundedJson(response: Response, max: number): Promise<any> {
  const reader = response.body?.getReader();
  if (!reader)
    throw new Problem(502, "The image provider returned an empty response.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (Number(response.headers.get("content-length") || 0) > max)
      throw new Problem(
        502,
        "The image provider response exceeds the size limit.",
      );
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max)
        throw new Problem(
          502,
          "The image provider response exceeds the size limit.",
        );
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (e) {
    await reader.cancel().catch(() => {});
    if (e instanceof Problem) throw e;
    throw new Problem(502, "The image provider returned unreadable data.");
  }
}
async function call(
  path: string,
  signal: AbortSignal,
  body?: unknown,
  max = 128 * 1024,
) {
  const c = configuration();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (c.key) headers.Authorization = "Bearer " + c.key;
  if (body) headers["Content-Type"] = "application/json";
  let r: Response;
  try {
    r = await fetch(c.base + path, {
      method: body ? "POST" : "GET",
      headers,
      body: body ? JSON.stringify(body) : undefined,
      redirect: "error",
      cache: "no-store",
      signal,
    });
  } catch {
    if (signal.aborted) throw signal.reason;
    throw new Problem(502, "The configured image server could not be reached.");
  }
  if (!r.ok) {
    await r.body?.cancel().catch(() => {});
    const message = (
      {
        400: "The provider declined this image request. Check the prompt, model and image size.",
        401: "Image-provider credentials were not accepted.",
        403: "The image provider denied access to this model or request.",
        404: "The selected image model or endpoint is unavailable.",
        429: "The image provider rate limit or billing quota was reached.",
      } as Record<number, string>
    )[r.status];
    throw new Problem(
      r.status === 429 ? 429 : r.status === 400 ? 422 : 502,
      message || "The image provider could not complete the request.",
    );
  }
  return boundedJson(r, max);
}
export async function probeImageProvider(signal?: AbortSignal) {
  const c = configuration();
  const timeout = AbortSignal.timeout(6000);
  const s = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const data = await call(
      c.provider === "local"
        ? "/models"
        : "/models/" + encodeURIComponent(c.model),
      s,
    );
    const present =
      c.provider === "local"
        ? Array.isArray(data?.data) &&
          data.data.some((m: any) => m?.id === c.model)
        : data?.id === c.model;
    must(
      present,
      "The configured image model is unavailable to this account or server.",
      503,
    );
    return { provider: c.provider, model: c.model };
  } catch (e) {
    if (!signal?.aborted && timeout.aborted)
      throw new Problem(504, "Image model availability check timed out.");
    throw e;
  }
}
export async function generatePixels(
  prompt: string,
  size: ImageSize,
  signal: AbortSignal,
) {
  const c = configuration();
  const payload = {
    model: c.model,
    prompt,
    size,
    n: 1,
    ...(c.provider === "openai"
      ? { output_format: "png", quality: "medium" }
      : { response_format: "b64_json" }),
  };
  const result = await call(
    "/images/generations",
    signal,
    payload,
    Math.ceil((maxImageBytes * 4) / 3) + 64000,
  );
  const encoded = result?.data?.[0]?.b64_json;
  must(
    typeof encoded === "string" &&
      encoded.length > 0 &&
      encoded.length <= Math.ceil(maxImageBytes / 3) * 4 &&
      encoded.length % 4 === 0 &&
      /^[A-Za-z0-9+/]+={0,2}$/.test(encoded),
    "The image provider must return a bounded base64 raster image.",
    502,
  );
  try {
    const raster = sharp(Buffer.from(encoded, "base64"), {
      failOn: "warning",
      limitInputPixels: 6_000_000,
    });
    const meta = await raster.metadata();
    const [w, h] = size.split("x").map(Number);
    must(
      ["png", "jpeg", "webp"].includes(meta.format || "") &&
        meta.width &&
        meta.height &&
        (meta.pages ?? 1) === 1 &&
        Math.abs(meta.width / meta.height - w / h) < 0.025,
      "The provider returned an unsupported image or aspect ratio.",
      502,
    );
    const bytes = await raster.png().toBuffer();
    must(
      bytes.length <= maxImageBytes,
      "Generated image exceeds the storage limit.",
      502,
    );
    return {
      bytes,
      width: meta.width,
      height: meta.height,
      model: c.model,
      provider: c.provider,
    };
  } catch (e) {
    if (e instanceof Problem) throw e;
    throw new Problem(
      502,
      "The image provider returned an invalid raster image.",
    );
  }
}
