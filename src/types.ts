/**
 * Euridian — zentrale TypeScript-Typen
 *
 * Beide Backends (Ollama lokal & Infomaniak Euria) sind OpenAI-kompatibel.
 * Deshalb beschreiben diese Typen ein generisches OpenAI-Chat-Interface, das
 * für jedes weitere lokale/Cloud-Backend wiederverwendet werden kann.
 */

/** Rollen einer Chat-Nachricht (OpenAI-kompatibel). */
export type ChatRole = "system" | "user" | "assistant";

/** Ein angehängtes Bild (für multimodale Vision-Anfragen). */
export interface AttachedImage {
	/** Anzeigename (Dateiname). */
	name: string;
	/** Base64-Data-URL, z. B. "data:image/jpeg;base64,…". */
	dataUrl: string;
}

/** Eine einzelne Nachricht im Konversationsverlauf. */
export interface ChatMessage {
	role: ChatRole;
	/** Vollständiger Text-Inhalt (enthält ggf. eingebettete Text-Anhänge als XML). */
	content: string;
	/** Verkürzter Anzeigetext für die Chat-Bubble (ohne Anhang-XML). */
	displayContent?: string;
	/** Namen angehängter Dateien — werden als Chips unter der Bubble gezeigt. */
	attachedFiles?: string[];
	/** Angehängte Bilder — werden multimodal (image_url) mitgesendet. */
	images?: AttachedImage[];
}

/** Ein Textbestandteil einer multimodalen Nachricht (OpenAI-Format). */
export interface TextContentPart {
	type: "text";
	text: string;
}

/** Ein Bildbestandteil einer multimodalen Nachricht (OpenAI-Format). */
export interface ImageContentPart {
	type: "image_url";
	image_url: { url: string };
}

/** Inhaltsteil einer multimodalen Nachricht. */
export type ContentPart = TextContentPart | ImageContentPart;

/**
 * Wiederverwendbare Prompt-Vorlage (Slash-Command). Im Chat über `/name`
 * abrufbar. Platzhalter im `template`:
 *   {{input}}     → Cursor-Position für die Nutzereingabe
 *   {{selection}} → aktuell markierter Text der offenen Notiz
 *   {{note}}      → ganzer Inhalt der offenen Notiz
 *   {{title}}     → Titel (Basename) der offenen Notiz
 */
export interface PromptTemplate {
	name: string;
	description: string;
	template: string;
}

/**
 * Verfügbare Backends.
 * "ollama"     → lokaler Server, kostenlos
 * "infomaniak" → Schweizer Cloud (Euria), API-Key + Product-ID nötig
 *
 * Bewusst als String-Union, damit später weitere lokale Backends (z. B.
 * "lmstudio", "llamacpp") ohne Bruch ergänzt werden können.
 */
export type Backend = "ollama" | "infomaniak";

/**
 * Aufgelöster Endpunkt: alles, was der API-Client für genau einen Request
 * braucht — backend-unabhängig. Der ApiClient kennt nur dieses Objekt,
 * nicht die konkreten Backends.
 */
export interface ResolvedEndpoint {
	/** Vollständige URL des chat/completions-Endpunkts. */
	chatUrl: string;
	/** Vollständige URL des models-Endpunkts (für Modell-Liste / Test). */
	modelsUrl: string;
	/** HTTP-Header inkl. Authorization (falls nötig). */
	headers: Record<string, string>;
	/** Modellname, der im Request-Body mitgesendet wird. */
	model: string;
	/** Menschlich lesbarer Backend-Name für Fehlermeldungen. */
	label: string;
}

/** Ein Modell laut Infomaniak-API (`/1/ai/models`). */
export interface ApiModel {
	/** API-Name, der im Request gesendet wird (z. B. "swiss-ai/Apertus-70B…"). */
	name: string;
	/** info_status: "ready" | "coming_soon" | … */
	status: string;
	/** Beta-Modell (kann sich ändern). */
	beta: boolean;
	/** Max. Input-Token (Kontextfenster), falls bekannt. */
	maxTokenInput: number | null;
}

/** Preis eines Modells, geparst von der Tarif-Seite. */
export interface ModelPrice {
	/** Anzeigename auf der Tarif-Seite (kann ohne Vendor-Präfix sein). */
	displayName: string;
	/** Preis je 1M Input-Token. */
	inputPerM: number;
	/** Preis je 1M Output-Token. */
	outputPerM: number;
	/** Währungscode laut Seite (CHF, EUR, …). */
	currency: string;
}

/** Zusammengeführter Katalog-Eintrag: API-Modell + (optional) Preis. */
export interface CatalogEntry {
	name: string;
	status: string;
	beta: boolean;
	maxTokenInput: number | null;
	price: ModelPrice | null;
}

/** Persistente Plugin-Einstellungen (landen in data.json). */
export interface PluginSettings {
	/** Aktives Backend. */
	backend: Backend;

	// --- Ollama ---
	ollamaUrl: string;
	ollamaModel: string;
	/** Gescannte, lokal installierte Ollama-Modelle (von /v1/models). */
	ollamaModels: string[];
	/**
	 * Thinking/Reasoning für Ollama (separat von `enableThinking`, das für die
	 * Cloud gilt). Default AUS: lokale Reasoning-Modelle sind sonst oft minuten-
	 * lang am „Nachdenken".
	 */
	ollamaThinking: boolean;

