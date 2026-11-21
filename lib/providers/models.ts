import OpenAI from "openai";
import { streamEvents, type Delivery } from "./streaming";
import {
  ConnectorError,
  postJson,
  providerFailure,
  requestJson,
  requiredEnv,
} from "./http";

export type Provider = "openai" | "anthropic" | "google" | "compatible";
export type InputImage = {
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  data: string;
};
export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  image?: InputImage;
};
export type ModelRequest = {
  provider: Provider;
  apiKey: string;
  model: string;
  system: string;
  messages: ChatMessage[];
  maxTokens?: number;
};
export type ModelReply = {
  text: string;
  inputTokens: number;
  outputTokens: number;
};

const googleApi = "https://generativelanguage.googleapis.com/v1beta/";
const anthropicApi = "https://api.anthropic.com/v1/";

function anthropicHeaders(key: string) {
  return { "x-api-key": key, "anthropic-version": "2023-06-01" };
}

export function openAIClient(provider: Provider, apiKey: string) {
  let baseURL = "https://api.openai.com/v1";
  if (provider === "compatible") {
    const url = new URL(requiredEnv("AI_COMPATIBLE_BASE_URL"));
    const loopback =
      process.env.PUBLIC_DEPLOYMENT !== "1" &&
      process.env.LOCAL_MODEL_DISCOVERY === "1" &&
      url.href === "http://127.0.0.1:11434/v1";
    if (
      (!loopback && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new ConnectorError(
        provider,
        "Configure a trusted HTTPS model endpoint on the server.",
      );
    }
    baseURL = url.href.replace(/\/$/, "");
  }
  return new OpenAI({
    apiKey,
    baseURL,
    timeout: 40_000,
    maxRetries: 0,
    fetchOptions: { redirect: "error", cache: "no-store" },
  });
}

export async function safeSdk<T>(
  provider: string,
  call: () => Promise<T>,
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    if (error instanceof OpenAI.APIError && error.status)
      throw providerFailure(provider, error.status);
    throw new ConnectorError(
      provider,
      "The model service could not be reached.",
      502,
    );
  }
}

