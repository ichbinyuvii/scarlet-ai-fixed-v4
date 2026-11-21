export type TurnEvent = {
  conversationId?: string;
  delta?: string;
  error?: string;
  done?: { conversationId: string; intent: string; text: string };
};
export async function readTurn(
  payload: object,
  signal: AbortSignal,
  receive: (e: TurnEvent) => void,
) {
  const r = await fetch("/api/chat/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  if (!r.ok || !r.body)
    throw new Error(
      (await r.json().catch(() => ({}))).error ||
        "The conversation service is unavailable.",
    );
  const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
  let pending = "",
    complete = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += value;
    let newline;
    while ((newline = pending.indexOf("\n")) !== -1) {
      const event: TurnEvent = JSON.parse(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
      if (event.error) throw new Error(event.error);
      if (event.done) complete = true;
      receive(event);
    }
  }
  if (!complete)
    throw new Error(
      "The response was interrupted. Reopen the conversation to check its saved messages.",
    );
}