	// --- Infomaniak Euria ---
	infomaniakApiKey: string;
	infomaniakProductId: string;
	infomaniakModel: string;
	/** Gecachter Modell-/Preis-Katalog (von API + Tarif-Seite). */
	infomaniakCatalog: CatalogEntry[];
	/** Zeitpunkt des letzten Katalog-Abrufs (ms seit Epoch), 0 = nie. */
	infomaniakCatalogFetchedAt: number;
	/** Nur aktuell verfügbare ("ready") Modelle im Dropdown zeigen. */
	infomaniakOnlyAvailable: boolean;

	// --- Verhalten / Kontext ---
	/** Aktuelle Notiz automatisch als System-Kontext mitsenden. */
	includeCurrentNote: boolean;
	/**
	 * Euridian-Instruktionsdatei laden (Vault-Pfad, relativ zum Vault-Root).
	 * Leer = keine Instruktionsdatei. Default: "Euria.md".
	 * Bewusst NICHT CLAUDE.md: vault-weite CLAUDE.md für andere Assistenten
	 * derailen den Agenten, da der Inhalt Tool-Calls unterdrückt.
	 */
	euridianInstructionsPath: string;
	/** Optionaler zusätzlicher System-Prompt (Persona / Stil). */
	systemPrompt: string;
	/** "Thinking"/Reasoning aktiv (false → reasoning_effort: "none"). */
	enableThinking: boolean;
	/** Sampling-Temperatur. */
	temperature: number;
	/** Max. Nachrichten im Kontextfenster (Token-Management). */
	maxContextMessages: number;
	/** Vault-Agent aktiv: Modell darf Notizen lesen/durchsuchen/schreiben. */
	enableVaultAgent: boolean;
	/** Vor Schreibaktionen (erstellen/anhängen/überschreiben) nachfragen. */
	confirmBeforeWrite: boolean;
	/** Wiederverwendbare Prompt-Vorlagen (Slash-Commands im Chat). */
	promptTemplates: PromptTemplate[];
}

/** Ein vom Modell angeforderter Tool-Aufruf (OpenAI-Format). */
export interface ToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

/**
 * Erweiterte Nachricht für die Agent-Schleife. Superset von ChatMessage:
 * unterstützt zusätzlich die Rolle "tool" sowie tool_calls/tool_call_id.
 */
export interface ApiMessage {
	role: "system" | "user" | "assistant" | "tool";
	/** String oder multimodales Array (Text + Bilder). */
	content: string | ContentPart[] | null;
	tool_calls?: ToolCall[];
	tool_call_id?: string;
}

/** Werkzeug-Definition, die dem Modell mitgeschickt wird. */
export interface ToolDefinition {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	};
}

/** Ergebnis eines Streaming-Turns: Text + ggf. angeforderte Tool-Aufrufe. */
export interface StreamResult {
	content: string;
	toolCalls: ToolCall[];
}

/**
 * Optionen für einen Streaming-Request. Der ApiClient bleibt UI-frei und
 * meldet Fortschritt ausschließlich über diese Callbacks.
 */
export interface StreamCallbacks {
	/** Pro empfangenem Text-Delta. */
	onToken: (delta: string) => void;
	/** Einmalig am Ende, falls das Backend Usage-Daten liefert. */
	onUsage?: (usage: TokenUsage) => void;
	/** Abbruch von außen (z. B. Stop-Button). */
	signal?: AbortSignal;
}

/** Token-Verbrauch laut API (Infomaniak via stream_options.include_usage). */
export interface TokenUsage {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
}

/** Ein Tool-Call-Delta im Streaming-Format (über Chunks zusammengesetzt). */
export interface StreamToolCallDelta {
	index: number;
	id?: string;
	type?: string;
	function?: { name?: string; arguments?: string };
}

/** Ein decodierter SSE-Chunk im OpenAI-Streaming-Format (Teilmenge). */
export interface StreamChunk {
	choices?: Array<{
		delta?: {
			content?: string;
			role?: ChatRole;
			tool_calls?: StreamToolCallDelta[];
		};
		finish_reason?: string | null;
	}>;
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
	} | null;
}

/** Eine persistierte Chat-Konversation (entspricht einem Tab). */
export interface ChatSession {
	id: string;
	title: string;
	messages: ChatMessage[];
}

/** Gesamter persistenter Zustand der Chat-View (alle Tabs). */
export interface SessionsState {
	tabs: ChatSession[];
	activeTabId: string;
	tabCounter: number;
}

/** Fehlerklassen für gezielte, hilfreiche Fehlermeldungen im UI. */
export type EuridianErrorKind =
	| "offline" // Backend nicht erreichbar (Ollama aus / kein Netz)
	| "auth" // 401/403 — API-Key/Product-ID falsch
	| "rate_limit" // 429
	| "bad_request" // 400 — z. B. Modell unterstützt reasoning_effort nicht
	| "not_found" // 404 — Modell/Endpunkt existiert nicht
	| "aborted" // vom Nutzer abgebrochen
	| "unknown";

/** Strukturierter Fehler, den der ApiClient wirft. */
export class EuridianError extends Error {
	kind: EuridianErrorKind;
	status?: number;

	constructor(kind: EuridianErrorKind, message: string, status?: number) {
		super(message);
		this.name = "EuridianError";
		this.kind = kind;
		this.status = status;
	}
}
