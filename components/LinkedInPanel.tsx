"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  Copy,
  FileText,
  Linkedin,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { api } from "./shared";

type Draft = {
  id: string;
  title: string;
  state: string;
  revision: string;
  payload: { text: string; author?: string; member?: string; binding?: string };
  created_at: string;
  run_at: string;
  error?: string;
  provider_id?: string;
};
type Data = {
  user?: { name?: string };
  connections?: {
    kind: string;
    label: string;
    public_meta?: { author?: string; name?: string };
  }[];
  activities?: { id: string }[];
};
type Props = {
  data: Data;
  act: (path: string, payload: unknown) => Promise<any>;
};
const format = (t: string) => new Date(t).toLocaleString();
const local = (t: string) => {
  const d = new Date(t);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
};

export default function LinkedInPanel({ data, act }: Props) {
  const [rows, setRows] = useState<Draft[]>([]),
    [selected, setSelected] = useState(""),
    [revision, setRevision] = useState("");
  const [text, setText] = useState(""),
    [topic, setTopic] = useState(""),
    [style, setStyle] = useState("Professional"),
    [when, setWhen] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const selectedOnce = useRef(false),
    locked = useRef(false);
  const target = data.connections?.find((c) => c.kind === "linkedin");
  const model = data.connections?.some((c) => c.kind === "model");
  const item = rows.find((r) => r.id === selected),
    pending = !selected || item?.state === "WAITING_FOR_APPROVAL";
  const bound =
    !!item?.payload.binding &&
    !!target?.public_meta?.author &&
    item.payload.author === target?.public_meta.author;
  const savedTime =
    item && Date.parse(item.run_at) > Date.now() ? local(item.run_at) : "";
  const dirty = item ? text !== item.payload.text || when !== savedTime : true;
  const choose = useCallback((d?: Draft) => {
    setSelected(d?.id || "");
    setRevision(d?.revision || "");
    setText(d?.payload.text || "");
    setWhen(d && Date.parse(d.run_at) > Date.now() ? local(d.run_at) : "");
    setNotice("");
    setError("");
  }, []);
  const refresh = useCallback(async () => {
    const list = (await api("linkedin/history")) as Draft[];
    setRows(list);
    if (!selectedOnce.current) {
      selectedOnce.current = true;
      const key = new URLSearchParams(window.location.search).get("draft");
      const existing = list.find((r) => r.id === key);
      if (existing) choose(existing);
    }
    return list;
  }, [choose]);
  const lastActivity = data.activities?.[0]?.id;
  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
  }, [lastActivity, refresh]);
  async function run(job: () => Promise<string | void>) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      setNotice((await job()) || "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "The operation failed.");
    } finally {
      setBusy(false);
      locked.current = false;
    }
  }
  async function save(attach = false) {
    const date = when ? new Date(when).toISOString() : null;
    const res = selected
      ? await act("linkedin/edit", {
          id: selected,
          revision,
          text,
          attach,
          runAt: date,
        })
      : await act("linkedin/draft", { text, runAt: date });
    const list = await refresh();
    choose(list.find((r) => r.id === (selected || res.id)));
    return attach
      ? "Publishing member bound. Review this revision before approving."
      : "Draft saved.";
  }
  async function generate(operation: string) {
    const r = await act("linkedin/generate", {
      topic: topic.trim() || "Improve this post.",
      text,
      style,
      operation,
    });
    setText(r.text);
    return "Generated text is ready to review and edit.";
  }
  return (
    <div className="cp-layout li-workspace">
      <section className="cp-panel">
        <div className="cp-heading">
          <h2>
            <Pencil size={18} />
            Post editor
          </h2>
          <button className="cp-btn" onClick={() => choose()}>
            <Plus size={14} />
            New draft
          </button>
        </div>
        <div className="cp-form">
          <label>
            Topic or writing instructions
            <input
              value={topic}
              maxLength={4000}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="What would you like to share?"
              disabled={busy || !pending}
            />
          </label>
          <label>
            Writing style
            <select
              value={style}
              onChange={(e) => setStyle(e.target.value)}
              disabled={busy || !pending}
            >
              {[
                "Professional",
                "Conversational",
                "Concise",
                "Technical",
                "Executive",
              ].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
          <div className="cp-buttons">
            {(["write", "rewrite", "grammar", "hashtags"] as const).map(
              (op, i) => (
                <button
                  key={op}
                  className="cp-btn"
                  disabled={
                    busy ||
                    !pending ||
                    !model ||
                    !(op === "write" ? topic.trim() : text.trim())
                  }
                  onClick={() => void run(() => generate(op))}
                >
                  {i === 0 && <Sparkles size={14} />}{" "}
                  {
                    ["Generate post", "Rewrite", "Fix grammar", "Add hashtags"][
                      i
                    ]
                  }
                </button>
              ),
            )}
          </div>
          {!model && (
            <Link href="/integrations#model">
              Connect a model for writing assistance
            </Link>
          )}
          <label>
            Post text
            <textarea
              value={text}
              rows={8}
              maxLength={3000}
              disabled={busy || !pending}
              onChange={(e) => setText(e.target.value)}
              placeholder="Write a LinkedIn post…"
            />
          </label>
          <small>{text.length.toLocaleString()} / 3,000 characters</small>
          <label>
            Publish after approval at <small>Optional · your local time</small>
            <input
              type="datetime-local"
              value={when}
              disabled={busy || !pending}
              onChange={(e) => setWhen(e.target.value)}
            />
          </label>
          <div className="cp-buttons">
            <button
              className="cp-btn cp-primary"
              disabled={busy || !pending || !text.trim()}
              onClick={() => void run(() => save())}
            >
              <Check size={15} />
              Save draft
            </button>
            <button
              className="cp-btn"
              disabled={!text.trim() || busy}
              onClick={() =>
                void run(async () => {
                  await navigator.clipboard.writeText(text);
                  return "Post copied.";
                })
              }
            >
              <Copy size={15} />
              Copy
            </button>
          </div>
        </div>
      </section>
      <section className="cp-panel">
        <div className="cp-heading">
          <h2>
            <Linkedin size={18} />
            Post preview
          </h2>
        </div>
        <div className="li-preview">
          <strong>
            {item?.payload.member ||
              target?.label ||
              data.user?.name ||
              "Member"}
          </strong>
          <small>Public · LinkedIn member post</small>
          <p>{text || "Your post preview appears here."}</p>
        </div>
        {!target ? (
          <p className="cp-help">
            Drafts are available now.{" "}
            <Link href="/integrations#linkedin">
              Connect LinkedIn to publish.
            </Link>
          </p>
        ) : (
          <p className="cp-help">Linked member · {target.label}</p>
        )}
        {selected && pending && target && !bound && (
          <button
            className="cp-btn"
            disabled={busy}
            onClick={() => void run(() => save(true))}
          >
            Bind draft to {target.label}
          </button>
        )}
        {selected && pending && bound && (
          <>
            <p className="cp-help">
              {when
                ? "Scheduled for " + format(when)
                : "Publishes when the approved job runs."}{" "}
              Save any edits before authorizing this exact revision.
            </p>
            <button
              className="cp-btn cp-primary"
              disabled={busy || dirty || revision !== item?.revision}
              onClick={() =>
                void run(async () => {
                  await act("approve", { id: selected, revision });
                  await refresh();
                  return "Publication approved. Follow the worker result below.";
                })
              }
            >
              <ShieldCheck size={15} />
              Approve public post
            </button>
          </>
        )}
        {selected &&
          item?.state === "WAITING_FOR_APPROVAL" &&
          revision !== item.revision && (
            <button className="cp-btn" onClick={() => choose(item)}>
              Reload current revision
            </button>
          )}
        {selected && item && (
          <p className="cp-help">
            Status · {item.state.replaceAll("_", " ").toLowerCase()}
          </p>
        )}
        {error && (
          <p role="alert" className="cp-feedback cp-failed">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="cp-feedback">
            {notice}
          </p>
        )}
      </section>
      <section className="cp-panel li-history">
        <div className="cp-heading">
          <h2>
            <FileText size={18} />
            Draft and publication history
          </h2>
          <button
            className="cp-icon-btn"
            aria-label="Refresh LinkedIn history"
            onClick={() =>
              void run(async () => {
                await refresh();
                return "History refreshed.";
              })
            }
          >
            <RefreshCw size={15} />
          </button>
        </div>
        {!rows.length ? (
          <p className="cp-help">
            Saved drafts and publication results appear here.
          </p>
        ) : (
          rows.map((d) => (
            <article className="li-row" key={d.id}>
              <button
                className="cp-btn"
                disabled={busy}
                onClick={() => choose(d)}
              >
                {d.payload.text.slice(0, 70) || "Draft"}
              </button>
              <small>
                {d.state.replaceAll("_", " ").toLowerCase()} ·{" "}
                {format(d.created_at)}
              </small>
              {d.error && <p role="status">{d.error}</p>}
              {d.provider_id && (
                <a
                  target="_blank"
                  rel="noreferrer"
                  href={
                    "https://www.linkedin.com/feed/update/" +
                    d.provider_id +
                    "/"
                  }
                >
                  View confirmed post on LinkedIn
                </a>
              )}
              {["QUEUED", "WAITING_FOR_APPROVAL"].includes(d.state) && (
                <button
                  className="cp-btn"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await act("cancel", { id: d.id });
                      await refresh();
                      return "Draft or scheduled publication cancelled.";
                    })
                  }
                >
                  Cancel
                </button>
              )}
            </article>
          ))
        )}
      </section>
    </div>
  );
}