export async function discoverModels(
  provider: Provider,
  apiKey: string,
): Promise<string[]> {
  if (!apiKey?.trim())
    throw new ConnectorError(provider, "An API key is required.");
  if (provider === "openai" || provider === "compatible") {
    const page = await safeSdk(provider, () =>
      openAIClient(provider, apiKey).models.list(),
    );
    return page.data.map((m) => m.id).sort();
  }
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    if (provider === "google") {
      const url = new URL(googleApi + "models");
      url.searchParams.set("pageSize", "100");
      if (cursor) url.searchParams.set("pageToken", cursor);
      const data = await requestJson<{
        models?: { name: string; supportedGenerationMethods?: string[] }[];
        nextPageToken?: string;
      }>(provider, url, { headers: { "x-goog-api-key": apiKey } });
      for (const model of data.models ?? []) {
        if (model.supportedGenerationMethods?.includes("generateContent"))
          ids.push(model.name.replace(/^models\//, ""));
      }
      cursor = data.nextPageToken;
    } else if (provider === "anthropic") {
      const url = new URL(anthropicApi + "models");
      url.searchParams.set("limit", "100");
      if (cursor) url.searchParams.set("after_id", cursor);
      const data = await requestJson<{
        data: { id: string }[];
        has_more: boolean;
        last_id?: string;
      }>(provider, url, { headers: anthropicHeaders(apiKey) });
      ids.push(...data.data.map((model) => model.id));
      cursor = data.has_more ? data.last_id : undefined;
    } else {
      throw new ConnectorError("models", "Select an available model provider.");
    }
    if (!cursor) break;
  }
  return [...new Set(ids)].sort();
}

function checkRequest(request: ModelRequest): number {
  if (!request.apiKey || !request.model || request.model.length > 250)
    throw new ConnectorError(
      "models",
      "Choose a connected provider and model.",
    );
  if (
    !Array.isArray(request.messages) ||
    !request.messages.length ||
    request.messages.length > 128
  )
    throw new ConnectorError(
      "models",
      "Conversation history is outside the request limit.",
    );
  let chars = request.system.length;
  let imageChars = 0;
  for (const message of request.messages) {
    if (
      typeof message.content !== "string" ||
      !["assistant", "user"].includes(message.role)
    )
      throw new ConnectorError("models", "Invalid conversation message.");
    chars += message.content.length;
    if (message.image) {
      const { data, mimeType } = message.image;
      imageChars += data.length;
      if (
        message.role !== "user" ||
        imageChars > 7_000_000 ||
        !["image/jpeg", "image/png", "image/webp"].includes(mimeType) ||
        !/^[A-Za-z0-9+/]+=*$/u.test(data)
      ) {
        throw new ConnectorError(
          "models",
          "Use a supported image within the upload limit.",
        );
      }
    }
  }
  if (chars > 140_000)
    throw new ConnectorError(
      "models",
      "Shorten the selected context before sending.",
    );
  const cap = request.maxTokens ?? 1200;
  if (!Number.isInteger(cap) || cap < 1 || cap > 4096)
    throw new ConnectorError("models", "Output budget must be 1–4096 tokens.");
  return cap;
}

function reply(text: string, input = 0, output = 0): ModelReply {
  if (!text.trim())
    throw new ConnectorError(
      "models",
      "The provider returned no displayable text. Try a different request or model.",
      422,
    );
  return { text: text.trim(), inputTokens: input, outputTokens: output };
}

export async function chatModel(
  request: ModelRequest,
  delivery?: Delivery,
): Promise<ModelReply> {
  const { provider, apiKey, model, system, messages } = request;
  const maxTokens = checkRequest(request);
  if (provider === "openai") {
    const params = {
      model,
      store: false,
      instructions: system,
      max_output_tokens: maxTokens,
      input: messages.map((message) => ({
        role: message.role,
        content: message.image
          ? [
              { type: "input_text" as const, text: message.content },
              {
                type: "input_image" as const,
                detail: "auto" as const,
                image_url:
                  "data:" +
                  message.image.mimeType +
                  ";base64," +
                  message.image.data,
              },
            ]
          : message.content,
      })),
    };
    const client = openAIClient(provider, apiKey);
    if (delivery)
      return safeSdk(provider, async () => {
        const stream = await client.responses.create(
          { ...params, stream: true },
          { signal: delivery.signal },
        );
        let text = "";
        for await (const e of stream) {
          if (e.type === "response.output_text.delta") {
            text += e.delta;
            delivery.onText(e.delta);
          }
          if (e.type === "response.completed")
            return reply(
              text,
              e.response.usage?.input_tokens,
              e.response.usage?.output_tokens,
            );
        }
        throw new ConnectorError(
          provider,
          "The model stream ended before completion.",
          502,
        );
      });
    const result = await safeSdk(provider, () =>
      client.responses.create(params),
    );
    return reply(
      result.output_text,
      result.usage?.input_tokens,
      result.usage?.output_tokens,
    );
  }
  if (provider === "compatible") {
    const params = {
      model,
      max_tokens: maxTokens,
      messages: [
        { role: "system" as const, content: system },
        ...messages.map((message) => {
          if (message.role === "assistant")
            return { role: "assistant" as const, content: message.content };
          return {
            role: "user" as const,
            content: message.image
              ? [
                  { type: "text" as const, text: message.content },
                  {
                    type: "image_url" as const,
                    image_url: {
                      url:
                        "data:" +
                        message.image.mimeType +
                        ";base64," +
                        message.image.data,
                    },
                  },
                ]
              : message.content,
          };
        }),
      ],
    };
    const client = openAIClient(provider, apiKey);
    if (delivery)
      return safeSdk(provider, async () => {
        const stream = await client.chat.completions.create(
          { ...params, stream: true, stream_options: { include_usage: true } },
          { signal: delivery.signal },
        );
        let text = "",
          input = 0,
          output = 0,
          finished = false;
        for await (const part of stream) {
          const delta = part.choices[0]?.delta.content;
          if (delta) {
            text += delta;
            delivery.onText(delta);
          }
          finished ||= !!part.choices[0]?.finish_reason;
          input = part.usage?.prompt_tokens ?? input;
          output = part.usage?.completion_tokens ?? output;
        }
        if (!finished)
          throw new ConnectorError(
            provider,
            "The model stream ended before completion.",
            502,
          );
        return reply(text, input, output);
      });
    const result = await safeSdk(provider, () =>
      client.chat.completions.create(params),
    );
    return reply(
      result.choices[0]?.message.content ?? "",
      result.usage?.prompt_tokens,
      result.usage?.completion_tokens,
    );
  }
  if (provider === "anthropic") {
    const init = postJson(anthropicHeaders(apiKey), {
      ...(delivery ? { stream: true } : {}),
      model,
      system,
      max_tokens: maxTokens,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.image
          ? [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: m.image.mimeType,
                  data: m.image.data,
                },
              },
              { type: "text", text: m.content },
            ]
          : m.content,
      })),
    });
    if (delivery)
      return streamEvents(provider, anthropicApi + "messages", init, delivery);
    const result = await requestJson<{
      content: { type: string; text?: string }[];
      usage: { input_tokens: number; output_tokens: number };
    }>(provider, anthropicApi + "messages", init);
    return reply(
      result.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n"),
      result.usage?.input_tokens,
      result.usage?.output_tokens,
    );
  }
  if (provider !== "google")
    throw new ConnectorError("models", "Unknown provider.");
  const endpoint = googleApi + "models/" + encodeURIComponent(model);
  const init = postJson(
    { "x-goog-api-key": apiKey },
    {
      systemInstruction: { parts: [{ text: system }] },
      generationConfig: { maxOutputTokens: maxTokens },
      contents: messages.map((m) => ({
        role: m.role === "user" ? "user" : "model",
        parts: m.image
          ? [
              {
                inlineData: {
                  mimeType: m.image.mimeType,
                  data: m.image.data,
                },
              },
              { text: m.content },
            ]
          : [{ text: m.content }],
      })),
    },
  );
  if (delivery)
    return streamEvents(
      provider,
      endpoint + ":streamGenerateContent?alt=sse",
      init,
      delivery,
    );
  const result = await requestJson<{
    candidates?: {
      content?: { parts?: { text?: string; thought?: boolean }[] };
    }[];
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      thoughtsTokenCount?: number;
    };
  }>(provider, endpoint + ":generateContent", init);
  const parts = result.candidates?.[0]?.content?.parts ?? [];
  return reply(
    parts
      .filter((p) => !p.thought)
      .map((p) => p.text ?? "")
      .join(""),
    result.usageMetadata?.promptTokenCount,
    (result.usageMetadata?.candidatesTokenCount ?? 0) +
      (result.usageMetadata?.thoughtsTokenCount ?? 0),
  );
}
