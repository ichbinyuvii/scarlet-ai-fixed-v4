import assert from "node:assert/strict";
import { after, before, test, type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { id, query, database } from "../lib/db";
import { approve, tick } from "../lib/engine";
import {
  beginLinkedInOAuth,
  exchangeLinkedInCode,
  inspectLinkedInToken,
  publishLinkedIn,
  type LinkedInToken,
} from "../lib/providers/linkedin";
import {
  bindLinkedInAccount,
  createLinkedInDraft,
  disconnectLinkedIn,
  generateLinkedInText,
  linkedInHistory,
  updateLinkedInDraft,
  usableLinkedInGrant,
} from "../lib/linkedin-workspace";
import {
  healthRows,
  recordCheck,
  requireToolEnabled,
  runConnectorTest,
  toggleBuiltin,
} from "../lib/connector-health";

let folder = "";
before(async () => {
  folder = await mkdtemp(join(tmpdir(), "scarlet-linkedin-"));
  delete process.env.DATABASE_URL;
  process.env.SCARLET_DATA_DIR = folder;
  process.env.PUBLIC_DEPLOYMENT = "0";
  delete process.env.SCARLET_SKIP_MIGRATIONS;
  process.env.SCARLET_MASTER_KEY = Buffer.alloc(32, 21).toString("base64");
  Object.assign(process.env, {
    LINKEDIN_API_VERSION: "202608",
    LINKEDIN_CLIENT_ID: "fixture-client",
    LINKEDIN_CLIENT_SECRET: "fixture-private",
    LINKEDIN_REDIRECT_URI: "http://localhost:4317/api/oauth/callback",
  });
  await database();
});
after(async () => {
  if (folder) await rm(folder, { recursive: true, force: true });
});
const grant = (key = "fixture-access"): LinkedInToken => ({
  accessToken: key,
  expiresAt: Date.now() + 3600000,
  scopes: ["openid", "profile", "w_member_social"],
});
const user = async () => {
  const uid = id();
  await query("INSERT INTO users(id,name) VALUES($1,'Fixture member')", [uid]);
  return uid;
};
function mockLinkedIn(
  t: TestContext,
  options: { receipt?: string | null; scope?: string; status?: number } = {},
) {
  const posts: { body: any; headers: Headers; url: string }[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init),
        url = new URL(req.url);
      if (url.href === "https://www.linkedin.com/oauth/v2/introspectToken")
        return Response.json({
          active: true,
          client_id: "fixture-client",
          scope: options.scope ?? "openid,profile,w_member_social",
        });
      if (url.href === "https://www.linkedin.com/oauth/v2/accessToken")
        return Response.json({
          access_token: "fixture-access",
          expires_in: 3600,
          scope: options.scope ?? "openid profile w_member_social",
        });
      if (url.href === "https://api.linkedin.com/v2/userinfo") {
        const alt = req.headers.get("authorization") === "Bearer second";
        return Response.json({
          sub: alt ? "memberB" : "memberA",
          name: alt ? "Casey B" : "Morgan A",
        });
      }
      assert.equal(url.href, "https://api.linkedin.com/rest/posts");
      posts.push({
        url: req.url,
        headers: req.headers,
        body: await req.json(),
      });
      const receipt =
        options.receipt === undefined ? "urn:li:share:987654" : options.receipt;
      return new Response(null, {
        status: options.status || 201,
        headers: receipt ? { "x-restli-id": receipt } : {},
      });
    },
  );
  return posts;
}
test("LinkedIn uses member OAuth, reads real grant scope and handles insufficient permissions", async (t) => {
  const first = beginLinkedInOAuth(),
    second = beginLinkedInOAuth();
  const url = new URL(first.url);
  assert.notEqual(first.state, second.state);
  assert.equal(url.origin, "https://www.linkedin.com");
  assert.equal(url.searchParams.get("scope"), "openid profile w_member_social");
  assert.ok(!url.href.includes("fixture-private"));
  mockLinkedIn(t, { scope: "openid profile" });
  await assert.rejects(exchangeLinkedInCode("fixture-code"), /permissions/);
  await assert.rejects(inspectLinkedInToken("fixture"), /permissions/);
});
test("Save, edit, authorize and publish one exact revision to the bound member with a confirmed provider receipt", async (t) => {
  const posts = mockLinkedIn(t),
    uid = await user(),
    other = await user();
  const tid = await createLinkedInDraft(uid, "Original local draft");
  await assert.rejects(approve(uid, tid, "1"));
  await assert.rejects(
    updateLinkedInDraft(other, tid, "1", "Cross-tenant edit", false),
  );
  assert.equal((await linkedInHistory(other)).length, 0);
  await bindLinkedInAccount(uid, grant());
  const { revision } = await updateLinkedInDraft(
    uid,
    tid,
    "1",
    "Reviewed (member) post. #Project_Update\n@[A](urn:li:person:123)",
    true,
  );
  await assert.rejects(approve(uid, tid, "1"));
  assert.equal(posts.length, 0);
  await approve(uid, tid, revision);
  await tick();
  await tick();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].headers.get("content-type"), "application/json");
  assert.equal(posts[0].headers.get("linkedin-version"), "202608");
  assert.equal(posts[0].body.author, "urn:li:person:memberA");
  assert.equal(
    posts[0].body.commentary,
    "Reviewed \\(member\\) post. {hashtag|\\#|Project\\_Update}\n\\@\\[A\\]\\(urn:li:person:123\\)",
  );
  assert.equal(posts[0].body.visibility, "PUBLIC");
  const [published] = await linkedInHistory(uid);
  assert.equal(published.state, "COMPLETED");
  assert.equal(published.provider_id, "urn:li:share:987654");
});
test("Reconnection invalidates an already-approved scheduled post and never retargets it", async (t) => {
  const posts = mockLinkedIn(t),
    uid = await user();
  await bindLinkedInAccount(uid, grant());
  const tid = await createLinkedInDraft(
    uid,
    "Scheduled announcement",
    new Date(Date.now() + 120000).toISOString(),
  );
  await approve(uid, tid, "1");
  await tick();
  assert.equal(posts.length, 0);
  await bindLinkedInAccount(uid, grant("second"));
  const [changed] = await linkedInHistory(uid);
  assert.equal(changed.state, "WAITING_FOR_APPROVAL");
  assert.equal(changed.payload.binding, undefined);
  assert.notEqual(changed.revision, "1");
  await assert.rejects(approve(uid, tid, changed.revision));
  await disconnectLinkedIn(uid);
  await assert.rejects(usableLinkedInGrant(uid));
  assert.equal(posts.length, 0);
});
test("Unconfirmed LinkedIn outcomes fail visibly and are never retried automatically", async (t) => {
  const posts = mockLinkedIn(t, { receipt: null }),
    uid = await user();
  await bindLinkedInAccount(uid, grant());
  const tid = await createLinkedInDraft(uid, "Check receipt");
  await approve(uid, tid, "1");
  await tick();
  await tick();
  const [result] = await linkedInHistory(uid);
  assert.equal(result.state, "FAILED");
  assert.equal(result.provider_id, null);
  assert.match(result.error, /unconfirmed/);
  assert.equal(posts.length, 1);
});
test("A success response with the wrong status or ID cannot become a publish receipt", async (t) => {
  mockLinkedIn(t, { status: 200, receipt: "urn:li:share:123" });
  await assert.rejects(
    publishLinkedIn("fixture", "urn:li:person:memberA", "Test"),
    /unconfirmed/,
  );
});
test("Writing assistance returns editable draft text and performs no publication", async () => {
  let called = false;
  const text = await generateLinkedInText(
    "workspace",
    {
      topic: "Our release",
      text: "We launch today",
      style: "Concise",
      operation: "hashtags",
    },
    async (uid, input) => {
      called = true;
      assert.equal(uid, "workspace");
      assert.match(input[0].content, /hashtags/);
      return "We launch today. #AI";
    },
  );
  assert.ok(called);
  assert.equal(text, "We launch today. #AI");
  await assert.rejects(
    generateLinkedInText(
      "workspace",
      { topic: "Fix", operation: "grammar" },
      async () => "ignored",
    ),
    /draft text/,
  );
});
test("Connector checks persist per workspace and permission disable is effective", async () => {
  const a = await user(),
    b = await user();
  const before = await healthRows(a, []);
  assert.equal(
    before.find((x) => x.id === "linkedin")?.status,
    "AUTHORIZATION REQUIRED",
  );
  assert.equal(before.find((x) => x.id === "files")?.lastSuccess, null);
  await runConnectorTest(a, "files");
  const success = (await healthRows(a, [])).find((x) => x.id === "files");
  assert.equal(success?.status, "CONNECTED");
  assert.ok(success?.lastSuccess);
  assert.equal(
    (await healthRows(b, [])).find((x) => x.id === "files")?.status,
    "DISCONNECTED",
  );
  await toggleBuiltin(a, "files", false);
  await assert.rejects(requireToolEnabled(a, "files"), /Enable/);
  await requireToolEnabled(b, "files");
  await toggleBuiltin(a, "files", true);
  await recordCheck(a, "files", "ERROR", "Fixture check failed");
  const failed = (await healthRows(a, [])).find((x) => x.id === "files");
  assert.equal(failed?.status, "ERROR");
  assert.ok(failed?.lastSuccess);
});
