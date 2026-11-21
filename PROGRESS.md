# V4 repair pass

Static review and targeted fixes only; the environment had no network, so dependencies could not be installed and the app was not built or run. See [BUG_FIX_REPORT.md](BUG_FIX_REPORT.md).

## Completed
- OpenAI image model now defaults to `gpt-image-1` (override with `OPENAI_IMAGE_MODEL`).
- Image intent now recognises landscape, scenery, painting, drawing, cartoon, banner and avatar requests.
- Local image endpoint accepts `localhost` as well as `127.0.0.1`.
- Hindi dictation entry labelled Hindi / Hinglish.
- Regression tests added (not yet run in a full install).

## Remaining
- Run `npm ci && npm run typecheck && npm run lint && npm test && npm run build`, fix anything that appears.
- Set `OPENAI_API_KEY` (or a local image server), start the app and generate one real image to verify image generation end to end.
- Manually test dictation in English, Hindi and mixed speech on your own microphone (steps in SETUP.md).
- Start with `npm run migrate && npm run dev` and report the exact port printed.

---

# V3 recovery progress

The recovered source extends the existing application. It retains the embedded database, existing account records, encrypted provider credentials and the original command center. The delivery archive contains code and configuration examples for a clean installation.

## Completed fixes

- Fixed stale migrations across development reloads and catalog-driven dashboard rendering.
- Added reviewed voice dictation, measured audio, recovery and cleanup in Chat and Voice assistant.
- Added streamed, cancellable text inference, conversation branching, attachments, Markdown, source display and a structured image-review tool.
- Migrated generated image history, implemented secure cloud and local adapters, and tested delivery and budget limits.
- Corrected LinkedIn OAuth, destination binding, draft revisions, scheduling and receipt handling. Exposed per-service status, permission controls and health checks.
- Synchronized the Prisma client schema with the SQL migrations and added the new browser and regression suites.

## Tests executed

From the extracted project directory, use:

```sh
npm ci
npm run typecheck
npm run lint
npm test
node --test companion/tests/*.test.cjs
npm run build
```

Set CHROMIUM_PATH to your Chromium executable for the live reader unit test. With the preview running and PREVIEW_URL set to its loopback address, run:

```sh
npm run test:e2e
npm run test:recovery
npm run test:voice
npm run test:connectors
node --import tsx scripts/live-smoke.ts
```

The recovery and live smoke suites require an installed local Ollama model. The voice suite uses a virtual microphone and controlled recognition events. The live smoke suite also requires example.org on the reader allowlist. These suites create isolated local sessions and sample records. The V3 [debugging report](DEBUGGING-REPORT.md) records the results, the earlier failures, the plugin inventory and the external checks still blocked.

Final release verification passed in a fresh extraction with npm ci, type checking, lint, 58 application tests and the optimized build. Both development and production browser navigation checks completed. Three companion policy tests passed.

## Files changed or added relative to the previous delivery

- **Project root** — `.env.example`, `DEBUGGING-REPORT.md`, `FEATURE-REPORT.md`, `PROGRESS.md`, `README.md`, `SETUP.md`, `package-lock.json`, `package.json`
- **app** — `app/[page]/page.tsx`, `app/api/[...path]/route.ts`, `app/error.tsx`, `app/globals.css`
- **components** — `components/Chat.tsx`, `components/ChatDictation.tsx`, `components/ChatMessage.tsx`, `components/ChatResearch.tsx`, `components/ConnectorPanels.tsx`, `components/Dashboard.tsx`, `components/LinkedInPanel.tsx`, `components/Shell.tsx`, `components/VoiceConsole.tsx`, `components/WorkspacePanels.tsx`, `components/connectors.css`, `components/nav.ts`, `components/read-turn.ts`, `components/voice.css`
- **docs** — `docs/API.md`, `docs/CONNECTOR-AUDIT.md`, `docs/CONNECTORS.md`, `docs/IMAGES.md`
- **lib** — `lib/assistant.ts`, `lib/chat-stream.ts`, `lib/connector-health.ts`, `lib/db.ts`, `lib/engine.ts`, `lib/image-service.ts`, `lib/linkedin-workspace.ts`, `lib/local-model.ts`, `lib/media-intent.ts`, `lib/planner.ts`, `lib/providers/images.ts`, `lib/providers/linkedin.ts`, `lib/providers/models.ts`, `lib/providers/planning.ts`, `lib/providers/streaming.ts`, `lib/routing.ts`, `lib/state.ts`
- **migrations** — `migrations/011_image_conversations.sql`, `migrations/012_connector_checks.sql`, `migrations/013_chat_edits.sql`, `migrations/013_connector_fingerprint.sql`, `migrations/014_chat_workflows.sql`, `migrations/015_receipt_owner.sql`
- **prisma** — `prisma/schema.prisma`
- **scripts** — `scripts/e2e-connectors.ts`, `scripts/e2e.ts`, `scripts/recovery-e2e.ts`, `scripts/voice-e2e.ts`
- **tests** — `tests/chat-recovery.test.ts`, `tests/images.test.ts`, `tests/linkedin-manager.test.ts`
