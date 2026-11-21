"use client";
import { useEffect, useState } from "react";
import { api } from "./shared";

type Report = {
  state: string;
  error?: string;
  result?: { text?: string; sources?: { url: string; title: string }[] };
};
export default function ChatResearch({
  id,
  state,
}: {
  id: string;
  state?: string;
}) {
  const [report, setReport] = useState<Report | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    api("tasks/" + encodeURIComponent(id))
      .then((result) => {
        if (active) {
          setReport(result);
          setError("");
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [id, state]);
  if (error || report?.error)
    return <p role="status">{error || report?.error}</p>;
  if (report?.state !== "COMPLETED")
    return <p role="status">{report?.state || "Loading research…"}</p>;
  return (
    <div className="chat-research">
      <p>{report.result?.text}</p>
      {report.result?.sources?.length && (
        <ol aria-label="Research sources">
          {report.result.sources.map((s, i) => (
            <li key={i}>
              <a href={s.url} target="_blank" rel="noopener noreferrer">
                {s.title || s.url}
              </a>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
