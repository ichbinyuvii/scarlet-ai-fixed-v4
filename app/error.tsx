"use client";
import Link from "next/link";
export default function WorkspaceError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="loading-view">
      <h1>This view could not be loaded</h1>
      <p role="alert">Retry this view or return to the command center.</p>
      <button onClick={reset}>Retry view</button>
      <Link href="/dashboard">Open command center</Link>
    </main>
  );
}
