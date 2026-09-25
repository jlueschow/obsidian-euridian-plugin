/**
 * Variant-spezifische Einstellungsfelder (Provider-Konfiguration) + Defaults.
 * Diese Datei gehört zur Variante, nicht zum gemeinsamen Kern.
 */

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

/** Provider-Felder von `PluginSettings` (landen in data.json). */
export interface ProviderSettings {
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

	// --- Eigener Server (z. B. selbst gehosteter LLM-Endpunkt) ---
	/** Basis-URL, z. B. "https://llm.example.org". Ohne Pfad-Suffix. */
	customUrl: string;
	/** Optionaler Bearer-Token. Leer = kein Authorization-Header. */
	customApiKey: string;
	customModel: string;
	/** Gescannte Modelle (von /v1/models), falls der Server das unterstützt. */
	customModels: string[];
}

/** Defaults der Provider-Felder (werden in `DEFAULT_SETTINGS` eingemischt). */
export const PROVIDER_DEFAULTS: ProviderSettings = {
	ollamaUrl: "http://localhost:11434",
	ollamaModel: "qwen3",
	ollamaModels: [],
	ollamaThinking: false,

	infomaniakApiKey: "",
	infomaniakProductId: "",
	infomaniakModel: "mistralai/Mistral-Small-4-119B-2603",
	infomaniakCatalog: [],
	infomaniakCatalogFetchedAt: 0,
	infomaniakOnlyAvailable: true,

	customUrl: "",
	customApiKey: "",
	customModel: "",
	customModels: [],
};
