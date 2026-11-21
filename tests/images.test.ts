import assert from "node:assert/strict";
import { after, before, beforeEach, test, type TestContext } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import sharp from "sharp";
import { GET, POST } from "../app/api/[...path]/route";
import { database, query } from "../lib/db";
import { session } from "../lib/security";
import {
  generatePixels,
  imageProviderStatus,
  probeImageProvider,
} from "../lib/providers/images";

let dir = "";
let pixel = "";
const origin = "https://scarlet.test";
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "scarlet-image-test-"));
  delete process.env.DATABASE_URL;
  process.env.SCARLET_DATA_DIR = dir;
  process.env.SCARLET_MASTER_KEY = randomBytes(32).toString("base64");
  process.env.SCARLET_RUN_MIGRATIONS = "1";
  process.env.PUBLIC_DEPLOYMENT = "0";
  process.env.APP_ORIGIN = origin;
  process.env.REDIS_URL = "redis://127.0.0.1:1";
  await database();
  pixel = (
    await sharp({
      create: { width: 24, height: 24, channels: 3, background: "#e83f51" },
    })
      .png()
      .toBuffer()
  ).toString("base64");
});
after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});
beforeEach(() => {
  process.env.IMAGE_PROVIDER = "local";
  process.env.LOCAL_IMAGE_BASE_URL = "http://127.0.0.1:9027/v1";
  process.env.LOCAL_IMAGE_MODEL = "fixture:creative";
  process.env.DAILY_IMAGE_GENERATIONS = "3";
  process.env.DAILY_IMAGE_SITE_LIMIT = "30";
  delete process.env.LOCAL_IMAGE_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_IMAGE_MODEL;
});
async function user(guest = false) {
  const uid = randomUUID();
  await query("INSERT INTO users(id,name,guest) VALUES($1,$2,$3)", [
    uid,
    "Test operator",
    guest,
  ]);
  return { uid, cookie: (await session(uid, guest)).split(";")[0] };
}
async function api(path: string, cookie: string, body?: unknown) {
  const method = body === undefined ? "GET" : "POST";
  const req = new Request(origin + "/api/" + path, {
    method,
    headers: { cookie, origin, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (method === "GET" ? GET : POST)(req, {
    params: Promise.resolve({ path: path.split("?")[0].split("/") }),
  });
}
const prompt = (extra: Record<string, unknown> = {}) => ({
  prompt: "A red observatory at dawn",
  size: "1024x1024",
  requestId: randomUUID(),
  consent: true,
  ...extra,
});
function localProvider(
  t: TestContext,
  onGenerate?: (signal: AbortSignal) => Promise<Response>,
) {
  const calls: {
    method: string;
    path: string;
    data?: Record<string, unknown>;
  }[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init),
        url = new URL(req.url);
      assert.equal(url.origin, "http://127.0.0.1:9027");
      assert.equal(req.headers.get("authorization"), null);
      const data = req.method === "POST" ? await req.json() : undefined;
      calls.push({ method: req.method, path: url.pathname, data });
      if (url.pathname === "/v1/models")
        return Response.json({ data: [{ id: "fixture:creative" }] });
      assert.equal(url.pathname, "/v1/images/generations");
      return onGenerate
        ? onGenerate(req.signal)
        : Response.json({ data: [{ b64_json: pixel }] });
    },
  );
  return calls;
}

test("image configuration only checks server-owned addresses and verifies model catalogs without generation", async (t) => {
  for (const base of [
    "http://example.test/v1",
    "http://127.0.0.1:9027/other",
    "http://token@127.0.0.1:9027/v1",
    "http://127.0.0.1:9027/v1?secret=1",
  ]) {
    process.env.LOCAL_IMAGE_BASE_URL = base;
    assert.equal(imageProviderStatus().configured, false);
  }
  process.env.LOCAL_IMAGE_BASE_URL = "http://127.0.0.1:9027/v1";
  process.env.OPENAI_API_KEY = "cloud-fixture";
  const calls = localProvider(t);
  assert.deepEqual(await probeImageProvider(), {
    provider: "local",
    model: "fixture:creative",
  });
  assert.deepEqual(
    calls.map((c) => c.method),
    ["GET"],
  );
  process.env.LOCAL_IMAGE_MODEL = "missing";
  await assert.rejects(probeImageProvider(), /unavailable/);
  assert.equal(calls.length, 2);
});

test("generation needs owner authorization, explicit consent, an enabled tool and an available provider", async (t) => {
  const a = await user(),
    guest = await user(true);
  const calls = localProvider(t);
  assert.equal(
    (await api("image/generate", guest.cookie, prompt())).status,
    403,
  );
  assert.equal(
    (await api("image/generate", a.cookie, prompt({ consent: false }))).status,
    400,
  );
  assert.equal(
    (await api("image/generate", a.cookie, prompt({ size: "arbitrary" })))
      .status,
    400,
  );
  const other = await user();
  const cid = randomUUID();
  await query("INSERT INTO conversations(id,user_id,title) VALUES($1,$2,$3)", [
    cid,
    other.uid,
    "Private",
  ]);
  assert.equal(
    (await api("image/generate", a.cookie, prompt({ conversationId: cid })))
      .status,
    404,
  );
  await query(
    "INSERT INTO connector_checks(user_id,kind,status,enabled) VALUES($1,'images','PAUSED',false)",
    [a.uid],
  );
  assert.equal((await api("image/generate", a.cookie, prompt())).status, 403);
  process.env.LOCAL_IMAGE_MODEL = "";
  assert.equal(
    (await api("image/generate", other.cookie, prompt())).status,
    503,
  );
  assert.deepEqual(calls, []);
});

test("one consented generation persists its prompt and inline assistant media, deduplicates retries, and protects downloads", async (t) => {
  const a = await user(),
    other = await user();
  const calls = localProvider(t),
    p = prompt();
  const start = await api("image/generate", a.cookie, p);
  const result = await start.json();
  assert.equal(start.status, 200, JSON.stringify(result));
  const replay = await api("image/generate", a.cookie, p);
  assert.deepEqual(await replay.json(), result);
  assert.equal(
    (await api("image/generate", a.cookie, { ...p, prompt: "different" }))
      .status,
    409,
  );
  assert.equal(calls.filter((c) => c.method === "POST").length, 1);
  assert.equal(calls[1].data?.response_format, "b64_json");
  assert.equal(calls[1].data?.n, 1);
  const turns = await (
    await api("chats/" + result.conversationId, a.cookie)
  ).json();
  assert.equal(turns.length, 2);
  assert.equal(turns[0].body, p.prompt);
  assert.equal(turns[1].image_id, result.id);
  assert.equal(turns[1].image_prompt, p.prompt);
  const list = await (await api("images", a.cookie)).json();
  assert.equal(list[0].message_id, turns[1].id);
  assert.equal(list[0].original, undefined);
  const [stored] = await query(
    "SELECT original FROM generated_images WHERE id=$1",
    [result.id],
  );
  assert.notEqual(stored.original, pixel);
  const image = await api("images/" + result.id + "?download=1", a.cookie);
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.match(image.headers.get("content-disposition") || "", /^attachment/);
  assert.match(image.headers.get("cache-control") || "", /no-store/);
  assert.equal(
    (await sharp(Buffer.from(await image.arrayBuffer())).metadata()).width,
    24,
  );
  assert.equal((await api("images/" + result.id, other.cookie)).status, 404);
  assert.deepEqual(await (await api("images", other.cookie)).json(), []);
  assert.equal(
    (await api("image/delete", other.cookie, { id: result.id })).status,
    404,
  );
  assert.equal(
    (await api("image/delete", a.cookie, { id: result.id })).status,
    200,
  );
  assert.equal((await api("images/" + result.id, a.cookie)).status, 404);
  assert.equal((await api("image/generate", a.cookie, p)).status, 410);
  const deleted = await (
    await api("chats/" + result.conversationId, a.cookie)
  ).json();
  assert.equal(deleted[1].image_id, null);
  assert.match(deleted[1].body, /deleted/);
});

test("cancel is tenant-scoped and stops in-flight provider work; daily attempt budgets survive cancellation", async (t) => {
  const a = await user(),
    other = await user();
  process.env.DAILY_IMAGE_GENERATIONS = "1";
  let started!: () => void;
  const dispatched = new Promise<void>((r) => {
    started = r;
  });
  const calls = localProvider(t, async (signal) => {
    started();
    return new Promise<Response>((_, reject) =>
      signal.addEventListener(
        "abort",
        () => reject(new Error("Fixture transport stopped")),
        { once: true },
      ),
    );
  });
  const p = prompt();
  const running = api("image/generate", a.cookie, p);
  await dispatched;
  assert.equal(
    (await api("image/cancel", other.cookie, { requestId: p.requestId }))
      .status,
    404,
  );
  assert.equal(
    (await api("image/cancel", a.cookie, { requestId: p.requestId })).status,
    200,
  );
  assert.equal((await running).status, 409);
  assert.deepEqual(await (await api("images", a.cookie)).json(), []);
  assert.equal(
    (await (await api("image/status", a.cookie)).json()).remaining,
    0,
  );
  assert.equal((await api("image/generate", a.cookie, prompt())).status, 429);
  assert.equal(calls.filter((c) => c.method === "POST").length, 1);
});

test("provider handling rejects unexpected sizes, malformed pixels and remote image URLs without fetching them", async (t) => {
  let body: unknown = {
    data: [{ url: "https://images.example.test/remote.png" }],
  };
  const calls = localProvider(t, async () => Response.json(body));
  await assert.rejects(
    generatePixels("test", "1024x1024", new AbortController().signal),
    /base64 raster/,
  );
  body = { data: [{ b64_json: Buffer.from("test").toString("base64") }] };
  await assert.rejects(
    generatePixels("test", "1024x1024", new AbortController().signal),
    /invalid raster/,
  );
  body = { data: [{ b64_json: pixel }] };
  await assert.rejects(
    generatePixels("test", "1536x1024", new AbortController().signal),
    /aspect ratio/,
  );
  assert.equal(calls.length, 3);
});

test("OpenAI transport pins its origin, credentials and generation parameters, surfacing billing limits without retries", async (t) => {
  process.env.IMAGE_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "cloud-test";
  process.env.OPENAI_IMAGE_MODEL = "fixture-gpt-image";
  let n = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const r = new Request(input, init),
        url = new URL(r.url);
      assert.equal(url.origin, "https://api.openai.com");
      assert.equal(r.headers.get("authorization"), "Bearer cloud-test");
      if (r.method === "GET") return Response.json({ id: "fixture-gpt-image" });
      n++;
      const b = await r.json();
      assert.equal(b.output_format, "png");
      assert.equal(b.quality, "medium");
      assert.equal(b.size, "1024x1536");
      assert.equal(b.response_format, undefined);
      return new Response(null, { status: 429 });
    },
  );
  await probeImageProvider();
  await assert.rejects(
    generatePixels("test", "1024x1536", new AbortController().signal),
    /billing quota/,
  );
  assert.equal(n, 1);
});

