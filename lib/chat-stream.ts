import { z } from "zod";
import { command } from "./assistant";
import { Problem, type Row } from "./db";
import { ConnectorError } from "./connectors";
import { str } from "./validation";

export const turnSchema = z.object({
  text: str(6000),
  conversationId: str().optional(),
  documentId: str().optional(),
  branchFrom: str().optional(),
});

export function chatStream(
  user: Row,
  input: z.infer<typeof turnSchema>,
  request: Request,
) {
  const encoder = new TextEncoder(),
    stop = new AbortController();
  const signal = AbortSignal.any([request.signal, stop.signal]);
  return new Response(
    new ReadableStream({
      async start(controller) {
        const emit = (event: object) => {
          if (!signal.aborted)
            controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
        };
        try {
          const result = await command(
            user,
            input.text,
            input.conversationId,
            input.documentId,
            {
              signal,
              branchFrom: input.branchFrom,
              onStart: (conversationId) => emit({ conversationId }),
              onText: (delta) => emit({ delta }),
            },
          );
          emit({ done: result });
        } catch (e) {
          emit({
            error:
              e instanceof Problem || e instanceof ConnectorError
                ? e.message
                : "The conversation could not be completed.",
          });
        } finally {
          if (!stop.signal.aborted) controller.close();
        }
      },
      cancel() {
        stop.abort();
      },
    }),
    {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
        "X-Accel-Buffering": "no",
      },
    },
  );
}
