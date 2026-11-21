"use client";
import Link from "next/link";
import Image from "next/image";
import ChatResearch from "./ChatResearch";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Download } from "lucide-react";

export type Message = {
  id?: string;
  role: string;
  body: string;
  intent?: string;
  document_id?: string;
  workflow_id?: string;
  image_id?: string;
  image_prompt?: string;
};
export function ImageResult({ id, prompt }: { id: string; prompt: string }) {
  return (
    <figure className="chat-image">
      <Image
        width={1024}
        height={1024}
        unoptimized
        loading="lazy"
        alt={prompt}
        src={"/api/images/" + encodeURIComponent(id)}
      />
      <figcaption>{prompt}</figcaption>
      <a
        href={"/api/images/" + encodeURIComponent(id) + "?download=1"}
        download
      >
        <Download size={14} /> Download PNG
      </a>
    </figure>
  );
}
export default function ChatMessage({
  m,
  workflowState,
}: {
  m: Message;
  workflowState?: string;
}) {
  return (
    <>
      {m.role === "assistant" ? (
        <div className="chat-markdown">
          <Markdown
            skipHtml
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeHighlight]}
            components={{
              img: ({ alt }) => <span>{alt}</span>,
              a: ({ href, children }) =>
                /^https?:\/\//i.test(href || "") ? (
                  <a href={href} target="_blank" rel="noopener noreferrer">
                    {children}
                  </a>
                ) : (
                  <span>{children}</span>
                ),
            }}
          >
            {m.body}
          </Markdown>
        </div>
      ) : (
        <p>{m.body}</p>
      )}
      {m.image_id && (
        <ImageResult
          id={m.image_id}
          prompt={m.image_prompt || "Generated image"}
        />
      )}
      {m.intent === "linkedin-draft" && (
        <Link className="panel-link" href="/linkedin">
          Review LinkedIn draft
        </Link>
      )}
      {m.intent === "research" && m.workflow_id && (
        <ChatResearch id={m.workflow_id} state={workflowState} />
      )}
      {["research", "browser"].includes(m.intent || "") && (
        <Link className="panel-link" href="/automations">
          View workflow and sources
        </Link>
      )}
    </>
  );
}
