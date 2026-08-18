# 🧠 Euridian — AI Chat & Vault Agent for Obsidian

A native Obsidian plugin that brings an AI chat sidebar — and an optional AI agent
with real read/write access to your vault — directly into Obsidian. Choose between
**free local models** (Ollama), **cloud inference** (Infomaniak Euria, Swiss/GDPR),
or **any OpenAI-compatible server you already have access to** (e.g. a
university/company-hosted LLM).

## ⚠️ Vault Agent — please read before enabling

Euridian can optionally give the AI model **function-calling tools** that act on
your vault: list notes, read notes, search, create notes, append to notes, and
**overwrite a note's entire content**. This means the model can modify your files.

- **No delete tool exists at all** — not locked, simply not implemented.
- **Writes require confirmation by default** (`confirmBeforeWrite`, on by default)
  — every create/append/overwrite shows a preview modal (with a word-diff for
  overwrites) before anything touches disk. You can turn this off, but it's not
  recommended.
- **Overwriting a note (`edit_note`) replaces its entire content.** Anything the
  model doesn't repeat back is lost. The confirmation modal highlights this in red
  when content would shrink.
- The agent can be disabled entirely (`enableVaultAgent`) if you only want plain chat.
- With a cloud backend, note content you ask about is sent to that provider's API.
  See **Privacy** below.

## ✨ Features

- 💬 **Chat sidebar** with multiple tabs, persistent history, streaming responses
- 🤖 **Vault Agent** (function calling) — read, search, create, append, and edit
  notes on request, with a confirmation + diff preview before any write
- 🏠 **Local models via Ollama** — free, runs entirely on your machine
- ☁️ **Cloud via Infomaniak Euria** — Swiss/GDPR infrastructure, live model +
  pricing catalog in Settings
- 🌐 **Any OpenAI-compatible server** — point Euridian at a URL + optional API key
  (e.g. a self-hosted or university-network LLM); auto-detects available models
- 📎 **Attachments** — drag & drop files/images from Finder, attach vault notes,
  or attach the current editor selection
- ⚡ **Slash commands** — reusable prompt templates (`/summarize`, `/translate`, …),
  fully customizable in Settings, with placeholders `{{input}}`, `{{selection}}`,
  `{{note}}`, `{{title}}`
- 🔗 **@mention** — reference any vault note directly from the chat input
- ✏️ **Inline-Edit** — select text in a note, edit it with AI, review a word-diff,
  accept or reject (Command Palette or right-click menu)
- 📝 **Custom instructions file** — point Euridian at a short markdown file with
  vault conventions (kept separate from a general-purpose `CLAUDE.md`; see below)
- 🔒 **Privacy-first defaults** — local backend by default, no delete capability,
  confirm-before-write on by default

## 🚀 Quick Start

### Option A: Local with Ollama (free, recommended)

```bash
brew install ollama
ollama pull qwen3        # or any tool-calling-capable model
ollama serve              # keep running in the background
```

Then in Obsidian: **Settings → Community Plugins → Euridian**, enable it, open the
settings tab, pick **Backend → Ollama**, click **Modelle scannen** to detect
installed models.

### Option B: Cloud via Infomaniak Euria

