/**
 * Euridian — Einstellungen: Defaults + Settings-Tab-UI.
 */

import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import { EuridianApiClient } from "./api-client";
import { resolveEndpoint } from "./backend";
import { fetchCatalog } from "./model-catalog";
import {
	CatalogEntry,
	EuridianError,
	PluginSettings,
	PromptTemplate,
} from "./types";
import type EuridianPlugin from "./main";

/** Mitgelieferte Prompt-Vorlagen (Slash-Commands). Nutzer kann sie anpassen. */
export const DEFAULT_TEMPLATES: PromptTemplate[] = [
	{
		name: "zusammenfassen",
		description: "Aktuelle Notiz prägnant zusammenfassen",
		template:
			"Fasse die folgende Notiz prägnant in Stichpunkten zusammen:\n\n{{note}}",
	},
	{
		name: "übersetzen",
		description: "Text ins Englische übersetzen",
		template: "Übersetze den folgenden Text ins Englische:\n\n{{input}}",
	},
	{
		name: "verbessern",
		description: "Markierten Text stilistisch verbessern (natürliches Deutsch, keine KI-Muster)",
		template:
			"Verbessere Stil und Grammatik des folgenden Textes, ohne den Sinn zu verändern.\n" +
			"Vermeide dabei typische KI-Textmuster:\n" +
			"- Gedankenstriche sparsam einsetzen, nicht anstelle von Komma/Doppelpunkt häufen\n" +
			'- Keine Werbe-/Feiersprache ("spielt eine bedeutende Rolle", "unterstreicht die Bedeutung")\n' +
			'- Keine mechanischen Satzanfänge ("Darüber hinaus", "Zusätzlich", "Außerdem") in Folge\n' +
			'- Kein "nicht nur..., sondern auch..." als Standardfigur\n' +
			"- Schlichte Verben statt steifer Synonyme (schrieb statt verfasste, half statt leistete Unterstützung)\n" +
			"- Keine erzwungene Synonym-Rotation — Wortwiederholung ist erlaubt\n" +
			'- Fettdruck und Listen sparsam; kein Schema "**Begriff:** Erklärung"\n' +
			'- Kein "Fazit"- oder "Herausforderungen/Ausblick"-Block am Ende\n' +
			'- Keine Dialog-/Meta-Reste ("Hier ist der Text", "Ich hoffe das hilft")\n\n' +
			"Text:\n{{selection}}",
	},
	{
		name: "erklären",
		description: "Markierten Text einfach erklären",
		template:
			"Erkläre den folgenden Text einfach und verständlich:\n\n{{selection}}",
	},
	{
		name: "fortsetzen",
		description: "Notiz im gleichen Stil weiterschreiben",
		template:
			"Schreibe die folgende Notiz im gleichen Stil sinnvoll weiter:\n\n{{note}}",
	},
];

export const DEFAULT_SETTINGS: PluginSettings = {
	backend: "ollama",

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

	includeCurrentNote: true,
	euridianInstructionsPath: "Euria.md",
	systemPrompt: "",
	enableThinking: true,
	temperature: 0.7,
	maxContextMessages: 10,
	enableVaultAgent: true,
	confirmBeforeWrite: true,
	promptTemplates: DEFAULT_TEMPLATES,
};

export class EuridianSettingTab extends PluginSettingTab {
	plugin: EuridianPlugin;
	private client = new EuridianApiClient();