test("migration recovers old gallery items as user-isolated paired turns without re-encoding original bytes", async () => {
  const db = new PGlite();
  try {
    for (const migration of [
      "001_initial",
      "009_message_order",
      "010_media_linkedin",
    ])
      await db.exec(await readFile("migrations/" + migration + ".sql", "utf8"));
    for (const uid of ["first", "second"]) {
      await db.query("INSERT INTO users(id,name) VALUES($1,$1)", [uid]);
      await db.query(
        "INSERT INTO generated_images(id,user_id,prompt,mime,original,provider) VALUES($1,$2,$3,'image/png','untouched-record','Old provider')",
        [uid + "-image", uid, uid + " prompt"],
      );
    }
    await db.exec(
      await readFile("migrations/011_image_conversations.sql", "utf8"),
    );
    for (const uid of ["first", "second"]) {
      const { rows } = await db.query<any>(
        `SELECT m.role,m.body,m.conversation_id,i.id,i.original FROM messages m LEFT JOIN generated_images i ON i.user_id=m.user_id AND i.conversation_id=m.conversation_id AND i.message_id=m.id WHERE m.user_id=$1 ORDER BY m.seq`,
        [uid],
      );
      assert.equal(rows.length, 2);
      assert.equal(rows[0].body, uid + " prompt");
      assert.equal(rows[1].id, uid + "-image");
      assert.equal(rows[1].original, "untouched-record");
    }
  } finally {
    await db.close();
  }
});

