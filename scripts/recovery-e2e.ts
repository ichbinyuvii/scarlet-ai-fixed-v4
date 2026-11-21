/** Live checks for the recovered preview. Requires an operator-enabled local Ollama. */
import assert from "node:assert/strict";
import { chromium, type Page } from "playwright-core";
const base = process.env.PREVIEW_URL || "http://127.0.0.1:4317";
async function api(page: Page, path: string, body?: unknown) {
  return page.evaluate(
    async ({ path, body }) => {
      const r = await fetch(
        "/api/" + path,
        body === undefined
          ? {}
          : {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            },
      );
      return { status: r.status, data: await r.json() };
    },
    { path, body },
  );
}
async function main() {
  const browser = await chromium.launch({
    executablePath:
      process.env.CHROMIUM_PATH ||
      (process.platform === "darwin"
        ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        : "/usr/bin/chromium"),
    chromiumSandbox: true,
  });
  try {
    const ctx = await browser.newContext(),
      page = await ctx.newPage(),
      faults: string[] = [];
    page.setDefaultTimeout(75_000);
    page.on("pageerror", (e) => faults.push(e.message));
    await page.goto(base + "/chat");
    const input = page.getByRole("textbox", { name: "Message", exact: true });
    const send = async (text: string) => {
      await input.fill(text);
      await page
        .getByRole("button", { name: "Send message", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Send message", exact: true })
        .waitFor();
    };
    await send(
      "Our test launch site is Port Amber. Reply with the site name only.",
    );
    assert.match(
      await page.locator(".bubble.assistant").last().innerText(),
      /Port Amber/i,
    );
    const [first] = (await api(page, "state")).data.conversations;
    await send(
      "What is the name of our test launch site from my previous message? Give only the name.",
    );
    const storedAfterFollow = (await api(page, "chats/" + first.id)).data;
    assert.equal(
      storedAfterFollow.length,
      4,
      "Follow-up must be sent with the same conversation ID",
    );

    assert.match(
      await page.locator(".bubble.assistant").last().innerText(),
      /Port Amber/i,
    );
    const state = (await api(page, "state")).data,
      original = state.conversations[0].id;
    let history = (await api(page, "chats/" + original)).data;
    assert.equal(history.length, 4);
    await page.reload();
    await page.locator(".bubble.assistant").nth(1).waitFor();
    await page
      .getByRole("button", { name: "Edit in new conversation" })
      .first()
      .click();
    await send(
      "The revised launch site is Cedar Bay. Reply with its name only.",
    );
    assert.match(
      await page.locator(".bubble.assistant").last().innerText(),
      /Cedar Bay/i,
    );
    await page
      .getByRole("button", { name: "Regenerate in new conversation" })
      .last()
      .click();
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .waitFor();
    assert.match(
      await page.locator(".bubble.assistant").last().innerText(),
      /Cedar Bay/i,
    );
    history = (await api(page, "chats/" + original)).data;
    assert.equal(history.length, 4);
    assert.match(history[0].body, /Port Amber/);
    console.log(
      "PASS real chat, multi-turn recall, reload, edit and regeneration retaining original history",
    );
    const streamed = await page.evaluate(async () => {
      const r = await fetch("/api/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "Write three brief sentences about the Moon.",
        }),
      });
      return (await r.text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    });
    assert.ok(streamed.filter((e) => e.delta).length > 1);
    assert.equal(streamed.at(-1).done.intent, "answer");
    console.log("PASS incremental model deltas and terminal result");
    await input.fill(
      "Write a long, detailed essay about the history of calendars.",
    );
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await page.getByRole("button", { name: "Stop generation" }).click();
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .waitFor();
    await page.getByRole("button", { name: "Choose model" }).click();
    await page.getByRole("combobox", { name: "Active model" }).waitFor();
    assert.match(
      await page.getByRole("combobox", { name: "Active model" }).inputValue(),
      /llama/,
    );
    await input.fill(
      "Scarlet, generate a futuristic red Lamborghini-style concept car.",
    );
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await page.getByRole("heading", { name: "Generate an image" }).waitFor();
    const imageStatus = await api(page, "image/status");
    assert.equal(imageStatus.status, 200);
    assert.ok(
      await page
        .getByRole("button", { name: "Confirm image generation" })
        .isDisabled(),
      "Guest cannot spend image budget",
    );
    await page
      .getByRole("button", { name: "Generate image", exact: true })
      .click();
    await page.locator("input[type=file]").setInputFiles({
      name: "inspection.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(
        "The water level was forty-two meters at the station.",
      ),
    });
    await page.getByText(/Attached · inspection.txt/).waitFor();
    await send("What was the water level, according to this file?");
    assert.match(
      await page.locator(".bubble.assistant").last().innerText(),
      /forty.two|42/i,
    );
    console.log(
      "PASS model discovery, stop control, image review/setup gate and uploaded document Q&A",
    );
    await send(
      "Scarlet, write a LinkedIn post announcing our new observatory.",
    );
    assert.match(
      await page.locator(".bubble.assistant").last().innerText(),
      /Review LinkedIn draft/,
    );
    await page.getByRole("link", { name: "Review LinkedIn draft" }).waitFor();
    const drafts = (await api(page, "state")).data.tasks.filter(
      (t: any) => t.kind === "linkedin.publish",
    );
    assert.ok(
      drafts.length &&
        drafts.every((t: any) => t.state === "WAITING_FOR_APPROVAL"),
    );
    await page.getByRole("link", { name: "Review LinkedIn draft" }).click();
    await page.locator("main h1").waitFor();
    console.log(
      "PASS real AI-written LinkedIn draft, waiting for approval, and workspace navigation",
    );
    await page.goto(base + "/chat");
    await input.waitFor();
    const disconnected = await api(page, "disconnect", { kind: "model" });
    assert.equal(disconnected.status, 200);
    await send("Write a sentence describing the Moon.");
    assert.match(
      await page.locator(".bubble.assistant").last().innerText(),
      /connect.*model/i,
    );
    const other = await browser.newContext(),
      outsider = await other.newPage();
    await outsider.goto(base + "/chat");
    await outsider
      .getByRole("textbox", { name: "Message", exact: true })
      .waitFor();
    const foreign = await api(outsider, "chats/" + original);
    assert.ok(
      foreign.status === 404 ||
        (Array.isArray(foreign.data) && !foreign.data.length),
    );
    assert.deepEqual(faults, []);
    console.log(
      "PASS missing provider state, session isolation and no uncaught browser errors",
    );
  } finally {
    await browser.close();
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