	constructor(app: App, plugin: EuridianPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const s = this.plugin.settings;

		// --- Backend-Auswahl ---
		new Setting(containerEl)
			.setName("Backend")
			.setDesc(
				"Lokal über Ollama (kostenlos), Infomaniak Euria (Cloud), oder ein " +
					"eigener OpenAI-kompatibler Server (z. B. im Hochschul-/Firmennetz)."
			)
			.addDropdown((dd) =>
				dd
					.addOption("ollama", "Ollama (lokal)")
					.addOption("infomaniak", "Infomaniak Euria (Cloud)")
					.addOption("custom", "Eigener Server")
					.setValue(s.backend)
					.onChange(async (value) => {
						s.backend = value as PluginSettings["backend"];
						await this.plugin.saveSettings();
						this.display(); // UI neu rendern (zeigt passende Felder)
					})
			);

		// --- Backend-spezifische Felder ---
		if (s.backend === "ollama") {
			this.renderOllamaSettings();
		} else if (s.backend === "custom") {
			this.renderCustomSettings();
		} else {
			this.renderInfomaniakSettings();
		}

		// --- Gemeinsame Verhaltens-Einstellungen ---
		containerEl.createEl("h3", { text: "Verhalten" });

		new Setting(containerEl)
			.setName("Vault-Agent")
			.setDesc(
				"Erlaubt dem Modell, Notizen zu lesen, zu durchsuchen, zu erstellen und zu ändern " +
					"(Function Calling). Löschen ist gesperrt. Modell muss Tool-Calling unterstützen."
			)
			.addToggle((t) =>
				t.setValue(s.enableVaultAgent).onChange(async (v) => {
					s.enableVaultAgent = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Bestätigung vor Schreibaktionen")
			.setDesc(
				"Fragt vor dem Erstellen, Anhängen oder Überschreiben von Notizen nach " +
					"(mit Vorschau). Lesen und Suchen bleiben ohne Rückfrage. Empfohlen, " +
					"verhindert ungefragte/halluzinierte Notizen."
			)
			.addToggle((t) =>
				t.setValue(s.confirmBeforeWrite).onChange(async (v) => {
					s.confirmBeforeWrite = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Aktuelle Notiz als Kontext")
			.setDesc(
				"Sendet den Inhalt der gerade geöffneten Notiz als System-Kontext mit."
			)
			.addToggle((t) =>
				t.setValue(s.includeCurrentNote).onChange(async (v) => {
					s.includeCurrentNote = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Euridian-Instruktionsdatei")
			.setDesc(
				"Vault-Pfad zu einer kurzen Instruktionsdatei für Euridian " +
					"(z. B. Vault-Konventionen, Ordnerstruktur). Leer lassen = keine. " +
					"Standard: Euria.md im Vault-Root. NICHT die vault-weite CLAUDE.md " +
					"eintragen — große CLAUDE.md für andere Assistenten derailen den Agenten."
			)
			.addText((t) =>
				t
					.setPlaceholder("Euria.md")
					.setValue(s.euridianInstructionsPath)
					.onChange(async (v) => {
						s.euridianInstructionsPath = v.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("System-Prompt")
			.setDesc("Optionale Persona / Stilvorgabe für die KI.")
			.addTextArea((ta) => {
				ta.setPlaceholder("Du bist ein hilfreicher Assistent …")
					.setValue(s.systemPrompt)
					.onChange(async (v) => {
						s.systemPrompt = v;
						await this.plugin.saveSettings();
					});
				ta.inputEl.rows = 3;
				ta.inputEl.addClass("euridian-settings-textarea");
			});

		new Setting(containerEl)
			.setName("Thinking / Reasoning (Infomaniak / Eigener Server)")
			.setDesc(
				'Aktiviert das "Nachdenken" des Modells für Infomaniak und eigene ' +
					"Server. Aus → schneller & günstiger (reasoning_effort: none). Für " +
					"Ollama gibt es einen eigenen Schalter im Ollama-Bereich."
			)
			.addToggle((t) =>
				t.setValue(s.enableThinking).onChange(async (v) => {
					s.enableThinking = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Temperatur")
			.setDesc("0 = deterministisch, 2 = sehr kreativ.")
			.addSlider((sl) =>
				sl
					.setLimits(0, 2, 0.1)
					.setValue(s.temperature)
					.setDynamicTooltip()
					.onChange(async (v) => {
						s.temperature = v;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Max. Kontext-Nachrichten")
			.setDesc(
				"Älteste Nachrichten werden über dieser Grenze aus dem Kontext entfernt (Token-Sparen)."
			)
			.addSlider((sl) =>
				sl
					.setLimits(2, 30, 1)
					.setValue(s.maxContextMessages)
					.setDynamicTooltip()
					.onChange(async (v) => {
						s.maxContextMessages = v;
						await this.plugin.saveSettings();
					})
			);

		this.renderPromptTemplates();
	}

	/** Verwaltung der Prompt-Vorlagen (Slash-Commands): Liste + Löschen + Anlegen. */
	private renderPromptTemplates(): void {
		const { containerEl } = this;
		const s = this.plugin.settings;

		containerEl.createEl("h3", { text: "Prompt-Vorlagen (Slash-Commands)" });
		containerEl.createEl("p", {
			cls: "setting-item-description",
			text:
				"Tippe / im Chat, um eine Vorlage einzufügen. Platzhalter: " +
				"{{input}} (Cursor für deinen Text), {{selection}} (markierter Text), " +
				"{{note}} (ganze Notiz), {{title}} (Notiztitel).",
		});

		s.promptTemplates.forEach((tpl, i) => {
			new Setting(containerEl)
				.setName(`/${tpl.name}`)
				.setDesc(tpl.description || tpl.template.slice(0, 80))
				.addExtraButton((b) =>
					b
						.setIcon("trash")
						.setTooltip("Entfernen")
						.onClick(async () => {
							// Nicht-mutierend, um die geteilte Default-Liste nicht zu verändern.
							s.promptTemplates = s.promptTemplates.filter(
								(_, idx) => idx !== i
							);
							await this.plugin.saveSettings();
							this.display();
						})
				);
		});

		// --- Neue Vorlage anlegen ---
		const draft: PromptTemplate = { name: "", description: "", template: "" };

		new Setting(containerEl)
			.setName("Neue Vorlage")
			.setDesc("Name (ohne Leerzeichen) und Kurzbeschreibung.")
			.addText((t) =>
				t.setPlaceholder("name").onChange((v) => (draft.name = v.trim()))
			)
			.addText((t) =>
				t
					.setPlaceholder("Beschreibung")
					.onChange((v) => (draft.description = v.trim()))
			);

		new Setting(containerEl)
			.setName("Prompt-Text")
			.setDesc("Mit Platzhaltern, z. B. „Übersetze: {{input}}“.")
			.addTextArea((ta) => {
				ta.setPlaceholder("Übersetze ins Englische:\n\n{{input}}").onChange(
					(v) => (draft.template = v)
				);
				ta.inputEl.rows = 3;
				ta.inputEl.addClass("euridian-settings-textarea");
			})
			.addButton((b) =>
				b
					.setButtonText("Hinzufügen")
					.setCta()
					.onClick(async () => {
						if (!draft.name || !draft.template.trim()) {
							new Notice("Name und Prompt-Text sind nötig.");
							return;
						}
						const entry: PromptTemplate = {
							name: draft.name.replace(/\s+/g, "-"),
							description: draft.description,
							template: draft.template,
						};
						s.promptTemplates = [...s.promptTemplates, entry];
						await this.plugin.saveSettings();
						this.display();
					})
			);
	}

	private renderOllamaSettings(): void {
		const { containerEl } = this;
		const s = this.plugin.settings;

		containerEl.createEl("h3", { text: "Ollama (lokal)" });

		new Setting(containerEl)
			.setName("Server-URL")
			.setDesc("Standard: http://localhost:11434")
			.addText((t) =>
				t
					.setPlaceholder("http://localhost:11434")
					.setValue(s.ollamaUrl)
					.onChange(async (v) => {
						s.ollamaUrl = v.trim();
						await this.plugin.saveSettings();
					})
			);

		this.renderOllamaModelSelector();
		this.renderOllamaScanButton();
		this.renderOllamaPreloadButton();
	}

	/** Modell-Auswahl für Ollama: Dropdown aus gescannter Liste, sonst Freitext. */
	private renderOllamaModelSelector(): void {
		const { containerEl } = this;
		const s = this.plugin.settings;
		const list = s.ollamaModels;

		if (list.length === 0) {
			new Setting(containerEl)
				.setName("Modell")
				.setDesc("Noch nicht gescannt — unten „Modelle scannen“ klicken. Oder manuell:")
				.addText((t) =>
					t
						.setPlaceholder("qwen3")
						.setValue(s.ollamaModel)
						.onChange(async (v) => {
							s.ollamaModel = v.trim();
							await this.plugin.saveSettings();
						})
				);
			return;
		}

		new Setting(containerEl)
			.setName("Modell")
			.setDesc(`${list.length} installierte(s) Modell(e) gefunden.`)
			.addDropdown((dd) => {
				for (const name of list) dd.addOption(name, name);
				// Gewähltes Modell sicher als Option, falls nicht (mehr) in der Liste.
				if (s.ollamaModel && !list.includes(s.ollamaModel)) {
					dd.addOption(s.ollamaModel, `${s.ollamaModel} (gewählt)`);
				}
				dd.setValue(s.ollamaModel).onChange(async (v) => {
					s.ollamaModel = v;
					await this.plugin.saveSettings();
				});
			});

		new Setting(this.containerEl)
			.setName("Thinking / Reasoning (Ollama)")
			.setDesc(
				"Lokale Reasoning-Modelle (z. B. qwen3.5) „denken“ sonst minutenlang " +
					"vor jeder Antwort — auch im Agenten. Standardmäßig AUS empfohlen."
			)
			.addToggle((t) =>
				t.setValue(s.ollamaThinking).onChange(async (v) => {
					s.ollamaThinking = v;
					await this.plugin.saveSettings();
				})
			);
	}

	/** Button: installierte Modelle vom Ollama-Server scannen (/v1/models). */
	private renderOllamaScanButton(): void {
		const s = this.plugin.settings;
		const desc =
			s.ollamaModels.length > 0
				? `Aktuell bekannt: ${s.ollamaModels.join(", ")}`
				: "Liest die lokal installierten Modelle vom Server.";

		new Setting(this.containerEl)
			.setName("Modelle scannen")
			.setDesc(desc)
			.addButton((btn) =>
				btn
					.setButtonText("Scannen")
					.setCta()
					.onClick(async () => {
						btn.setDisabled(true).setButtonText("Scanne …");
						try {
							// Eigener Endpunkt ohne Modell-Pflicht (resolveEndpoint würde
							// ohne gewähltes Modell werfen — beim Scannen unnötig).
							const base = (s.ollamaUrl || "http://localhost:11434").replace(
								/\/+$/,
								""
							);
							const models = await this.client.listModels({
								chatUrl: "",
								modelsUrl: `${base}/v1/models`,
								headers: {},
								model: "",
								label: "Ollama",
							});
							s.ollamaModels = models;
							// Falls gewähltes Modell nicht installiert: erstes nehmen.
							if (models.length > 0 && !models.includes(s.ollamaModel)) {
								s.ollamaModel = models[0];
							}
							await this.plugin.saveSettings();
							new Notice(
								models.length
									? `✓ ${models.length} Modell(e) gefunden.`
									: "Keine Modelle gefunden — mit „ollama pull …“ eines laden."
							);
							this.display();
						} catch (err) {
							const msg =
								err instanceof EuridianError
									? err.message
									: `Unbekannter Fehler: ${String(err)}`;
							new Notice(`✕ ${msg}`, 8000);
						} finally {
							btn.setDisabled(false).setButtonText("Scannen");
						}
					})
			);
	}

	/** Button: gewähltes Modell vorab in den Speicher laden (Preload/„warm"). */
	private renderOllamaPreloadButton(): void {
		const s = this.plugin.settings;

		new Setting(this.containerEl)
			.setName("Modell laden")
			.setDesc(
				"Lädt das gewählte Modell vorab in den Arbeitsspeicher — der erste Chat startet dann ohne Ladezeit."
			)
			.addButton((btn) =>
				btn
					.setButtonText("Laden")
					.onClick(async () => {
						if (!s.ollamaModel) {
							new Notice("Erst ein Modell wählen.");
							return;
						}
						btn.setDisabled(true).setButtonText("Lade …");
						const t0 = Date.now();
						try {
							await this.client.preloadOllama(
								s.ollamaUrl || "http://localhost:11434",
								s.ollamaModel
							);
							const secs = ((Date.now() - t0) / 1000).toFixed(1);
							new Notice(`✓ ${s.ollamaModel} geladen (${secs}s).`);
						} catch (err) {
							const msg =
								err instanceof EuridianError
									? err.message
									: `Unbekannter Fehler: ${String(err)}`;
							new Notice(`✕ ${msg}`, 8000);
						} finally {
							btn.setDisabled(false).setButtonText("Laden");
						}
					})
			);
	}

	/** Eigener OpenAI-kompatibler Server (z. B. Hochschul-/Firmennetz). */
	private renderCustomSettings(): void {
		const { containerEl } = this;
		const s = this.plugin.settings;

		containerEl.createEl("h3", { text: "Eigener Server" });
		containerEl.createEl("p", {
			cls: "setting-item-description",
			text:
				"Für jeden OpenAI-kompatiblen Endpunkt (z. B. selbst gehostet im " +
				"Hochschul-/Firmennetz). Erwartet die Standard-Routen " +
				"/v1/chat/completions und /v1/models unter der Basis-URL.",
		});

		new Setting(containerEl)
			.setName("Server-URL")
			.setDesc("Basis-URL ohne Pfad, z. B. https://llm.deine-hochschule.de")
			.addText((t) =>
				t
					.setPlaceholder("https://llm.example.org")
					.setValue(s.customUrl)
					.onChange(async (v) => {
						s.customUrl = v.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("API-Key")
			.setDesc("Nur falls der Server Authentifizierung verlangt. Sonst leer lassen.")
			.addText((t) => {
				t.setPlaceholder("Bearer-Token (optional)")
					.setValue(s.customApiKey)
					.onChange(async (v) => {
						s.customApiKey = v.trim();
						await this.plugin.saveSettings();
					});
				t.inputEl.type = "password";
			});

		this.renderCustomModelSelector();
		this.renderCustomScanButton();
		this.renderConnectionTest();
	}

	/** Modell-Auswahl für den eigenen Server: Dropdown aus gescannter Liste, sonst Freitext. */
	private renderCustomModelSelector(): void {
		const { containerEl } = this;
		const s = this.plugin.settings;
		const list = s.customModels;

		if (list.length === 0) {
			new Setting(containerEl)
				.setName("Modell")
				.setDesc("Noch nicht gescannt — unten „Modelle scannen“ klicken. Oder manuell:")
				.addText((t) =>
					t
						.setPlaceholder("Modellname")
						.setValue(s.customModel)
						.onChange(async (v) => {
							s.customModel = v.trim();
							await this.plugin.saveSettings();
						})
				);
			return;
		}

		new Setting(containerEl)
			.setName("Modell")
			.setDesc(`${list.length} Modell(e) gefunden.`)
			.addDropdown((dd) => {
				for (const name of list) dd.addOption(name, name);
				if (s.customModel && !list.includes(s.customModel)) {
					dd.addOption(s.customModel, `${s.customModel} (gewählt)`);
				}
				dd.setValue(s.customModel).onChange(async (v) => {
					s.customModel = v;
					await this.plugin.saveSettings();
				});
			});
	}

	/** Button: Modelle vom eigenen Server scannen (/v1/models). */
	private renderCustomScanButton(): void {
		const s = this.plugin.settings;
		const desc =
			s.customModels.length > 0
				? `Aktuell bekannt: ${s.customModels.join(", ")}`
				: "Liest die verfügbaren Modelle vom Server (falls unterstützt).";

		new Setting(this.containerEl)
			.setName("Modelle scannen")
			.setDesc(desc)
			.addButton((btn) =>
				btn
					.setButtonText("Scannen")
					.setCta()
					.onClick(async () => {
						if (!s.customUrl.trim()) {
							new Notice("Erst die Server-URL eintragen.");
							return;
						}
						btn.setDisabled(true).setButtonText("Scanne …");
						try {
							const base = s.customUrl.trim().replace(/\/+$/, "");
							const key = s.customApiKey.trim();
							const models = await this.client.listModels({
								chatUrl: "",
								modelsUrl: `${base}/v1/models`,
								headers: key ? { Authorization: `Bearer ${key}` } : {},
								model: "",
								label: "Eigener Server",
							});
							s.customModels = models;
							if (models.length > 0 && !models.includes(s.customModel)) {
								s.customModel = models[0];
							}
							await this.plugin.saveSettings();
							new Notice(
								models.length
									? `✓ ${models.length} Modell(e) gefunden.`
									: "Keine Modelle gefunden — Modellname manuell eintragen."
							);
							this.display();
						} catch (err) {
							const msg =
								err instanceof EuridianError
									? err.message
									: `Unbekannter Fehler: ${String(err)}`;
							new Notice(`✕ ${msg}`, 8000);
						} finally {
							btn.setDisabled(false).setButtonText("Scannen");
						}
					})
			);
	}

	private renderInfomaniakSettings(): void {
		const { containerEl } = this;
		const s = this.plugin.settings;

		containerEl.createEl("h3", { text: "Infomaniak Euria (Cloud)" });

		new Setting(containerEl)
			.setName("API-Key")
			.setDesc("kSuite → AI Tools → API-Token. Wird lokal in data.json gespeichert.")
			.addText((t) => {
				t.setPlaceholder("Bearer-Token")
					.setValue(s.infomaniakApiKey)
					.onChange(async (v) => {
						s.infomaniakApiKey = v.trim();
						await this.plugin.saveSettings();
					});
				// Key nicht im Klartext anzeigen.
				t.inputEl.type = "password";
			});

		new Setting(containerEl)
			.setName("Product-ID")
			.setDesc("Numerische ID deines AI-Tools-Produkts (GET /1/ai).")
			.addText((t) =>
				t
					.setPlaceholder("z. B. 12345")
					.setValue(s.infomaniakProductId)
					.onChange(async (v) => {
						s.infomaniakProductId = v.trim();
						await this.plugin.saveSettings();
					})
			);

		this.renderModelSelector();
		this.renderConnectionTest();
	}

	/**
	 * Modell-Auswahl für Infomaniak: Dropdown aus dem gecachten Katalog
	 * (API-Modelle + Tarif-Preise), Preiszeile darunter, Aktualisieren-Button.
	 * Fällt auf ein Freitextfeld zurück, wenn noch kein Katalog geladen ist.
	 */
	/** Ein Modell ist nutzbar, wenn die API es als "ready" meldet. */
	private isAvailable(entry: CatalogEntry): boolean {
		return entry.status === "ready";
	}

	private renderModelSelector(): void {
		const { containerEl } = this;
		const s = this.plugin.settings;
		const catalog = s.infomaniakCatalog;

		if (catalog.length === 0) {
			// Noch kein Katalog → Freitext, damit der Nutzer nicht blockiert ist.
			new Setting(containerEl)
				.setName("Modell")
				.setDesc(
					"Noch keine Modell-Liste geladen. Unten „Modelle & Preise laden“ klicken."
				)
				.addText((t) =>
					t
						.setPlaceholder("mistralai/Mistral-Small-4-119B-2603")
						.setValue(s.infomaniakModel)
						.onChange(async (v) => {
							s.infomaniakModel = v.trim();
							await this.plugin.saveSettings();
						})
				);
			this.renderRefreshButton();
			return;
		}

		const availableCount = catalog.filter((e) => this.isAvailable(e)).length;

		// Toggle: nur verfügbare Modelle zeigen.
		new Setting(containerEl)
			.setName("Nur verfügbare Modelle zeigen")
			.setDesc(
				`${availableCount} von ${catalog.length} Modellen sind aktuell nutzbar ` +
					`(„bald“ = von Infomaniak angekündigt, noch nicht freigeschaltet).`
			)
			.addToggle((t) =>
				t.setValue(s.infomaniakOnlyAvailable).onChange(async (v) => {
					s.infomaniakOnlyAvailable = v;
					await this.plugin.saveSettings();
					this.display();
				})
			);

		// Anzeigeliste: optional gefiltert, immer „verfügbar zuerst", dann nach Preis.
		const displayList = catalog
			.filter((e) => !s.infomaniakOnlyAvailable || this.isAvailable(e))
			.sort((a, b) => {
				const av = this.isAvailable(a) ? 0 : 1;
				const bv = this.isAvailable(b) ? 0 : 1;
				if (av !== bv) return av - bv;
				const ap = a.price?.outputPerM ?? Number.POSITIVE_INFINITY;
				const bp = b.price?.outputPerM ?? Number.POSITIVE_INFINITY;
				return ap - bp;
			});

		// Element für die Preiszeile (wird bei Auswahl aktualisiert).
		const priceEl = createDiv({ cls: "euridian-price-info" });

		new Setting(containerEl)
			.setName("Modell")
			.setDesc("Live aus deinem Infomaniak-Konto + Tarif-Seite.")
			.addDropdown((dd) => {
				for (const entry of displayList) {
					dd.addOption(entry.name, this.modelLabel(entry));
				}
				// Falls das gespeicherte Modell nicht in der Anzeigeliste ist
				// (gefiltert oder nicht im Katalog), trotzdem als Option anbieten.
				if (!displayList.some((e) => e.name === s.infomaniakModel)) {
					dd.addOption(s.infomaniakModel, `${s.infomaniakModel} (gewählt)`);
				}
				dd.setValue(s.infomaniakModel).onChange(async (v) => {
					s.infomaniakModel = v;
					await this.plugin.saveSettings();
					this.updatePriceLine(priceEl, v);
				});
			});

		containerEl.appendChild(priceEl);
		this.updatePriceLine(priceEl, s.infomaniakModel);

		this.renderRefreshButton();
	}

	/** Dropdown-Label inkl. Status-/Beta-Markierung. */
	private modelLabel(entry: CatalogEntry): string {
		const tags: string[] = [];
		if (entry.status !== "ready") tags.push("bald");
		if (entry.beta) tags.push("beta");
		return tags.length ? `${entry.name} · ${tags.join(", ")}` : entry.name;
	}

	/** Schreibt die Preiszeile für ein Modell in das gegebene Element. */
	private updatePriceLine(el: HTMLElement, modelName: string): void {
		el.empty();
		const entry = this.plugin.settings.infomaniakCatalog.find(
			(e) => e.name === modelName
		);

		if (!entry?.price) {
			el.createSpan({
				cls: "euridian-price-muted",
				text: "Preis nicht hinterlegt.",
			});
			return;
		}

		const p = entry.price;
		el.createSpan({
			text: `Input: ${p.currency} ${p.inputPerM.toFixed(2)} · Output: ${p.currency} ${p.outputPerM.toFixed(2)} — je 1M Token`,
		});
		if (entry.maxTokenInput) {
			el.createSpan({
				cls: "euridian-price-muted",
				text: `  ·  Kontext: ${entry.maxTokenInput.toLocaleString("de-DE")} Token`,
			});
		}
	}

	/** Button, der Modelle (API) + Preise (Tarif-Seite) neu lädt. */
	private renderRefreshButton(): void {
		const s = this.plugin.settings;
		const desc =
			s.infomaniakCatalogFetchedAt > 0
				? `Zuletzt: ${new Date(s.infomaniakCatalogFetchedAt).toLocaleString("de-DE")}`
				: "Noch nie geladen.";

		new Setting(this.containerEl)
			.setName("Modelle & Preise laden")
			.setDesc(desc)
			.addButton((btn) =>
				btn
					.setButtonText("Aktualisieren")
					.onClick(async () => {
						if (!s.infomaniakApiKey.trim()) {
							new Notice("Erst den API-Key eintragen.");
							return;
						}
						btn.setDisabled(true).setButtonText("Lade …");
						try {
							const catalog = await fetchCatalog(s.infomaniakApiKey.trim());
							s.infomaniakCatalog = catalog;
							s.infomaniakCatalogFetchedAt = Date.now();
							// Falls aktuelles Modell nicht im Katalog: erstes „ready“ wählen.
							if (!catalog.some((e) => e.name === s.infomaniakModel)) {
								const firstReady = catalog.find((e) => e.status === "ready");
								if (firstReady) s.infomaniakModel = firstReady.name;
							}
							await this.plugin.saveSettings();
							new Notice(`✓ ${catalog.length} Modell(e) geladen.`);
							this.display(); // UI mit Dropdown neu rendern
						} catch (err) {
							const msg =
								err instanceof EuridianError
									? err.message
									: `Unbekannter Fehler: ${String(err)}`;
							new Notice(`✕ ${msg}`, 8000);
						} finally {
							btn.setDisabled(false).setButtonText("Aktualisieren");
						}
					})
			);
	}

	/** Button "Verbindung testen" — ruft die Modell-Liste ab. */
	private renderConnectionTest(): void {
		new Setting(this.containerEl)
			.setName("Verbindung testen")
			.setDesc("Ruft die Modell-Liste des Backends ab.")
			.addButton((btn) =>
				btn
					.setButtonText("Testen")
					.setCta()
					.onClick(async () => {
						btn.setDisabled(true).setButtonText("Teste …");
						try {
							const endpoint = resolveEndpoint(this.plugin.settings);
							const models = await this.client.listModels(endpoint);
							new Notice(
								`✓ Verbunden mit ${endpoint.label}. ` +
									`${models.length} Modell(e) gefunden.`
							);
						} catch (err) {
							const msg =
								err instanceof EuridianError
									? err.message
									: `Unbekannter Fehler: ${String(err)}`;
							new Notice(`✕ ${msg}`, 8000);
						} finally {
							btn.setDisabled(false).setButtonText("Testen");
						}
					})
			);
	}
}
