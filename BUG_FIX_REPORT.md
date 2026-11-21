# S.C.A.R.L.E.T. AI V4 bug-fix report

**Environment limits.** This pass ran in a sandbox with no network access. `npm ci` failed with `ENOTFOUND registry.npmjs.org`, so dependencies were not installed. TypeScript checking, lint, the full test suite, the production build, the dev server, browser tests and live provider calls were **NOT RUN**. Everything below is from static review plus the checks listed under "Tests executed".

## Original bugs and root causes

| # | Symptom | Root cause | Status |
|---|---|---|---|
| 1 | With only `OPENAI_API_KEY` set, image generation failed with "Configure an image-generation model on the server." (HTTP 503) | `lib/providers/images.ts` required `OPENAI_IMAGE_MODEL`, which was blank in `.env.example`, with no default. | Fixed in code, not live-tested |
| 2 | "Scarlet, create a realistic mountain landscape." was treated as ordinary text chat | `lib/media-intent.ts` only recognised a fixed noun list that lacked "landscape". | Fixed and verified by execution |
| 3 | `LOCAL_IMAGE_BASE_URL=http://localhost:PORT/v1` was rejected | Only `127.0.0.1` and `[::1]` were accepted. | Fixed in code, covered by a new test (not run) |
| 4 | No explicit Hindi-English option in the language list | The `hi-IN` entry was labelled Hindi only. | Label changed to "हिन्दी / Hinglish". The browser's `hi-IN` recogniser handles mixed speech to a degree the browser decides. Not tested with speech. |
| 5 | "The operation could not be completed. Retry connection." | This is the generic HTTP 500 body shown by `Shell.tsx` when the first state request fails. The V3 report attributes an earlier occurrence to a stale development schema. | **Not reproduced and not re-verified.** No new root cause found by reading the code. |

## Files changed

- `lib/providers/images.ts` (default model, `localhost`, clearer endpoint message)
- `lib/media-intent.ts` (more image nouns)
- `components/ChatDictation.tsx` (language label only)
- `.env.example` (comments)
- `tests/chat-recovery.test.ts`, `tests/images.test.ts` (new regression cases)
- `BUG_FIX_REPORT.md`, `PROGRESS.md`

## Tests executed

- **PASSED** `imageIntent` run directly under Node on the three required prompts (all route to image generation) and the five existing positive and four existing negative cases (no regressions).
- **PASSED** Syntax parse of the four edited TypeScript files.
- **NOT RUN** `npm ci`, `typecheck`, `lint`, `npm test`, `npm run build` (blocked: no network).
- **NOT RUN** The new `images.test.ts` case (needs `sharp` and the embedded database).
- **NOT TESTED** Dev server, dashboard, API endpoints, browser smoke tests, Ollama chat.
- **BLOCKED** Live image generation (needs a provider key or a local image server), physical microphone and speech accuracy (needs hardware).

## Reviewed and left unchanged

The image pipeline already provides server-side credentials, a provider probe, encrypted per-user storage, owner-only retrieval and download, history, daily and site budgets, cancellation and timeouts. Voice dictation already handles permission errors, silence timeout, stream cleanup and duplicate-submit protection. Chat deliberately routes image requests to a review step with a cost notice before any paid call.

## Remaining limitations

- No automatic retry of image requests: this is intentional, since a dispatched cloud request can be billed.
- Dictation holds its own microphone stream (for the waveform) while the browser recogniser opens another. Some mobile browsers may not allow both. Test on your target devices.
- Speech input needs a browser with `SpeechRecognition` (Chrome, Edge, Safari) on HTTPS or localhost. Firefox shows a typed-input fallback message.
