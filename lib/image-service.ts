import { createHash } from "node:crypto";
import { z } from "zod";
import { audit, database, id, must, Problem, query, type Row } from "./db";
import { seal, unseal } from "./security";
import { requireToolEnabled } from "./connector-health";
import {
  generatePixels,
  imageProviderStatus,
  imageSizes,
  probeImageProvider,
} from "./providers/images";

const inputs = z.object({
  prompt: z.string().trim().min(1).max(1600),
  size: z.enum(imageSizes).default("1024x1024"),
  consent: z.literal(true),
  requestId: z.string().uuid(),
  conversationId: z.string().min(1).max(160).optional(),
});
type Prompt = z.infer<typeof inputs>;
const processes = new Map<string, AbortController>();
const controllerKey = (uid: string, rid: string) => uid + "/" + rid;
const limits = (name: string, fallback: number) => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  must(
    Number.isSafeInteger(n) && n >= 0 && n <= 10000,
    "Image generation limits are misconfigured.",
    503,
  );
  return n;
};
const bucket = (uid: string) =>
  "image-generation:" + uid + ":" + Math.floor(Date.now() / 86400000);
const nextDay = () =>
  new Date((Math.floor(Date.now() / 86400000) + 1) * 86400000).toISOString();
export async function imageStatus(u: Row) {
  const config = imageProviderStatus();
  const dailyLimit = limits("DAILY_IMAGE_GENERATIONS", 3);
  const [personal, site, tool] = await Promise.all([
    query("SELECT n FROM usage WHERE bucket=$1", [bucket(u.id)]),
    query("SELECT n FROM usage WHERE bucket=$1", [bucket("site")]),
    query(
      "SELECT enabled FROM connector_checks WHERE user_id=$1 AND kind='images'",
      [u.id],
    ),
  ]);
  return {
    ...config,
    enabled: tool[0]?.enabled !== false,
    sizes: [...imageSizes],
    requiresAccount: !!u.guest,
    dailyLimit,
    remaining: Math.max(
      0,
      Math.min(
        dailyLimit - Number(personal[0]?.n || 0),
        limits("DAILY_IMAGE_SITE_LIMIT", 30) - Number(site[0]?.n || 0),
      ),
    ),
    resetAt: nextDay(),
  };
}
function output(imageId: string, conversationId: string, requestId: string) {
  return {
    id: imageId,
    url: "/api/images/" + encodeURIComponent(imageId),
    conversationId,
    requestId,
  };
}

async function reserve(uid: string, p: Prompt) {
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([p.prompt, p.size, p.conversationId ?? null]))
    .digest("hex");
  return (await database()).tx(async (q) => {
    must(
      (await q("SELECT id FROM users WHERE id=$1 FOR UPDATE", [uid])).length,
      "Account unavailable.",
      401,
    );
    const interrupted = await q(
      "UPDATE image_requests SET state='failed' WHERE user_id=$1 AND state='running' AND started<now()-interval '4 minutes' RETURNING conversation_id,request_id",
      [uid],
    );
    for (const old of interrupted) {
      await q(
        "INSERT INTO messages(id,user_id,conversation_id,role,body) VALUES($1,$2,$3,'assistant','Image generation was interrupted. Check the provider before retrying.')",
        [id(), uid, old.conversation_id],
      );
      await audit(uid, "Image request interrupted", "image", old.request_id, q);
    }
    const [previous] = await q(
      "SELECT * FROM image_requests WHERE user_id=$1 AND request_id=$2",
      [uid, p.requestId],
    );
    if (previous) {
      must(
        previous.fingerprint === fingerprint,
        "Request ID belongs to another image prompt.",
        409,
      );
      if (previous.state === "completed") {
        const [image] = await q(
          "SELECT id FROM generated_images WHERE user_id=$1 AND id=$2",
          [uid, previous.result_id],
        );
        must(image, "This generated image was deleted.", 410);
        return {
          cid: previous.conversation_id as string,
          completed: image.id as string,
        };
      }
      throw new Problem(
        409,
        "This image request is " +
          previous.state +
          ". Review its status before starting another attempt.",
      );
    }
    if (p.conversationId)
      must(
        (
          await q("SELECT id FROM conversations WHERE user_id=$1 AND id=$2", [
            uid,
            p.conversationId,
          ])
        ).length,
        "Conversation unavailable.",
        404,
      );
    const config = imageProviderStatus();
    must(
      config.configured,
      config.reason || "Image provider unavailable.",
      503,
    );
    const [busy] = await q(
      "SELECT request_id FROM image_requests WHERE user_id=$1 AND state='running' LIMIT 1",
      [uid],
    );
    must(!busy, "An image request is already in progress.", 409);
    const [storage] = await q(
      "SELECT count(*) AS n,COALESCE(sum(COALESCE(size_bytes,octet_length(original))),0) AS used FROM generated_images WHERE user_id=$1",
      [uid],
    );
    must(
      Number(storage.n) < 100 &&
        Number(storage.used) + 8 * 1024 * 1024 <= 128 * 1024 * 1024,
      "Image library limit reached. Delete an image before generating another.",
      413,
    );
    const cid = p.conversationId || id();
    if (!p.conversationId)
      await q("INSERT INTO conversations(id,user_id,title) VALUES($1,$2,$3)", [
        cid,
        uid,
        p.prompt.slice(0, 76),
      ]);
    await q(
      "INSERT INTO messages(id,user_id,conversation_id,role,body) VALUES($1,$2,$3,'user',$4)",
      [id(), uid, cid, p.prompt],
    );
    await q(
      "INSERT INTO image_requests(user_id,request_id,conversation_id,fingerprint,state) VALUES($1,$2,$3,$4,'running')",
      [uid, p.requestId, cid, fingerprint],
    );
    return { cid, completed: undefined };
  });
}

