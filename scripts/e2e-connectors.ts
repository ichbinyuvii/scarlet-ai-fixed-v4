import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import AxeBuilder from "@axe-core/playwright";

async function main() {
  const origin = process.env.PREVIEW_URL || "http://127.0.0.1:4317";
  const browser = await chromium.launch({
    executablePath:
      process.env.CHROMIUM_PATH ||
      (process.platform === "darwin"
        ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        : "/usr/bin/chromium"),
    headless: true,
    chromiumSandbox: true,
  });
  const where = resolve(
    process.env.SCREENSHOT_DIR || "test-results/screenshots",
  );
  await mkdir(where, { recursive: true });
  let inspectedPage: import("playwright-core").Page | undefined;
  try {
    const ctx = await browser.newContext({
      reducedMotion: "reduce",
      viewport: { width: 1440, height: 960 },
    });
    const page = await ctx.newPage();
    inspectedPage = page;
    page.on("response", (r) => {
      if (r.status() >= 400)
        console.log("HTTP", r.status(), new URL(r.url()).pathname);
    });
    const faults: string[] = [];
    page.on("pageerror", (e) => faults.push(e.message));
    page.setDefaultTimeout(35_000);
    await page.goto(origin + "/integrations");
    const files = page.locator("article#files");
    await files.getByRole("button").first().click();
    await files.getByRole("button", { name: "Test connection" }).click();
    await files.locator(".cp-status.is-connected").waitFor();
    await files.getByRole("button", { name: "Disable for workspace" }).click();
    await files.getByRole("button", { name: "Enable for workspace" }).waitFor();
    assert.equal(
      await files.getByRole("button", { name: "Test connection" }).isDisabled(),
      true,
    );
    await files.getByRole("button", { name: "Enable for workspace" }).click();
    await files.getByRole("button", { name: "Test connection" }).click();
    await files.locator(".cp-status.is-connected").waitFor();
    await files
      .getByRole("button", { name: "Close connection settings" })
      .click();
    await page.locator("article#linkedin").getByRole("button").first().click();
    await page
      .getByRole("link", { name: "Open post editor and history" })
      .waitFor();
    await page.screenshot({
      path: resolve(where, "08-connector-manager.png"),
      fullPage: true,
      animations: "disabled",
    });
    const statuses = await page
      .locator("article.cp-service")
      .evaluateAll((nodes) =>
        nodes.map((n) => [n.id, n.querySelector(".cp-status")?.textContent]),
      );
    console.log("Verified manager displays:", JSON.stringify(statuses));
    await page
      .getByRole("link", { name: "Open post editor and history" })
      .click();
    const input = page.getByRole("textbox", { name: "Post text" }),
      working = "A practical way to keep review work visible.";
    await input.fill(working);
    await page.getByRole("button", { name: "Save draft", exact: true }).click();
    await page.getByText("Draft saved.", { exact: true }).waitFor();
    await input.fill(working + " Each publication has a named reviewer.");
    await page.getByRole("button", { name: "Save draft", exact: true }).click();
    const history = page.locator(".li-history");
    await history.getByRole("button", { name: /Each publication/ }).waitFor();
    const state = await page.evaluate(async () => {
      const r = await fetch("/api/linkedin/history");
      return r.json();
    });
    assert.equal(state[0].revision, "2");
    const refused = await page.evaluate(async ({ id, revision }) => {
      const r = await fetch("/api/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, revision }),
      });
      return r.status;
    }, state[0]);
    assert.equal(refused, 409);
    assert.equal(
      await page.getByRole("button", { name: "Approve public post" }).count(),
      0,
    );
    await page.screenshot({
      path: resolve(where, "07-linkedin.png"),
      fullPage: true,
      animations: "disabled",
    });
    const a11y = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    const critical = a11y.violations.filter((v) =>
      ["critical", "serious"].includes(v.impact || ""),
    );
    assert.deepEqual(
      critical.map((v) => [v.id, v.nodes.map((n) => n.target)]),
      [],
    );
    await page.reload();
    await history.getByRole("button", { name: /Each publication/ }).click();
    assert.match(await input.inputValue(), /named reviewer/);
    assert.deepEqual(faults, []);
    console.log(
      "LinkedIn draft save, edit, preview, history, unlinked publish rejection and accessibility verified.",
    );
  } catch (e) {
    if (inspectedPage)
      console.error(
        "Visible page",
        (await inspectedPage.locator("body").innerText()).slice(0, 1500),
      );
    throw e;
  } finally {
    await browser.close();
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
