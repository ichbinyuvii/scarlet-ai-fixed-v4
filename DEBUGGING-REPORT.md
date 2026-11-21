# S.C.A.R.L.E.T. AI V3 verification

Verified locally on 22 November 2026 with Next.js 15.5.29, React 19, PGlite, Chrome and Ollama’s installed llama3.2:latest. The [dashboard](http://127.0.0.1:4317/dashboard) is a loopback preview. Test sessions used isolated workspace identities. Production-build browser acceptance used a separate database.

## A. Bugs fixed

| Reproduced or inspected fault | Root cause and correction |
| --- | --- |
| Authenticated image history returned HTTP 500 and “The operation could not be completed.” | The development database was cached across Next reloads. Migration discovery ran only when opening the connection. The development server now discovers pending files on that same connection. The same process subsequently returned 200 for state and image history. Schema errors include a migration hint and a log reference. The unauthenticated state request still returns the expected 401 before local guest initialization. The original historical occurrence cannot be attributed uniquely from the message alone. |
| Dashboard crashed when the connector registry grew | The dashboard attempted to render an undefined icon for newly registered services. The icon registry and fallback now handle every entry and use its reported health status. |
| Voice submitted immediately | The recognizer called the command handler on a final transcript. Capture now releases before review, and the editable text waits for explicit submission. |
| Image history disappeared on reload or lost its conversation | The previous gallery loaded only after generating an image and had no message relationship. A migration links old images to their owners’ histories. The current flow stores the prompt and linked media and restores the preview on reopening a chat. |
| LinkedIn publication could fail or lack proof of delivery | The previous adapter used an incorrect endpoint and expected a JSON result. The worker uses the official Posts API, checks the authorized member and revision, and requires a 201 response with a provider post ID. |
| Chat appeared frozen during inference and duplicated error notices | Chat waited for one JSON answer. Provider deltas now reach the composer through a newline-delimited stream. The UI has a stop control, one error notice and durable results. |

## B. Voice input

**PASSED** Chrome initialized its native speech recognizer with a virtual microphone. The capture track opened at 44.1 kHz in the final run and released on stop. Browser-generated audio verified measured signal activity and silence cleanup. Controlled recognition events verified interim text, language selection, correction, explicit submission, chat draft insertion, recoverable errors, permission loss, mute, wake filtering and hidden-tab cleanup.

**BLOCKED** Physical speech accuracy in English, Hindi and code-switched speech, live remote transcription, and audible playback on the operator’s device. The app uses the browser speech provider and available synthesis voices. Follow the manual speech procedure in [SETUP.md](SETUP.md).

## C. Image generation

Chat recognizes direct visual requests. Ollama also selected the structured image-review tool for an ambiguous watercolor request. Generation requires review of aspect ratio and provider cost. OpenAI Images and a compatible loopback image backend are supported. The server checks the model, enforces account and site quotas, deduplicates requests, bounds and decodes the raster, and stores the result encrypted. The original prompt and private PNG are available in the owner’s history. Cancellation stops the local wait and propagates to the provider. A dispatched cloud request can still incur charges.

**PASSED** Eight image regression tests covered provider request formats, a fixture PNG through storage and download, authorization, migration, concurrent cost limits, cancellation and invalid responses. **BLOCKED** Generating a new image with a live model. No image-capable backend or cloud image credential was configured. The installed Llama model serves text and tools. Setup and supported response formats are in [the image guide](docs/IMAGES.md).

## D. AI chat

**PASSED** Real incremental tokens from Ollama, two-turn recall, stored history across reload, editing, regeneration, file-grounded questions, local model discovery and an actionable response after disconnecting the model. After aborting an active Ollama request following its first delta, the server recorded a cancelled assistant turn. A live structured tool plan retrieved a remembered fact and produced a downloadable report.

Chat supports Markdown with syntax highlighting, file and image attachments, conversation search, provider selection, user-controlled memory and source links for completed research. Editing and regeneration start a separate conversation with preceding text context so the original stays available. Model inference uses bounded context. Image analysis requires a vision-capable model. An earlier run of the small local model missed a follow-up fact; the final browser test verified four stored messages in the same conversation and a correct answer.

## E. LinkedIn

**PASSED** Ollama wrote a post from Chat. The draft appeared in LinkedIn history waiting for approval. Browser tests saved, edited, reloaded and previewed draft content. The server rejected an unbound publication with HTTP 409. Contract tests cover scopes, member identity, stale revisions, scheduling, tokens, confirmed and ambiguous receipts, and access from another account.

**BLOCKED** Live LinkedIn OAuth, member-scope verification, token renewal and public posting require an eligible developer application, credentials, an authorized member and approval for the exact post. No public post was made. The sender uses a single dispatch reservation to prevent a duplicate on ambiguous provider outcomes. See [connector setup](docs/CONNECTOR-AUDIT.md).

## F. Plugin status

These are the observed results in a fresh local verification workspace after explicitly testing Ollama, the reader and file analysis. Each workspace has its own permissions and last-check time.

| Plugin | Observed status | Verified action or outstanding dependency |
| --- | --- | --- |
| Model gateway | CONNECTED | Real Ollama inference. Live OpenAI, Anthropic, Gemini and other compatible cloud endpoints require credentials. |
| Ollama | CONNECTED | Catalog probe found llama3.2:latest. Chat, streaming, document answers and planning ran locally. |
| Gmail | SETUP REQUIRED | Google OAuth client and consent required for live inbox and sending. |
| Google Calendar | SETUP REQUIRED | OAuth and calendar scopes required for remote reads and approved writes. Local events remain available. |
| WhatsApp Business | SETUP REQUIRED | Needs a Meta application, signed webhook, business phone and eligible token. Webhook and policy checks ran against fixtures. |
| LinkedIn | SETUP REQUIRED | Local draft workflow passed. Live member authentication and approved delivery outstanding. |
| Brave Search | DISCONNECTED | A workspace subscription key is required for live queries and source results. |
| Browser reader | CONNECTED | Sandboxed Chromium probe passed. A queued allowlisted HTTPS job retrieved a page, produced a JPEG capture and notified the workspace. |
| File analysis | CONNECTED | Local parser probe, document upload, extraction and real grounded answer passed. Disabling and re-enabling intake was tested. |
| Image generation | SETUP REQUIRED | Provider adapters and private history tests passed. Live model configuration outstanding. |

No Google Drive adapter was found in the original project. Local file uploads and the Google Calendar/Gmail OAuth clients are separate features. The optional desktop companion is a separate application.

## G. Verification results

| Status | Check |
| --- | --- |
| PASSED | Strict TypeScript, ESLint, Prisma validation/client generation and optimized Next build. |
| PASSED | 58 application tests with Chrome enabled and 3 desktop permission-policy tests. Application tests covered auth and session rotation, cross-user access, quotas, local storage, callbacks, file parsing, audit and worker lifecycle. |
| PASSED | Chrome navigation and desktop/mobile layouts. Axe reported zero serious or critical findings on the tested dashboard, chat, voice, Integrations and LinkedIn screens. |
| PASSED | Browser recovery, voice and connector suites. Core workflows exercised actual HTTP requests and the local database. |
| PASSED | Clean extraction, lockfile install, TypeScript, lint, all 58 application tests and the optimized build. The archive passed CRC and source comparison checks. Dependencies, private stores, local environment files and machine credentials are excluded. The production dependency audit reported zero known advisories. |
| FAILED during development | Stale-schema image history, a dashboard render crash and an old test locator for a newly rendered Markdown list. Subsequent checks passed. An intermediate dev navigation test timed out during active changes; the production suite and the final stable development navigation suite both completed. |
| BLOCKED | Live credentialed providers described above, physical speech, a live image model, public OAuth callbacks and external delivery receipts. Public HTTPS/PostgreSQL/Redis deployment and native Electron UI were outside the exercised local topology. |

## H–J. Preview, archive and remaining work

Open [the local preview](http://127.0.0.1:4317/dashboard). The source archive is named `SCARLET-AI-RECOVERED-V3.zip`. Installation and reproduction commands are in [SETUP.md](SETUP.md) and [PROGRESS.md](PROGRESS.md).

To close the remaining acceptance checks, configure one image provider, authorize the desired accounts through Integrations, run a physical speech session and review a specific LinkedIn post before approving it. Local source inspection stays limited to the configured research hosts. The application has no general-purpose remote desktop or unrestricted autonomous browsing feature.