async function dispatchBudget(uid: string, rid: string) {
  await (
    await database()
  ).tx(async (q) => {
    const rows = await q(
      "UPDATE image_requests SET dispatched=now() WHERE user_id=$1 AND request_id=$2 AND state='running' AND dispatched IS NULL RETURNING request_id",
      [uid, rid],
    );
    must(rows.length, "Image generation was stopped.", 409);
    // Both counters and dispatch commit together. Failed, timed-out and cancelled provider calls are never retried automatically.
    for (const [name, limit] of [
      ["site", limits("DAILY_IMAGE_SITE_LIMIT", 30)],
      [uid, limits("DAILY_IMAGE_GENERATIONS", 3)],
    ] as const) {
      must(limit > 0, "The daily image budget is closed.", 429);
      const rows = await q(
        "INSERT INTO usage(bucket,n,expires) VALUES($1,1,$2) ON CONFLICT(bucket) DO UPDATE SET n=usage.n+1 WHERE usage.n<$3 RETURNING n",
        [bucket(name), nextDay(), limit],
      );
      must(rows.length, "The daily image budget has been reached.", 429);
    }
  });
}
async function stop(
  uid: string,
  rid: string,
  state: "cancelled" | "failed",
  message: string,
) {
  return (await database()).tx(async (q) => {
    const [row] = await q(
      "UPDATE image_requests SET state=$3 WHERE user_id=$1 AND request_id=$2 AND state='running' RETURNING conversation_id",
      [uid, rid, state],
    );
    if (!row) return false;
    await q(
      "INSERT INTO messages(id,user_id,conversation_id,role,body) VALUES($1,$2,$3,'assistant',$4)",
      [id(), uid, row.conversation_id, message],
    );
    await audit(uid, "Image generation " + state, "image", rid, q);
    return true;
  });
}
export async function cancelImage(uid: string, value: unknown) {
  const rid = z.string().uuid().parse(value);
  const changed = await stop(
    uid,
    rid,
    "cancelled",
    "Image generation stopped.",
  );
  if (!changed) {
    const [r] = await query(
      "SELECT state FROM image_requests WHERE user_id=$1 AND request_id=$2",
      [uid, rid],
    );
    must(r, "Image request unavailable.", 404);
    must(r.state === "cancelled", "Image request has already finished.", 409);
  }
  processes.get(controllerKey(uid, rid))?.abort();
  return { ok: true };
}
export async function generateImage(
  u: Row,
  value: unknown,
  clientSignal: AbortSignal,
) {
  must(!u.guest, "Create an account to generate and save images.", 403);
  const p = inputs.parse(value),
    uid = u.id as string,
    rid = p.requestId;
  await requireToolEnabled(uid, "images");
  if (clientSignal.aborted)
    throw new Problem(409, "Image generation was stopped.");
  const { cid, completed } = await reserve(uid, p);
  if (completed) return output(completed, cid, rid);
  const controller = new AbortController(),
    timer = AbortSignal.timeout(120000);
  const signal = AbortSignal.any([controller.signal, clientSignal, timer]);
  const key = controllerKey(uid, rid);
  processes.set(key, controller);
  let checking = false;
  // A cancel routed to another replica is also visible. Losing the database cancels local work.
  const interval = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      const [r] = await query(
        "SELECT state FROM image_requests WHERE user_id=$1 AND request_id=$2",
        [uid, rid],
      );
      if (r?.state !== "running") controller.abort();
    } catch {
      controller.abort();
    } finally {
      checking = false;
    }
  }, 2000);
  interval.unref();
  try {
    await probeImageProvider(signal);
    signal.throwIfAborted();
    await dispatchBudget(uid, rid);
    signal.throwIfAborted();
    const generated = await generatePixels(p.prompt, p.size, signal);
    signal.throwIfAborted();
    const iid = id(),
      messageId = id(),
      encrypted = await seal(generated.bytes.toString("base64"));
    await (
      await database()
    ).tx(async (q) => {
      signal.throwIfAborted();
      const rows = await q(
        "UPDATE image_requests SET state='completed',result_id=$3 WHERE user_id=$1 AND request_id=$2 AND state='running' RETURNING request_id",
        [uid, rid, iid],
      );
      must(rows.length, "Image generation was stopped.", 409);
      await q(
        "INSERT INTO messages(id,user_id,conversation_id,role,body) VALUES($1,$2,$3,'assistant','Generated image.')",
        [messageId, uid, cid],
      );
      await q(
        "INSERT INTO generated_images(id,user_id,conversation_id,message_id,prompt,mime,original,provider,model,size_bytes,width,height) VALUES($1,$2,$3,$4,$5,'image/png',$6,$7,$8,$9,$10,$11)",
        [
          iid,
          uid,
          cid,
          messageId,
          p.prompt,
          encrypted,
          generated.provider,
          generated.model,
          generated.bytes.length,
          generated.width,
          generated.height,
        ],
      );
      await audit(uid, "Image generated", "image", iid, q);
    });
    return output(iid, cid, rid);
  } catch (e) {
    const failed = timer.aborted
      ? new Problem(
          504,
          "Image generation timed out. Check your provider before retrying.",
        )
      : signal.aborted
        ? new Problem(409, "Image generation was stopped.")
        : e instanceof Problem
          ? e
          : new Problem(
              502,
              "Image generation failed. Check provider status before retrying.",
            );
    await stop(
      uid,
      rid,
      signal.aborted && !timer.aborted ? "cancelled" : "failed",
      failed.message,
    );
    throw failed;
  } finally {
    clearInterval(interval);
    processes.delete(key);
  }
}
export async function listImages(uid: string) {
  return query(
    "SELECT id,prompt,mime,provider,model,conversation_id,message_id,width,height,created_at FROM generated_images WHERE user_id=$1 ORDER BY created_at DESC,id LIMIT 100",
    [uid],
  );
}
export async function readImage(uid: string, iid: string, download: boolean) {
  const [image] = await query(
    "SELECT id,mime,original FROM generated_images WHERE user_id=$1 AND id=$2",
    [uid, iid],
  );
  must(image, "Image unavailable.", 404);
  const raw = Buffer.from(await unseal<string>(image.original), "base64");
  return new Response(new Uint8Array(raw), {
    headers: {
      "Content-Type": "image/png",
      "Content-Length": String(raw.length),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="scarlet-${image.id}.png"`,
    },
  });
}
export async function deleteImage(uid: string, iid: unknown) {
  const imageId = z.string().min(1).max(160).parse(iid);
  await (
    await database()
  ).tx(async (q) => {
    const [r] = await q(
      "DELETE FROM generated_images WHERE user_id=$1 AND id=$2 RETURNING conversation_id,message_id",
      [uid, imageId],
    );
    must(r, "Image unavailable.", 404);
    await q(
      "UPDATE messages SET body='Generated image deleted.' WHERE user_id=$1 AND conversation_id=$2 AND id=$3",
      [uid, r.conversation_id, r.message_id],
    );
    await audit(uid, "Generated image deleted", "image", imageId, q);
  });
  return { ok: true };
}
