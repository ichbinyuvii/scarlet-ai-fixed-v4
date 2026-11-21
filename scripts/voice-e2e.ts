import assert from "node:assert/strict";
import { chromium, type Browser, type Page } from "playwright-core";

const base = new URL(process.env.PREVIEW_URL || "http://127.0.0.1:4317");
if (!["127.0.0.1", "[::1]", "localhost"].includes(base.hostname))
  throw Error("Use a loopback preview for the virtual voice fixture.");
const chrome =
  process.env.CHROMIUM_PATH ||
  (process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : "/usr/bin/chromium");
async function launch() {
  return chromium.launch({
    executablePath: chrome,
    headless: true,
    chromiumSandbox: true,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE [::1]",
    ],
  });
}
async function open(
  browser: Browser,
  injectRecognition: boolean,
  route = "voice",
  quiet = false,
) {
  const context = await browser.newContext({
    permissions: ["microphone"],
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  await page.addInitScript(
    ({ injectRecognition, quiet }) => {
      const w = window as any;
      w.voiceProbe = {
        streams: [],
        contexts: [],
        recognizers: [],
        native: !!(w.SpeechRecognition || w.webkitSpeechRecognition),
        failMic: false,
      };
      const original = navigator.mediaDevices.getUserMedia.bind(
        navigator.mediaDevices,
      );
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        if (w.voiceProbe.failMic)
          throw new DOMException("Permission denied", "NotAllowedError");
        if (injectRecognition) {
          // Real Web Audio signal, generated in Chromium; independent of the remote recognizer and device noise suppression.
          const fixture = new RealContext();
          const oscillator = fixture.createOscillator();
          const gain = fixture.createGain();
          const output = fixture.createMediaStreamDestination();
          oscillator.frequency.value = 350;
          gain.gain.value = quiet ? 0 : 0.22;
          oscillator.connect(gain);
          gain.connect(output);
          oscillator.start();
          await fixture.resume();
          const track = output.stream.getAudioTracks()[0];
          const stop = track.stop.bind(track);
          track.stop = () => {
            stop();
            oscillator.stop();
            void fixture.close();
          };
          w.voiceProbe.streams.push(output.stream);
          return output.stream;
        }
        const stream = await original(constraints);
        w.voiceProbe.streams.push(stream);
        return stream;
      };
      const RealContext = window.AudioContext;
      w.AudioContext = class extends RealContext {
        constructor() {
          super();
          w.voiceProbe.contexts.push(this);
        }
      };
      if (injectRecognition) {
        w.SpeechRecognition = class {
          lang = "";
          continuous = false;
          interimResults = false;
          aborted = false;
          onstart?: () => void;
          onend?: () => void;
          onresult?: (e: any) => void;
          onerror?: (e: any) => void;
          constructor() {
            w.voiceProbe.recognizers.push(this);
          }
          start() {
            queueMicrotask(() => this.onstart?.());
          }
          abort() {
            this.aborted = true;
          }
          result(text: string, final: boolean) {
            this.onresult?.({
              resultIndex: 0,
              results: [{ 0: { transcript: text }, isFinal: final }],
            });
          }
        };
      }
    },
    { injectRecognition, quiet },
  );
  await page.goto(new URL("/" + route, base).href, {
    waitUntil: "domcontentloaded",
  });
  await page.locator("#main h1").waitFor();
  return { page, context };
}
async function cleaned(page: Page) {
  await page.waitForFunction(() => {
    const p = (window as any).voiceProbe;
    return (
      p.streams.length > 0 &&
      p.streams.every((s: MediaStream) =>
        s.getTracks().every((t) => t.readyState === "ended"),
      ) &&
      p.contexts.every((c: AudioContext) => c.state === "closed")
    );
  });
}
async function main() {
  let browser: Browser | undefined;
  try {
    browser = await launch();
    const native = await open(browser, false);
    const supported = await native.page.evaluate(
      () => (window as any).voiceProbe.native,
    );
    assert(
      supported,
      "Installed Chromium must expose a browser speech recognition constructor for this check",
    );
    await native.page.getByRole("button", { name: "Start listening" }).click();
    await native.page.waitForFunction(
      () => (window as any).voiceProbe.streams.length > 0,
    );
    const nativeTrack = await native.page.evaluate(() => {
      const t = (window as any).voiceProbe.streams[0].getAudioTracks()[0];
      return { label: t.label, rate: t.getSettings().sampleRate };
    });
    await native.page.waitForTimeout(350);
    const nativeStatus = await native.page
      .locator(".sv-console-panel h2")
      .innerText();
    if (
      await native.page.getByRole("button", { name: "Stop listening" }).count()
    )
      await native.page.getByRole("button", { name: "Stop listening" }).click();
    await cleaned(native.page);
    await native.context.close();
    console.log(
      "Unmodified browser speech API exposed; actual virtual input opened and released.",
      nativeTrack,
      nativeStatus,
    );

    const { page, context } = await open(browser, true);
    let commandCalls = 0;
    page.on("request", (r) => {
      if (new URL(r.url()).pathname === "/api/command" && r.method() === "POST")
        commandCalls++;
    });
    const readAloud = page.getByRole("checkbox", {
      name: "Read replies aloud",
    });
    if (await readAloud.isChecked()) await readAloud.uncheck();
    await page
      .getByRole("combobox", { name: "Language", exact: true })
      .selectOption("hi-IN");
    const start = page.getByRole("button", { name: "Start listening" }),
      draft = page.getByRole("textbox", { name: "Typed voice command" });
    assert.equal(
      await page.locator("#voice-command").count(),
      1,
      "Preview must contain the current transcript review component",
    );
    await start.click();
    await page.waitForFunction(
      () =>
        Number(
          document
            .querySelector('[role="meter"]')
            ?.getAttribute("aria-valuenow"),
        ) > 1,
    );
    assert.equal(
      await page.evaluate(
        () => (window as any).voiceProbe.recognizers.at(-1).lang,
      ),
      "hi-IN",
    );
    await page.evaluate(() =>
      (window as any).voiceProbe.recognizers
        .at(-1)
        .result("interim word", false),
    );
    await page.getByText("interim word", { exact: true }).waitFor();
    await page.evaluate(() =>
      (window as any).voiceProbe.recognizers
        .at(-1)
        .result("System stat us", true),
    );
    await page.waitForFunction(
      () =>
        (document.querySelector("#voice-command") as HTMLTextAreaElement)
          ?.value === "System stat us",
    );
    assert.equal(commandCalls, 0, "Final recognition must wait for review");
    await cleaned(page);
    await draft.fill("System status");
    await page.getByRole("button", { name: "Send typed command" }).click();
    await page
      .locator(".sv-transcript")
      .getByText(/workspace online/i)
      .waitFor();
    assert.equal(commandCalls, 1);
    await start.click();
    await page.getByRole("button", { name: "Stop listening" }).waitFor();
    await page.waitForFunction(
      () => (window as any).voiceProbe.recognizers.length >= 2,
    );
    await page.evaluate(() =>
      (window as any).voiceProbe.recognizers
        .at(-1)
        .onerror({ error: "network" }),
    );
    await page
      .getByRole("alert")
      .filter({ hasText: "speech service could not connect" })
      .waitFor();
    await cleaned(page);
    await page.evaluate(() => ((window as any).voiceProbe.failMic = true));
    await start.click();
    await page.getByText(/Microphone or speech access was denied/).waitFor();
    await page.evaluate(() => ((window as any).voiceProbe.failMic = false));
    await start.click();
    await page.waitForFunction(
      () => (window as any).voiceProbe.recognizers.length >= 3,
    );
    await page.getByRole("button", { name: "Mute input", exact: true }).click();
    await cleaned(page);
    assert.equal(await start.isDisabled(), true);
    await page.getByRole("button", { name: "Unmute input" }).click();
    assert.equal(await start.isEnabled(), true);
    await page.getByRole("checkbox", { name: /Wake phrase/ }).check();
    await start.click();
    await page.waitForFunction(
      () => (window as any).voiceProbe.recognizers.length >= 4,
    );
    await page.evaluate(() =>
      (window as any).voiceProbe.recognizers
        .at(-1)
        .result("unrelated speech", true),
    );
    assert.equal(await draft.inputValue(), "");
    await page.evaluate(() =>
      (window as any).voiceProbe.recognizers
        .at(-1)
        .result("Hey Scarlet review my notes", true),
    );
    await page.waitForFunction(
      () =>
        (document.querySelector("#voice-command") as HTMLTextAreaElement)
          ?.value === "review my notes",
    );
    assert.equal(commandCalls, 1);
    await cleaned(page);
    await page.getByRole("checkbox", { name: /Wake phrase/ }).uncheck();
    await draft.fill("");
    await start.click();
    await page.waitForFunction(
      () => (window as any).voiceProbe.recognizers.length >= 5,
    );
    await page.evaluate(() =>
      (window as any).voiceProbe.recognizers
        .at(-1)
        .result("partially dictated", false),
    );
    await page.getByRole("button", { name: "Stop listening" }).click();
    assert.equal(await draft.inputValue(), "partially dictated");
    await cleaned(page);
    await start.click();
    await page.waitForFunction(
      () => (window as any).voiceProbe.recognizers.length >= 6,
    );
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", {
        value: true,
        configurable: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page
      .getByText("Microphone closed when this tab was hidden.")
      .waitFor();
    await cleaned(page);
    assert.equal(commandCalls, 1);
    await context.close();
    console.log(
      "Injected recognizer with a real browser-generated tone: waveform, language, interim text, explicit review, edited submission, network error, permission loss, retry, mute, wake, manual interim recovery, hidden-tab and cleanup passed.",
    );

    const chat = await open(browser, true, "chat"),
      p = chat.page;
    await p
      .getByRole("button", { name: "Chat dictation", exact: true })
      .click();
    await p
      .getByRole("combobox", { name: "Dictation language" })
      .selectOption("fr-FR");
    await p.getByRole("button", { name: "Start dictation" }).click();
    await p.waitForFunction(
      () => (window as any).voiceProbe.recognizers.length > 0,
    );
    assert.equal(
      await p.evaluate(
        () => (window as any).voiceProbe.recognizers.at(-1).lang,
      ),
      "fr-FR",
    );
    await p.evaluate(() =>
      (window as any).voiceProbe.recognizers.at(-1).result("Bonjour", true),
    );
    assert.equal(
      await p
        .getByRole("textbox", { name: "Message", exact: true })
        .inputValue(),
      "Bonjour",
    );
    await cleaned(p);
    await chat.context.close();
    console.log("Chat inserts dictated text in the editable composer.");
    const quiet = await open(browser, true, "voice", true);
    await quiet.page.getByRole("button", { name: "Start listening" }).click();
    await quiet.page
      .getByText(/No speech was recognized. The microphone is closed/)
      .waitFor({ timeout: 18000 });
    await cleaned(quiet.page);
    await quiet.context.close();
    console.log(
      "A silent browser-generated MediaStream stopped on timeout and released its audio tracks and context.",
    );
  } finally {
    await browser?.close();
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
