# Conversation image generation

Use image mode in an authenticated conversation. The prompt is sent to the configured image service after the operator confirms one generation attempt. A completed image appears as an assistant turn, with a private PNG download. Requests need an enabled image tool in Integrations. A chat or vision model that can discuss pictures does not establish image-generation capability.

## Server configuration

Keep credentials in the backend environment. For local Next.js development, configure `.env.local`. In the supplied Compose deployment, put these variables in the web service’s `connector_env` secret and recreate the service. `127.0.0.1` inside a container refers to its own network namespace.

| Setting          | OpenAI                                                    | Existing local service                                           |
| ---------------- | --------------------------------------------------------- | ---------------------------------------------------------------- |
| `IMAGE_PROVIDER` | `openai`                                                  | `local`                                                          |
| Model            | `OPENAI_IMAGE_MODEL` set to an accessible GPT Image model | `LOCAL_IMAGE_MODEL` set to an installed image-producing model ID |
| Credentials      | `OPENAI_API_KEY` with model access and funded API billing | Optional `LOCAL_IMAGE_API_KEY`, independent of cloud credentials |
| Endpoint         | Fixed OpenAI API origin                                   | `LOCAL_IMAGE_BASE_URL`, for example `http://127.0.0.1:8080/v1`   |

The cloud adapter verifies the configured model through `GET /v1/models/:id` and submits `POST /v1/images/generations` with medium quality, PNG output and a single image. Model availability depends on the operator’s account, model access and payment setup. [OpenAI Images API](https://developers.openai.com/api/reference/resources/images/methods/generate) · [Image generation guide](https://developers.openai.com/api/docs/guides/image-generation)

The compatible service must implement `GET /v1/models` and `POST /v1/images/generations`, accept `model`, `prompt`, `size`, `n=1` and `response_format=b64_json`, and return `data[0].b64_json`. URL settings accept only numeric loopback addresses, the `/v1` path and HTTP(S). Network redirects are disabled. The server decodes a single PNG/JPEG/WebP raster, checks the requested aspect ratio and pixel limits, and re-encodes a PNG with metadata removed. Returned remote URLs, SVG, animation, oversized responses and invalid raster data are rejected. A catalog probe tests reachability and model membership without submitting an image prompt.

## Cost and cancellation

`DAILY_IMAGE_GENERATIONS` defaults to 3 dispatched attempts per account. `DAILY_IMAGE_SITE_LIMIT` defaults to 30 across the deployment. Values are integers between 0 and 10,000, and zero closes generation. Counters reset at UTC midnight. Model-availability checks require no generation budget. Once provider submission is reserved, timeouts, failures and stops count against the daily attempt budget because a provider may already have started billable work. The cloud provider determines the actual price. These counters limit request counts and cannot guarantee a currency-denominated spend limit.

Each account can run one request at a time and retain up to 100 images within 128 MiB. The server reserves room for an output up to 8 MiB. A stop marks the durable request cancelled and aborts the local fetch. A different replica observes cancellation through polling. A provider may finish its own computation after disconnection. Timeouts do not retry automatically. A previously interrupted request becomes eligible for cleanup when the next request begins after four minutes.

## HTTP interface

All endpoints require a session. Mutations require a same-origin request. Generation requires a registered account and current tool permission.

| Method and path            | Request or result                                                                                                                                                                                                                 |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/image/status`    | Provider and model configuration, permission, account requirement, supported sizes, cost notice, remaining budget and reset time. Configuration status does not imply a successful model probe.                                   |
| `POST /api/image/generate` | JSON `prompt` (1–1,600 characters), `size`, `requestId` (UUID), optional owned `conversationId`, and `consent: true`. Returns `id`, `url`, `conversationId`, `requestId`. Size choices are `1024x1024`, `1536x1024`, `1024x1536`. |
| `POST /api/image/cancel`   | JSON `requestId`. An already cancelled owned request returns success. A finished request returns 409.                                                                                                                             |
| `GET /api/chats/:id`       | An assistant image turn has `image_id` and `image_prompt`.                                                                                                                                                                        |
| `GET /api/images`          | The account’s image metadata, most recent first, up to 100 records.                                                                                                                                                               |
| `GET /api/images/:id`      | Private inline PNG. Add `?download=1` for an attachment.                                                                                                                                                                          |
| `POST /api/image/delete`   | JSON `id`. Removes the image bytes and replaces its assistant text with a deletion marker.                                                                                                                                        |

A generation request ID is bound to its prompt, requested size and original conversation target. Replaying a successful request returns its original result. An interrupted or failed request ID cannot dispatch again. Both the user prompt and the assistant image record persist transactionally at their corresponding stages. New conversations created for failed attempts remain in History with a failure message. Deleting a conversation removes its stored images. Migration `011_image_conversations.sql` links existing generated images to their original owners’ history without altering encrypted image bytes.

## Verification

Run `node --import tsx --test tests/images.test.ts` from the project directory. Tests cover old gallery migration, request authorization, explicit consent, per-user isolation, cancellation, replay and budget enforcement, provider parameters, normalization and private binary downloads. Provider transport is simulated with small PNG fixtures to avoid incurring a charge during tests. The original preview host had one configured local chat model, `llama3.2:latest`, advertising completion and tool support. No local image-producing model or OpenAI image configuration was present for live generation on that host.
