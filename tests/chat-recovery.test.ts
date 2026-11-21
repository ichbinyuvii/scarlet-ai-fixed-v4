import { test } from "node:test";
import assert from "node:assert/strict";
import { imageIntent } from "../lib/media-intent";
import { streamEvents } from "../lib/providers/streaming";

test("image tool intents route the requested examples and preserve text-only requests", () => {
  for (const command of [
    "Scarlet, generate a futuristic red Lamborghini-style concept car.",
    "Scarlet, create an image of a futuristic city.",
    "Scarlet, generate a professional YouTube thumbnail.",
    "Scarlet, design a logo for my startup.",
    "Draw a garden.",
    "Scarlet, generate an image of a futuristic red sports car.",
    "Scarlet, create a realistic mountain landscape.",
    "Scarlet, generate a cinematic AI wallpaper.",
  ])
    assert.equal(imageIntent(command), true, command);
  for (const command of [
    "Describe a photo of a mountain",
    "create a prompt for an image",
    "generate a script that makes a picture",
    "write a LinkedIn post announcing a logo",
  ])
    assert.equal(imageIntent(command), false, command);
});
test("cloud streaming transports decode split events and require a termination event", async () => {
  const original = globalThis.fetch;
  try {
    for (const provider of ["anthropic", "google"] as const) {
      const events =
        provider === "google"
          ? [
              {
                candidates: [
                  {
                    content: {
                      parts: [
                        { thought: true, text: "internal" },
                        { text: "नमस्ते" },
                      ],
                    },
                  },
                ],
              },
              {
                candidates: [{ finishReason: "STOP" }],
                usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 1 },
              },
            ]
          : [
              {
                type: "message_start",
                message: { usage: { input_tokens: 8 } },
              },
              {
                type: "content_block_delta",
                delta: { type: "text_delta", text: "नमस्ते" },
              },
              { type: "message_delta", usage: { output_tokens: 1 } },
              { type: "message_stop" },
            ];
      const make = (items: object[]) => {
        const bytes = new TextEncoder().encode(
          items.map((e) => "data: " + JSON.stringify(e) + "\n\n").join(""),
        );
        return new Response(
          new ReadableStream({
            start(c) {
              for (let i = 0; i < bytes.length; i += 7)
                c.enqueue(bytes.slice(i, i + 7));
              c.close();
            },
          }),
        );
      };
      globalThis.fetch = async () => make(events);
      let rendered = "";
      const delivery = {
        signal: new AbortController().signal,
        onText: (t: string) => {
          rendered += t;
        },
      };
      const data = await streamEvents(
        provider,
        "https://fixture.invalid",
        {},
        delivery,
      );
      assert.equal(rendered, "नमस्ते");
      assert.equal(data.inputTokens, 8);
      assert.equal(data.outputTokens, 1);
      globalThis.fetch = async () => make(events.slice(0, -1));
      await assert.rejects(
        streamEvents(provider, "https://fixture.invalid", {}, delivery),
        /without a complete answer/,
      );
    }
  } finally {
    globalThis.fetch = original;
  }
});
