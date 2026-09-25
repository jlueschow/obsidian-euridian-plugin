# Euridian — Infomaniak Euria chat & vault agent for Obsidian

Chat with **Infomaniak Euria** (Swiss cloud AI, GDPR-compliant) in an Obsidian
sidebar, and optionally let the model read, search and write your notes.

> Looking for a self-hosted model (Ollama, vLLM, LM Studio, a university server)?
> Use the sibling plugin **Self-hosted LLM Vault Agent**
> ([repo](https://github.com/jlueschow/self-hosted-llm-vault-agent)). Both plugins
> share the same core; Euridian used to include those backends up to version 0.3.

## ⚠️ Vault agent — please read before enabling

The plugin can give the AI model **function-calling tools** that act on your vault:
list notes, read notes, search, create notes, append to notes, and **overwrite a
note's entire content**. This means the model can modify your files.

- **No delete tool exists at all** — not locked, simply not implemented.
- **Writes require confirmation by default** (setting *Confirm before writing*): every create/append/overwrite shows a preview modal (with a
  word diff for overwrites) before anything touches disk. You can turn this off,
  but it's not recommended.
- **Overwriting a note replaces its entire content.** Anything the model doesn't
  repeat back is lost. The modal highlights this in red when content would shrink.
- The agent can be disabled entirely (*Vault agent* setting) if you only want
  plain chat.
- Note content you ask about is sent to Infomaniak's API. See **Privacy** below.

## ✨ Features

- 💬 **Chat sidebar** with multiple tabs, persistent history, streaming responses;
  each chat keeps its own backend and model
- 🤖 **Vault agent** (function calling) — read, search, create, append and edit
  notes on request, with confirmation + diff preview before any write
- 📄 **Documents** — the agent can also read PDF, DOCX and PPTX files in your vault
- 🌐 **Optional web search** — DuckDuckGo (no account) or Brave Search API, off by default
- 📎 **Attachments** — drag & drop files/images, attach vault notes or the current
  editor selection
- ⚡ **Slash commands** — reusable prompt templates (`/summarize`, `/translate`, …)
  with placeholders `{{input}}`, `{{selection}}`, `{{note}}`, `{{title}}`
- 🔗 **@mention** — reference any vault note from the chat input
- ✏️ **Inline edit** — select text, edit it with AI, review a word diff, accept or reject
- 📝 **Custom instructions file** — a short markdown file in your vault with
  conventions for the agent (see below)

> **Language:** the interface is in English and follows Obsidian's language setting; a German translation is included. Built-in prompt templates and prompts to the model are localized the same way.

## 🤖 Using the vault agent

With **Vault agent** enabled (default) and a model that supports function calling,
just ask naturally:

> "Summarize the note 'Project X'"
> "Search my vault for notes about network routing"
> "Append today's meeting notes to my daily note"
> "What does the PDF in my attachments folder say about warranty terms?"

Each tool call appears as a chip in the chat. Extracted document text is capped
at 40k characters per file; scanned PDFs without a text layer return no text.
Not every model supports function calling reliably; very small models (≲1B
parameters) tend to hallucinate results instead of calling tools.

## 🌐 Web search (optional)

Adds a `search_web` tool. It is **off by default**, independent of the vault agent, and
always runs **locally through your own internet connection** — so it also works
when your model runs on a server without internet access. Enable it in Settings
→ *Enable web search* and pick a provider:

- **DuckDuckGo** (default, no account or key) — reads DuckDuckGo's HTML results
  page. This is unofficial, so it can break or be blocked with a bot check after
  many requests.
- **Brave Search API** — more stable, needs a free API key from
  [brave.com/search/api](https://brave.com/search/api/) (free tier available).

## 📝 Custom instructions file

Point the plugin at a short markdown file (Settings → instructions file, default
`Euria.md` in the vault root) describing your vault's structure and conventions.
Keep it short and specific: large general-purpose instruction files written for
another assistant can overwhelm smaller models so that they stop calling tools.

## 🚀 Quick start

1. Get an API key and Product ID at
   [infomaniak.com/en/hosting/ai-services](https://infomaniak.com/en/hosting/ai-services)
   (Account → AI Tools → API token).
2. Enable the plugin under **Settings → Community plugins**, open the Euridian
   settings, paste the API key and Product ID, and click **Load models and prices**.
3. Open the chat: Command palette → `Euridian: open chat`, or use the ribbon icon.

## 🔐 Privacy & network use

Euridian is desktop-only and talks to these services **only when you use it**:

| Service | Purpose | Data sent |
|---|---|---|
| `api.infomaniak.com` | Chat requests, model list | Your messages, attached files/images, and any note content you ask about or the agent reads |
| `infomaniak.com` (tariff page) | Fetch model prices for the settings screen | Nothing beyond a normal page request |
| `html.duckduckgo.com` (only if web search is enabled with DuckDuckGo) | Web search | The search queries the model issues |
| `api.search.brave.com` (only if web search is enabled with Brave) | Web search | The search queries the model issues |

No telemetry. The API key is stored in plain text in Obsidian's `data.json`
(standard Obsidian behavior). **Anything you ask about is sent to Infomaniak** —
anonymize confidential or personal data before asking, not after.

## ℹ️ Requirements and disclosures

- **Account required.** You need an Infomaniak account with the AI Tools product
  to get an API token and Product ID. Infomaniak offers a free tier; beyond that,
  usage is billed by Infomaniak according to its price list. Euridian itself is free.
- **Network use.** See the table under *Privacy & network use*. Nothing is sent
  anywhere until you send a message, load the model list, or run a web search.
- **No telemetry, no ads, no self-updates.**
- **Not affiliated.** Euridian is an independent project and is not affiliated
  with or endorsed by Infomaniak. "Infomaniak" and "Euria" are trademarks of
  their respective owners.

## 📦 Third-party software

The plugin bundles these libraries (their licenses apply):

| Library | Purpose | License |
|---|---|---|
| [pdf.js](https://github.com/mozilla/pdf.js) (`pdfjs-dist`) | Read PDF files | Apache-2.0 |
| [fflate](https://github.com/101arrowz/fflate) | Unzip DOCX and PPTX files (text is then read with the browser's XML parser) | MIT |

The bundled `main.js` is minified but not obfuscated; the full source is in this repository. pdf.js contains a one-time feature check (`new Function("")`) that the plugin does not use for anything else; the plugin itself runs no dynamically generated code.

## 🔧 Development

```bash
git clone https://github.com/jlueschow/obsidian-euridian-plugin
cd obsidian-euridian-plugin
npm install
export EURIDIAN_PLUGIN_DIR="/path/to/YourVault/.obsidian/plugins/euridian"
npm run dev      # watch, rebuild and deploy on every change
npm run build         # production build (dist/main.js)
npm run build:deploy  # production build + copy into your vault
```

`src/core` is shared with the sibling plugin and is the source of truth here;
`src/variant` holds what is specific to Euridian (Infomaniak provider, price
catalog, branding). Sibling repos sync the core with `scripts/sync-core.mjs`.

## 📄 License

MIT — see [LICENSE](LICENSE).