1. Sign up at [infomaniak.com/en/hosting/ai-services](https://infomaniak.com/en/hosting/ai-services)
   and get an API key + Product ID (Account → AI Tools → API-Token).
2. In Euridian settings: **Backend → Infomaniak**, paste API key + Product ID,
   click **Modelle & Preise laden**.

### Option C: Your own OpenAI-compatible server

Any server exposing the standard `/v1/chat/completions` and `/v1/models` routes
works — self-hosted (vLLM, LiteLLM, llama.cpp server, LM Studio, …), or one
provided by your university/company network.

1. In Euridian settings: **Backend → Eigener Server**.
2. Enter the **Server-URL** (base URL, no path — e.g. `https://llm.example.org`)
   and, if required, an **API-Key**.
3. Click **Modelle scannen** to auto-detect available models (falls back to a
   manual text field if the server doesn't expose `/v1/models`).

If the server sits behind a VPN or an internal network, make sure you're
connected before testing.

### Open the chat

Command Palette → `Euridian: Chat öffnen`, or click the ribbon icon.

## 🤖 Using the Vault Agent

With **Vault-Agent** enabled (on by default) and a tool-calling-capable model, just
ask naturally:

> "Summarize the note 'Project X'"
> "Search my vault for notes about Dante routing"
> "Append today's meeting notes to my daily note"

Each tool call shows as a chip in the chat. Write actions (create/append/edit)
pause for your confirmation with a preview — nothing is written until you approve.
When there's more than one tool call, only the latest is shown by default —
click the header above the chips to expand/collapse the full list.

The status bar shows the last response's token count and an approximate
generation speed (`~N t/s`, based on the final answer turn only — tool
execution and write-confirmation waits are excluded).

**Not every model supports function calling reliably.** Local models around 4B
parameters and above (e.g. `qwen3`, `mistral`) generally work; very small models
(≤1B) are unreliable. See **Known limitations** below for backend-specific caveats.

## 🌐 Web search (optional)

Gives the agent a `search_web` tool (via the [Brave Search API](https://brave.com/search/api/)).
**Off by default** — it's a separate opt-in toggle from the Vault Agent, and the
two can be enabled independently.

The search itself always runs **locally, through your machine's own internet
connection** — not through whichever backend answers your chat. This means it
works even if your model runs on a server with no internet access of its own
(e.g. an internal/offline network): the model asks for a search, Euridian
performs it locally, and returns the results as text.

1. Get a free API key at [brave.com/search/api](https://brave.com/search/api/)
   (free tier: 2,000 queries/month).
2. Settings → **Websuche aktivieren**, paste the key, optionally click
   **Testen** to verify.

## 📝 Custom instructions file

Point Euridian at a short markdown file (Settings → **Euridian-Instruktionsdatei**,
default `Euria.md` in the vault root) describing your vault's structure and
conventions. This is intentionally **separate** from a vault-wide `CLAUDE.md` you
might use for other AI tools: large, general-purpose instruction files (10k+
characters, written for a different assistant) can overwhelm smaller models and
cause them to stop calling tools altogether. Keep Euridian's instructions file
short and specific to what the agent needs.

## ⚙️ Configuration reference

| Setting | Default | Notes |
|---|---|---|
| Backend | Ollama | Ollama (local), Infomaniak (cloud), or Eigener Server (any OpenAI-compatible endpoint) |
| Vault-Agent | on | Enables function-calling tools |
| Bestätigung vor Schreibaktionen | on | Confirms create/append/edit with a diff preview |
| Aktuelle Notiz als Kontext | on | Sends the open note's content as context |
| Euridian-Instruktionsdatei | `Euria.md` | Optional; empty = none |
| System-Prompt | empty | Optional persona/style instructions |
| Thinking / Reasoning | on (Infomaniak/Eigener Server) / off (Ollama) | Separate toggles per backend |
| Temperatur | 0.7 | Sampling temperature |
| Max. Kontext-Nachrichten | 10 | Oldest messages are dropped beyond this |
| Prompt-Vorlagen | 5 built-in | Add/remove your own in Settings |
| Websuche aktivieren | off | Adds a `search_web` tool (Brave Search API), independent of Vault-Agent |

## 🔐 Privacy

| | Ollama (local) | Infomaniak (cloud) | Eigener Server |
|---|---|---|---|
| Data leaves your machine | No | Yes — sent to Infomaniak's API | Yes — sent to that server |
| Cost | Free | Free tier, then paid | Depends on the server/provider |
| Jurisdiction | — | Switzerland, GDPR-compliant | Whatever applies to that server |
| API key storage | — | Plain text in Obsidian's `data.json` (standard Obsidian behavior) | Same |

**Anything you ask the AI about — including via the Vault Agent — is sent to
whichever backend is active.** If you handle confidential or personal data (e.g.
research participant data), use Ollama, and anonymize content in your vault
*before* asking the AI about it, not after — a cloud request can't be undone
once sent. **"Eigener Server" carries whatever privacy/data-handling policy
that specific server operator has** — Euridian has no way to verify it, so
check with the operator (e.g. your institution's IT/data protection office)
before sending anything sensitive.

**If Web search is enabled,** whatever the model asks the `search_web` tool
for is sent to Brave's API, separately from and in addition to your chosen
chat backend — see [Brave's privacy policy](https://brave.com/privacy/search/).

## ⚠️ Known limitations

- **Not every model streams tool calls correctly.** Some cloud models return
  function calls only in non-streaming mode (Euridian detects this per-model and
  falls back automatically where known, but a new/unlisted model might not).
- **Very small local models (≲1B parameters) are unreliable at tool calling** —
  expect hallucinated results instead of real tool use.
- **Large custom instruction files can derail smaller local models,** causing
  them to stop using tools entirely — see "Custom instructions file" above.
- **Slash commands, @mention, and Inline-Edit are newer additions** and have
  seen less real-world testing than the core chat/agent flow. Please report
  issues.
- Mobile (Obsidian Mobile): falls back to a non-streaming request (no
  token-by-token output) since Node's `http`/`https` isn't available there.

## 🔧 Development

```bash
git clone https://github.com/jlueschow/obsidian-euridian-plugin
cd obsidian-euridian-plugin
npm install

export EURIDIAN_PLUGIN_DIR="/path/to/YourVault/.obsidian/plugins/euridian"
npm run dev     # watches, rebuilds, and deploys on every change
```

```bash
npm run build   # one-off production build (minified) + deploy
```

### Manual installation (without building)

1. Download `main.js`, `manifest.json`, `styles.css` from a release.
2. Create `<YourVault>/.obsidian/plugins/euridian/` and place the three files there.
3. Reload Obsidian and enable the plugin under Community Plugins.

### Project structure

```
src/
├── main.ts                 # Plugin entry point, commands, ribbon icon
├── settings.ts              # Settings UI & persisted defaults
├── chat-view.ts              # Chat sidebar (tabs, streaming, agent loop, attachments)
├── api-client.ts              # OpenAI-compatible HTTP client (Ollama + Infomaniak)
├── backend.ts                  # Endpoint resolution per backend
├── vault-tools.ts                # Vault Agent tool definitions + execution
├── web-tools.ts                   # Web search tool (Brave Search API)
├── model-catalog.ts                # Infomaniak model/pricing catalog
├── inline-edit.ts                  # Inline-Edit modal
├── confirm-write-modal.ts           # Write-confirmation modal with diff
├── diff.ts                           # Shared word-diff (LCS)
└── types.ts                           # Shared TypeScript types
```

## 🐛 Troubleshooting

**"Ollama not responding"**
```bash
curl http://localhost:11434/v1/models   # should return a model list
ollama serve                             # if not, start it
```

**Agent doesn't call tools / says it has no vault access**
- Check the model supports function calling and isn't too small (≲1B).
- Check your custom instructions file (if any) isn't huge/general-purpose — see
  "Custom instructions file" above.
- Check **Vault-Agent** is enabled in Settings.

**"Invalid API Key" (Infomaniak)**
- Verify the key and Product ID in your Infomaniak dashboard.
- Check for stray whitespace from copy-paste.

**Chat won't load / plugin doesn't appear**
- Reload Obsidian (`Cmd/Ctrl+R`), check the console (`Cmd/Ctrl+Shift+I`).
- Confirm the plugin is enabled under Community Plugins.

## 📄 License

MIT — see [LICENSE](LICENSE).
