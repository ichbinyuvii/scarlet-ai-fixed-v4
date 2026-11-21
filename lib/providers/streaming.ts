import { createParser } from "eventsource-parser";
import { ConnectorError, providerFailure } from "./http";

export type Delivery = { signal: AbortSignal; onText: (delta: string) => void };

export async function streamEvents(
  provider: "anthropic" | "google",
  url: string,
  init: RequestInit,
  output: Delivery,
) {
  const signal = AbortSignal.any([output.signal, AbortSignal.timeout(120_000)]);
  const response = await fetch(url, {
    ...init,
    signal,
    redirect: "error",
    cache: "no-store",
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw providerFailure(provider, response.status || 502);
  }
  let text = "",
    inputTokens = 0,
    outputTokens = 0,
    finished = false,
    bytes = 0;
  const parser = createParser({
    onEvent(event) {
      const data = JSON.parse(event.data);
      if (data.error)
        throw new ConnectorError(
          provider,
          "The model interrupted its response.",
          502,
        );
      let delta = "";
      if (provider === "anthropic") {
        if (data.delta?.type === "text_delta") delta = data.delta.text;
        inputTokens = data.message?.usage?.input_tokens ?? inputTokens;
        outputTokens = data.usage?.output_tokens ?? outputTokens;
        finished ||= data.type === "message_stop";
      } else {
        const candidate = data.candidates?.[0];
        delta =
          candidate?.content?.parts
            ?.filter((p: { thought?: boolean }) => !p.thought)
            .map((p: { text?: string }) => p.text || "")
            .join("") || "";
        finished ||= !!candidate?.finishReason;
        inputTokens = data.usageMetadata?.promptTokenCount ?? inputTokens;
        outputTokens = data.usageMetadata?.candidatesTokenCount ?? outputTokens;
      }
      if (delta) {
        text += delta;
        output.onText(delta);
      }
    },
  });
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 4_000_000)
        throw new ConnectorError(
          provider,
          "Model response exceeded the size limit.",
          502,
        );
      parser.feed(decoder.decode(chunk.value, { stream: true }));
    }
    parser.feed(decoder.decode());
    if (!finished || !text.trim())
      throw new ConnectorError(
        provider,
        "The model stream ended without a complete answer.",
        502,
      );
    return { text: text.trim(), inputTokens, outputTokens };
  } finally {
    await reader.cancel().catch(() => {});
  }
}