test("competing accounts cannot exceed the shared daily image budget", async (t) => {
  const users = await Promise.all([user(), user()]);
  const [used] = await query("SELECT n FROM usage WHERE bucket=$1", [
    "image-generation:site:" + Math.floor(Date.now() / 86400000),
  ]);
  process.env.DAILY_IMAGE_SITE_LIMIT = String(Number(used?.n || 0) + 1);
  const calls = localProvider(t);
  const replies = await Promise.all(
    users.map((u) => api("image/generate", u.cookie, prompt())),
  );
  assert.deepEqual(replies.map((r) => r.status).sort(), [200, 429]);
  assert.equal(calls.filter((c) => c.method === "POST").length, 1);
});

test("OpenAI configuration defaults to the GPT Image model and local configuration accepts localhost", () => {
  process.env.IMAGE_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "cloud-fixture";
  delete process.env.OPENAI_IMAGE_MODEL;
  const cloud = imageProviderStatus();
  assert.equal(cloud.configured, true);
  assert.equal(cloud.model, "gpt-image-1");
  delete process.env.OPENAI_API_KEY;
  assert.equal(imageProviderStatus().configured, false);
  process.env.IMAGE_PROVIDER = "local";
  process.env.LOCAL_IMAGE_BASE_URL = "http://localhost:9027/v1";
  assert.equal(imageProviderStatus().configured, true);
});
