# Integration manager and LinkedIn publishing

Open **Integrations** to see the setup requirements, workspace permissions, account, last successful check and current status for each service. Account credentials stay on the application server. A successful test records the time and scope of that check. A provider can subsequently revoke access, retire a model or reject a write.

| Service | What the test actually does | Configuration or permission |
| --- | --- | --- |
| Model gateway | Lists models at the selected provider and looks for the selected model ID | Connect an OpenAI, Anthropic, Gemini or operator-configured compatible endpoint. |
| Ollama | Discovers the selected local model through the loopback model catalog | Install Ollama and a conversational model on the allowed host. Selecting Ollama replaces the workspace's active model gateway. |
| Gmail | Reads the authorized mailbox profile | Enable Gmail and grant the requested read and send permissions. Sending still requires reviewing a specific draft. |
| Google Calendar | Lists one event on the primary calendar, requesting only the response kind | Enable Calendar and authorize access to the member's owned calendar. Creating an event requires approval. |
| WhatsApp Business | Reads the configured Meta business phone ID using its access token | Configure the signed webhook and Graph API version, then connect a business phone. |
| LinkedIn | Introspects the token and reads the bound member profile | Configure the official app and authorize the posting member. The connection test does not publish. |
| Brave Search | Submits one Web Search request | Connect a Web Search subscription key. The test counts toward its provider quota. |
| Browser reader | Starts the sandboxed browser and extracts text from a small offline document. With Redis it runs on the worker. | Configure the allowed research hosts and install worker Chromium. The test checks browser operation. Live source fetches also depend on allowed-host access. |
| File analysis | Runs a short text file through the installed file extractor | The workspace permission controls new file intake. The text check covers that format only. |
| Image generation | Checks the configured image provider's model catalog | Select an image provider supported by the deployment. The check does not create a billable image. |

**Setup required** identifies missing deployment settings. **Authorization required** identifies missing or expired member access. **Disconnected** also covers a built-in tool waiting for its first successful test. **Unavailable** and **Error** retain the provider or runtime diagnostic alongside the time of the most recent successful check. Changing the file scanner, browser settings or image provider invalidates that tool's prior test result. A workspace can disable those three tools independently. For model availability, selecting a particular modality or asking it to generate content is a separate provider call.

Gmail, Calendar and LinkedIn support an account connection and local disconnect. For Google, the application also attempts token revocation. Google Drive has no adapter in this release. File analysis uses files uploaded to the workspace. Deployment-specific setup for the other connectors is documented in [Configuring external services](CONNECTORS.md), [Image generation](IMAGES.md) and [Research](RESEARCH.md).

## Set up LinkedIn

1. In the LinkedIn developer app, enable **Sign In with LinkedIn using OpenID Connect** and **Share on LinkedIn**. Confirm that the app has access to `openid`, `profile` and `w_member_social`.
2. Register the exact callback, for example `https://scarlet.example/api/oauth/callback`. A direct loopback deployment can use `http://127.0.0.1:3000/api/oauth/callback`. The registered URL must match the actual origin used to open the workspace.
3. Set `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `LINKEDIN_REDIRECT_URI` and `LINKEDIN_API_VERSION` on the web and worker runtimes. Choose a currently supported monthly API release in `YYYYMM` form. The Compose deployment can load all four from its private connector environment file. Keep the secret out of client bundles and version control.
4. In **Integrations → LinkedIn**, connect the member account. The server consumes a one-time state bound to the initiating app session, exchanges the code and checks scopes before saving the encrypted grant. The profile returned by LinkedIn identifies the posting account. LinkedIn grants refresh tokens only to eligible applications. If renewal is unavailable or access is revoked, reconnect the account.

The member can also remove the application's permissions in the LinkedIn account settings. Disconnecting in S.C.A.R.L.E.T. removes its stored grant and invalidates pending publication approvals. Reauthorizing requires reviewing and binding the draft to the active member again. [OAuth authorization flow](https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow) · [OpenID member profile](https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2) · [Token introspection](https://learn.microsoft.com/en-us/linkedin/shared/authentication/token-introspection) · [Refresh token eligibility](https://learn.microsoft.com/en-us/linkedin/shared/authentication/programmatic-refresh-tokens)

## Write, approve and publish

Open **LinkedIn** to create, save, edit or preview a text post. An active model can draft from a topic, rewrite in the selected style, fix grammar, or suggest hashtags. Review the generated text in the editor and save it. Writing and saving a draft work before account authorization. Chat-created drafts appear in the same workspace history.

To publish, connect a member, open the saved draft, verify the displayed member and public audience, and approve that revision. You can specify a future publication time up to one year away. Editing clears the previous approval. The worker rechecks the approved revision, exact text and active grant. A reservation permits one dispatch for that approved version. On an uncertain network result, check the member's activity before submitting another post.

The worker submits a public member text post using LinkedIn's versioned Posts API at `POST /rest/posts`. It encodes reserved punctuation as literal text and standalone hashtags as LinkedIn hashtags. It records a successful publication only after HTTP 201 with a valid share or UGC post URN in the `x-restli-id` header. Open the receipt link in the history to inspect the post. History covers the 100 most recent LinkedIn tasks in the signed-in workspace. Organization posts, media uploads and analytics require separate product permissions and adapters. [LinkedIn Posts API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api) · [LinkedIn commentary format](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/little-text-format)

## Verification

- `node --import tsx --test tests/linkedin-manager.test.ts` exercises OAuth scope rejection, member binding, revision approval, tenant isolation, confirmed and ambiguous provider receipts, and duplicate dispatch prevention. It uses test responses for LinkedIn.
- `PREVIEW_URL=http://127.0.0.1:4317 node --import tsx scripts/e2e-connectors.ts` exercises the manager, tool permissions, file analysis check and LinkedIn editor in a fresh local guest workspace. Set `CHROMIUM_PATH` to an installed Chrome/Chromium executable. The browser test verifies draft edits survive a reload and that an unbound draft cannot be published. It does not submit a LinkedIn post.
- End-to-end verification of a real LinkedIn authorization and member publication requires an eligible application, LinkedIn member consent, an active worker and explicit approval of a specific post.
