"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  BrainCircuit,
  Clock3,
  Command,
  ImagePlus,
  MessagesSquare,
  Paperclip,
  Plus,
  Search,
  Send,
  Square,
  Trash2,
  UserRound,
} from "lucide-react";
import { api } from "./shared";
import { imageIntent } from "@/lib/media-intent";
import Sigil from "./Sigil";
import { PanelHead } from "./Dashboard";
import ChatDictation from "./ChatDictation";
import ChatMessage, { ImageResult, type Message } from "./ChatMessage";
import { readTurn } from "./read-turn";

type Conversation = { id: string; title: string };
type Generated = { id: string; prompt: string };
type ImageStatus = {
  enabled: boolean;
  configured: boolean;
  provider: string;
  reason?: string;
  remaining: number;
  costNotice: string;
  requiresAccount: boolean;
  sizes: string[];
};
const sizeLabels: Record<string, string> = {
  "1024x1024": "Square",
  "1536x1024": "Landscape",
  "1024x1536": "Portrait",
};

export default function Chat({
  data,
  act,
  refresh,
}: {
  data: any;
  act: (path: string, body: object) => Promise<any>;
  refresh: () => Promise<void>;
}) {
  const [cid, select] = useState(""),
    [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState(""),
    [search, setSearch] = useState(""),
    [found, setFound] = useState<Conversation[] | null>(null);
  const [busy, setBusy] = useState(false),
    [partial, setPartial] = useState(""),
    [error, setError] = useState("");
  const [imageMode, setImageMode] = useState(false),
    [status, setStatus] = useState<ImageStatus | null>(null),
    [size, setSize] = useState("1024x1024"),
    [gallery, setGallery] = useState<Generated[]>([]);
  const [attachment, setAttachment] = useState<{
      id: string;
      name: string;
    } | null>(null),
    [editing, setEditing] = useState<Message | null>(null);
  const [models, setModels] = useState<{
      models: string[];
      selected: string;
    } | null>(null),
    [modelBusy, setModelBusy] = useState(false);
  const bottom = useRef<HTMLDivElement>(null),
    file = useRef<HTMLInputElement>(null),
    input = useRef<HTMLInputElement>(null);
  const controller = useRef<AbortController | null>(null),
    imageRequest = useRef(""),
    manual = useRef(false),
    mounted = useRef(false);
  const connection = data.connections.find(
    (c: { kind: string }) => c.kind === "model",
  );
  useEffect(() => {
    mounted.current = true;
    const draft = sessionStorage.getItem("scarlet.image.draft");
    if (draft) {
      sessionStorage.removeItem("scarlet.image.draft");
      setText(draft);
      setImageMode(true);
    }
    let active = true;
    Promise.all([api("image/status"), api("images")])
      .then(([s, g]) => {
        if (active) {
          setStatus(s);
          setGallery(g);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!manual.current && data.conversations.length) {
      manual.current = true;
      select(data.conversations[0].id);
    }
  }, [data.conversations]);
  useEffect(() => {
    let active = true;
    if (cid)
      api("chats/" + cid)
        .then((m) => {
          if (active && !controller.current) setMessages(m);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    return () => {
      active = false;
    };
  }, [cid]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "nearest" });
  }, [messages, partial]);
  useEffect(() => {
    let active = true;
    setFound(null);
    if (!search.trim()) return;
    const t = setTimeout(
      () =>
        api("chats/search?q=" + encodeURIComponent(search.trim().slice(0, 120)))
          .then((r) => {
            if (active) setFound(r);
          })
          .catch((e) => {
            if (active) setError(e.message);
          }),
      250,
    );
    return () => {
      active = false;
      clearTimeout(t);
    };
  }, [search]);
  function reset(id = "") {
    manual.current = true;
    select(id);
    setMessages([]);
    setEditing(null);
    setAttachment(null);
    setPartial("");
    setText("");
    setImageMode(false);
    setError("");
  }
  async function stop() {
    controller.current?.abort();
    if (imageRequest.current)
      await api("image/cancel", { requestId: imageRequest.current }).catch(
        (e) => setError(e.message),
      );
  }
  async function attach(item: File) {
    setError("");
    if (item.size > 5 * 1024 * 1024) {
      setError("Choose a file up to 5 MB.");
      return;
    }
    setBusy(true);
    try {
      const r = await fetch("/api/files/upload", {
        method: "POST",
        headers: {
          "x-file-name": encodeURIComponent(item.name),
          "content-type": item.type || "application/octet-stream",
        },
        body: item,
      });
      const result = await r.json();
      if (!r.ok) throw Error(result.error || "Upload failed.");
      setAttachment({ id: result.id, name: item.name });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function send(value = text, branch = editing, generate = false) {
    const prompt = value.trim();
    if (!prompt || busy || controller.current) return;
    if (!attachment && !generate && (imageMode || imageIntent(prompt))) {
      setImageMode(true);
      setText(prompt);
      input.current?.focus();
      return;
    }
    manual.current = true;
    const op = new AbortController();
    controller.current = op;
    setBusy(true);
    setError("");
    setPartial("");
    let actualId = cid;
    const old = messages;
    const doc = attachment?.id || branch?.document_id;
    try {
      if (generate) {
        const requestId = crypto.randomUUID();
        imageRequest.current = requestId;
        const r = await fetch("/api/image/generate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            prompt,
            size,
            requestId,
            consent: true,
            conversationId: cid || undefined,
          }),
          signal: op.signal,
        });
        const result = await r.json();
        if (!r.ok) throw Error(result.error || "Image generation failed.");
        actualId = result.conversationId;
        setGallery(await api("images"));
        setImageMode(false);
      } else {
        const start = branch
          ? messages.findIndex((m) => m.id === branch.id)
          : -1;
        setMessages([
          ...(start >= 0 ? messages.slice(0, start) : messages),
          { role: "user", body: prompt },
        ]);
        await readTurn(
          {
            text: prompt,
            conversationId: cid || undefined,
            documentId: doc || undefined,
            branchFrom: branch?.id,
          },
          op.signal,
          (e) => {
            if (e.conversationId) actualId = e.conversationId;
            if (e.delta) setPartial((t) => t + e.delta);
            if (e.done) actualId = e.done.conversationId;
          },
        );
      }
      setText("");
      setEditing(null);
      setAttachment(null);
    } catch (e) {
      if (mounted.current) {
        setError(
          op.signal.aborted
            ? "Stopped. Check the saved conversation before retrying."
            : (e as Error).message,
        );
        setMessages(old);
      }
    } finally {
      controller.current = null;
      imageRequest.current = "";
      if (mounted.current) {
        try {
          if (actualId) {
            const saved = await api("chats/" + actualId);
            select(actualId);
            setMessages(saved);
          }
          if (generate) setStatus(await api("image/status"));
          await refresh();
        } catch (e) {
          setError((e as Error).message);
        }
        setPartial("");
        setBusy(false);
      }
    }
  }
  const edit = (m: Message) => {
    setEditing(m);
    setText(m.body);
    setImageMode(false);
    input.current?.focus();
  };
  return (
    <div className="chat-layout">
      <section className="panel chat-panel">
        <PanelHead
          title="Conversation"
          icon={MessagesSquare}
          right={
            <span className="tag">{connection?.label || "Local commands"}</span>
          }
        />
        <div className="chat-body" aria-label="Conversation messages">
          {!messages.length && !busy && (
            <div className="chat-empty">
              <div className="chat-mark">
                <Sigil size={43} />
              </div>
              <h2>How can I assist you?</h2>
              <p>Enter a command or start with one below.</p>
              <div className="chat-helpers">
                {[
                  [Command, "System status"],
                  [BrainCircuit, "Show my memories"],
                  [Clock3, "Remind me in 10 minutes to take a break"],
                ].map(([Icon, s]: any) => (
                  <button key={s} onClick={() => void send(s)}>
                    <Icon size={15} />
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m, i) => (
            <div key={m.id || i} className={"bubble " + m.role}>
              <span className="bubble-avatar">
                {m.role === "user" ? (
                  <UserRound size={16} />
                ) : (
                  <Sigil size={20} />
                )}
              </span>
              <div>
                <b>{m.role === "user" ? "You" : "S.C.A.R.L.E.T."}</b>
                <ChatMessage
                  m={m}
                  workflowState={
                    m.workflow_id &&
                    data.tasks.find(
                      (t: { id: string }) => t.id === m.workflow_id,
                    )?.state
                  }
                />
                {m.intent === "image-review" &&
                  messages[i - 1]?.role === "user" && (
                    <button
                      disabled={busy}
                      className="turn-action"
                      onClick={() => {
                        setText(messages[i - 1].body.slice(0, 1600));
                        setImageMode(true);
                        setAttachment(null);
                        input.current?.focus();
                      }}
                    >
                      Review image settings
                    </button>
                  )}
                {m.role === "user" &&
                  m.id &&
                  ["answer", "error", "document", "summary"].includes(
                    messages[i + 1]?.intent || "",
                  ) && (
                    <button
                      className="turn-action"
                      disabled={busy}
                      onClick={() => edit(m)}
                    >
                      Edit in new conversation
                    </button>
                  )}
                {m.role === "assistant" &&
                  ["answer", "document", "summary"].includes(m.intent || "") &&
                  messages[i - 1]?.id && (
                    <button
                      className="turn-action"
                      disabled={busy}
                      onClick={() =>
                        void send(messages[i - 1].body, messages[i - 1])
                      }
                    >
                      Regenerate in new conversation
                    </button>
                  )}
              </div>
            </div>
          ))}
          {partial && (
            <div className="bubble assistant">
              <span className="bubble-avatar">
                <Sigil size={20} />
              </span>
              <div>
                <b>S.C.A.R.L.E.T.</b>
                <p>{partial}</p>
              </div>
            </div>
          )}
          {busy && !partial && (
            <p className="waiting" role="status">
              {imageRequest.current ? "Generating image…" : "Processing…"}
            </p>
          )}
          <div ref={bottom} />
        </div>
        {error && (
          <p className="error-msg" role="alert">
            {error}
          </p>
        )}
        <div className="chat-tools">
          <ChatDictation
            onTranscript={(value) =>
              setText((old) =>
                (old.trimEnd() + " " + value).trim().slice(0, 6000),
              )
            }
            disabled={busy}
          />
          <button
            type="button"
            disabled={busy || imageMode}
            onClick={() => file.current?.click()}
          >
            <Paperclip size={14} />
            Attach file
          </button>
          <input
            ref={file}
            type="file"
            hidden
            aria-label="Attach a document or image"
            accept=".pdf,.docx,.xlsx,.txt,.md,.csv,.json,.png,.jpg,.jpeg,.webp,.ts,.tsx,.js,.py,.sql,.css,.go,.rs,.java,.c,.cpp,.sh,.yaml,.yml"
            onChange={(e) => {
              const item = e.target.files?.[0];
              if (item) void attach(item);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            disabled={busy || !!attachment}
            aria-label="Generate image"
            aria-pressed={imageMode}
            onClick={() => {
              setImageMode((v) => !v);
              setEditing(null);
            }}
          >
            <ImagePlus size={14} />
            Image
          </button>
          {connection && (
            <button
              type="button"
              disabled={busy || modelBusy}
              onClick={async () => {
                setModelBusy(true);
                try {
                  setModels(await api("models/current", {}));
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setModelBusy(false);
                }
              }}
            >
              Choose model
            </button>
          )}
          {models && (
            <select
              aria-label="Active model"
              disabled={busy || modelBusy}
              value={models.selected}
              onChange={async (e) => {
                const name = e.target.value;
                setModelBusy(true);
                try {
                  await act("models/select", { model: name });
                  setModels({ ...models, selected: name });
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setModelBusy(false);
                }
              }}
            >
              {models.models.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          )}
        </div>
        {attachment && (
          <div className="chat-notice">
            Attached · {attachment.name}{" "}
            <button disabled={busy} onClick={() => setAttachment(null)}>
              Remove
            </button>
          </div>
        )}
        {editing && (
          <div className="chat-notice">
            Editing in a new conversation{" "}
            <button
              onClick={() => {
                setEditing(null);
                setText("");
              }}
            >
              Cancel edit
            </button>
          </div>
        )}
        {imageMode && (
          <section className="image-settings">
            <h3>Generate an image</h3>
            <p>
              {status?.configured
                ? status.costNotice
                : status?.reason || "Checking image provider…"}
            </p>
            {status && !status.enabled && (
              <Link href="/integrations#images">
                Enable image generation in Integrations
              </Link>
            )}
            {status?.requiresAccount && data.user.guest && (
              <Link href="/register">Create an account to generate images</Link>
            )}
            <label>
              Aspect ratio{" "}
              <select
                disabled={busy}
                value={size}
                onChange={(e) => setSize(e.target.value)}
              >
                {(status?.sizes?.length
                  ? status.sizes
                  : Object.keys(sizeLabels)
                ).map((v) => (
                  <option key={v} value={v}>
                    {sizeLabels[v] || v} · {v}
                  </option>
                ))}
              </select>
            </label>
            {status?.configured && (
              <small>
                {status.provider} · {status.remaining} requests remaining today
              </small>
            )}
          </section>
        )}
        <form
          className="command-input"
          onSubmit={(e) => {
            e.preventDefault();
            void send(text, editing, imageMode);
          }}
        >
          <input
            ref={input}
            aria-label="Message"
            maxLength={imageMode ? 1600 : 6000}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={
              imageMode ? "Describe your image…" : "Message S.C.A.R.L.E.T.…"
            }
            disabled={busy}
          />
          {busy ? (
            <button
              type="button"
              onClick={() => void stop()}
              disabled={!controller.current}
              aria-label="Stop generation"
            >
              <Square size={16} />
            </button>
          ) : (
            <button
              type="submit"
              disabled={
                !text.trim() ||
                (imageMode &&
                  (!status?.configured ||
                    !status.enabled ||
                    status.remaining < 1 ||
                    (status.requiresAccount && data.user.guest)))
              }
              aria-label={
                imageMode ? "Confirm image generation" : "Send message"
              }
            >
              {imageMode ? <ImagePlus size={16} /> : <Send size={16} />}
            </button>
          )}
        </form>
      </section>
      <aside className="panel chat-history">
        <PanelHead
          title="History"
          icon={Clock3}
          right={
            <button
              disabled={busy}
              className="icon-btn"
              aria-label="New conversation"
              onClick={() => reset()}
            >
              <Plus size={16} />
            </button>
          }
        />
        <label className="search-label">
          <Search size={15} />
          <input
            aria-label="Search conversation history"
            placeholder="Find conversation"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        {(
          found ||
          data.conversations.filter((c: Conversation) =>
            c.title.toLowerCase().includes(search.toLowerCase()),
          )
        ).map((c: Conversation) => (
          <div className="hist-item" key={c.id}>
            <button
              disabled={busy}
              aria-current={cid === c.id}
              onClick={() => {
                if (c.id !== cid) reset(c.id);
              }}
            >
              {c.title}
            </button>
            <button
              disabled={busy}
              className="icon-btn"
              aria-label={"Delete conversation " + c.title}
              onClick={async () => {
                if (confirm("Delete this conversation and its messages?"))
                  try {
                    await act("delete", { kind: "conversation", id: c.id });
                    setFound(null);
                    if (cid === c.id) reset();
                  } catch (e) {
                    setError((e as Error).message);
                  }
              }}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        {cid && (
          <a href={"/api/report/chat/" + cid} download className="panel-link">
            Download conversation (.md)
          </a>
        )}
        {!data.conversations.length && (
          <p className="muted inset">Your conversations will appear here.</p>
        )}
        {gallery.length > 0 && (
          <details className="generated-gallery">
            <summary>Image history ({gallery.length})</summary>
            {gallery.map((item) => (
              <ImageResult key={item.id} id={item.id} prompt={item.prompt} />
            ))}
          </details>
        )}
      </aside>
    </div>
  );
}
