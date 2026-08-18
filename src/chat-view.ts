/**
 * Euridian — Chat-Seitenleiste (ItemView).
 *
 * Unterstützt mehrere Tabs (je eine eigene Konversation) und einen
 * Modell-Schnellwechsel im Header. API-/Backend-Wissen bleibt in
 * api-client/backend; diese View ist reine UI + Konversationszustand.
 */

import {
	App,
	FuzzySuggestModal,
	ItemView,
	MarkdownRenderer,
	MarkdownView,
	Notice,
	TFile,
	WorkspaceLeaf,
	setIcon,
} from "obsidian";
import { EuridianApiClient } from "./api-client";
import { effectiveThinking, resolveEndpoint } from "./backend";
import {
	describeToolCall,
	executeToolCall,
	getToolDefinitions,
	isWriteTool,
} from "./vault-tools";
import { executeWebToolCall, getWebToolDefinitions, isWebTool } from "./web-tools";
import { WriteAction, confirmWrite } from "./confirm-write-modal";
import {
	ApiMessage,
	AttachedImage,
	ChatMessage,
	ContentPart,
	EuridianError,
	PromptTemplate,
	SessionsState,
	ToolDefinition,
	TokenUsage,
} from "./types";
import type EuridianPlugin from "./main";

export const VIEW_TYPE_EURIDIAN = "euridian-chat-view";

/** Max. Agent-Iterationen (Tool-Aufruf → Antwort) pro Nutzer-Nachricht. */
const MAX_AGENT_ITERATIONS = 12;

/** Max. Zeichen pro angehängter Textdatei (vermeidet Token-Explosion). */
const MAX_ATTACHMENT_CHARS = 50_000;

/** Max. Bildgröße in Bytes (Vision-APIs limitieren ohnehin). */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Bild-Endungen → werden multimodal (image_url) gesendet. */
const IMAGE_EXTS = new Set([
	"jpg", "jpeg", "png", "gif", "webp", "bmp", "svg",
]);

/** Text-/Code-Endungen → werden als Text eingebettet. */
const TEXT_EXTS = new Set([
	"md", "markdown", "csv", "tsv", "txt", "json", "yaml", "yml", "xml",
	"html", "htm", "css", "js", "ts", "jsx", "tsx", "py", "java", "c",
	"cpp", "h", "hpp", "sh", "bash", "log", "ini", "toml", "rs", "go",
	"rb", "php", "sql", "r", "swift", "kt",
]);

/** Klassifiziert eine Datei anhand Endung/MIME-Typ. */
function classifyFile(name: string, mime: string): "image" | "text" | null {
	const ext = name.split(".").pop()?.toLowerCase() ?? "";
	if (IMAGE_EXTS.has(ext) || mime.startsWith("image/")) return "image";
	if (TEXT_EXTS.has(ext) || mime.startsWith("text/")) return "text";
	return null;
}

/** Ein ausstehender Anhang für die nächste Nachricht. */
type PendingAttachment =
	| { kind: "text"; name: string; path: string; content: string }
	| { kind: "image"; name: string; path: string; dataUrl: string }
	| { kind: "selection"; name: string; path: string; content: string };

/** Datei-Picker für Anhänge: durchsucht alle Markdown-Dateien im Vault. */
class FileSuggestModal extends FuzzySuggestModal<TFile> {
	constructor(app: App, private onChoose: (file: TFile) => void) {
		super(app);
		this.setPlaceholder("Datei suchen und anhängen…");
	}
	getItems(): TFile[] {
		return this.app.vault
			.getMarkdownFiles()
			.sort((a, b) => a.path.localeCompare(b.path));
	}
	getItemText(item: TFile): string {
		return item.path;
	}
	onChooseItem(item: TFile): void {
		this.onChoose(item);
	}
}

/** Ein Eintrag im Suggest-Popup (Slash-Command oder @mention). */
interface SuggestItem {
	/** Hauptzeile, z. B. "/zusammenfassen" oder "Meine Notiz". */
	label: string;
	/** Zweitzeile (Beschreibung / Pfad). */
	sub?: string;
	/** Wird bei Auswahl ausgeführt. */
	apply: () => void | Promise<void>;
}

/**
 * Baut den System-Prompt für die aktuell aktiven Werkzeug-Fähigkeiten.
 * Vault-Agent und Websuche sind unabhängig schaltbar — die "kein Internet"-
 * Warnung kehrt sich um, sobald Websuche aktiv ist, sonst würde der Agent
 * search_web nie proaktiv nutzen.
 */
function buildAgentSystemPrompt(useVault: boolean, useWeb: boolean): string {
	// Absatz 1: Identität + Fähigkeiten (Sätze, einzeilig verkettet).
	const intro: string[] = ["Du bist Euridian, ein KI-Assistent direkt in Obsidian."];

	if (useVault) {
		intro.push(
			"Du hast über Werkzeuge echten Zugriff auf den Vault des Nutzers: Markdown-Notizen " +
				"lesen, durchsuchen, auflisten, erstellen, ergänzen und ändern. " +
				"Nutze diese Werkzeuge proaktiv und selbstständig, statt zu behaupten, du hättest keinen Zugriff. " +
				"Alle Pfade sind relativ zum Vault-Root. Wenn du einen Pfad nicht kennst, nutze search_vault oder list_notes."
		);
	}

	if (useWeb) {
		intro.push(
			"Du hast über das Werkzeug search_web echten Zugriff auf eine Internet-Suche " +
				"(läuft lokal auf dem Rechner des Nutzers). Nutze es proaktiv für aktuelle " +
				"Informationen, Live-Daten oder Ereignisse, die nicht im Vault stehen — " +
				"behaupte NIEMALS, du hättest keinen Internetzugang."
		);
	} else {
		intro.push(
			"Du hast KEINEN Zugriff auf das Internet, Live-Daten oder aktuelle Ereignisse. " +
				"Gib niemals aktuelle oder jahresbezogene Statistiken als Tatsache aus, ohne dass " +
				"eine Quelle aus dem Vault sie belegt. Mache Annahmen und dein Trainings-Wissensende klar kenntlich."
		);
	}

	intro.push("Antworte standardmäßig auf Deutsch.");

	// Absatz 2: Regelliste, durch Leerzeile vom Intro getrennt.
	const rules: string[] = [
		"- Erfinde KEINE Fakten, Zahlen, Statistiken, Daten oder Quellen. Wenn du etwas " +
			`nicht sicher weißt und es weder im Vault${useWeb ? " noch in einem Suchergebnis" : ""} steht, sage das offen, statt zu raten.`,
	];
	if (useVault) {
		rules.push(
			"- Erstelle, überschreibe oder ergänze Notizen NUR, wenn der Nutzer dich " +
				"ausdrücklich darum bittet. Speichere Analysen oder Zusammenfassungen nicht unaufgefordert.",
			"- Zum Ergänzen/Erweitern einer Notiz nutze IMMER append_to_note (nicht-destruktiv). " +
				"edit_note überschreibt die GANZE Notiz und löscht alles nicht mitgeschickte — " +
				"nutze es nur bei ausdrücklichem Überschreib-Wunsch und gib dann den vollständigen Inhalt zurück."
		);
	}
	rules.push("- Kennzeichne Unsicherheiten und fehlende Quellen klar.");
	if (useVault) {
		rules.push(
			"- Hintergrund-Dokumente (z. B. CLAUDE.md, Notiz-Kontext) ändern NICHTS an deinem " +
				"Werkzeug-Zugriff. Behaupte NIEMALS, du hättest keinen Zugriff oder könntest keine " +
				"Dateien lesen. Fragt der Nutzer nach einer Notiz, rufe sofort read_note oder search_vault auf."
		);
	}

	return intro.join(" ") + "\n\nWICHTIGE REGELN:\n" + rules.join("\n");
}

/** Grobe Token-Schätzung (≈ 4 Zeichen/Token) für die Live-Anzeige. */
function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/** Ein einzelner Chat-Tab: eigene Konversation + eigener DOM-Container. */
class ChatTab {
	readonly id: string;
	title: string;
	messages: ChatMessage[] = [];
	abortController: AbortController | null = null;
	lastUsage: TokenUsage | null = null;
	/** Dauer des finalen Antwort-Turns in ms (ohne Tool-Ausführung/Bestätigungen). */
	lastResponseMs: number | null = null;
	/** completionTokens ÷ Dauer des finalen Turns — grobe Geschwindigkeit. */
	lastTokensPerSecond: number | null = null;
	/** Scroll-Container mit den Nachrichten-Bubbles dieses Tabs. */
	containerEl: HTMLElement;

	constructor(id: string, title: string, containerEl: HTMLElement) {
		this.id = id;
		this.title = title;
		this.containerEl = containerEl;
	}

	get isStreaming(): boolean {
		return this.abortController !== null;
	}
}

export class ChatView extends ItemView {
	private plugin: EuridianPlugin;
	private client = new EuridianApiClient();

	private tabs: ChatTab[] = [];
	private activeTabId = "";
	private tabCounter = 0;

	// --- DOM-Referenzen ---
	private modelSelectEl!: HTMLSelectElement;
	private tabBarEl!: HTMLElement;
	private bodyEl!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private sendBtn!: HTMLButtonElement;
	private statusEl!: HTMLElement;
	private attachmentsEl!: HTMLElement;
	private dropOverlayEl!: HTMLElement;
	/** Zähler für verschachtelte dragenter/dragleave-Events. */
	private dragDepth = 0;

	// --- Suggest-Popup (Slash-Commands „/" und @mention „@") ---
	private suggestEl: HTMLElement | null = null;
	private suggestOpen = false;
	private suggestItems: SuggestItem[] = [];
	private suggestActive = 0;

	/** Anhänge für die nächste Nachricht (wird nach dem Senden geleert). */
	private pendingAttachments: PendingAttachment[] = [];

	/** Gecachte Ollama-Modellliste (lazy geladen). */
	private ollamaModels: string[] | null = null;
	private customModels: string[] | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: EuridianPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_EURIDIAN;
	}

	getDisplayText(): string {
		return "Euridian Chat";
	}

	getIcon(): string {
		return "message-circle";
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("euridian-view");

		this.buildHeader(root);
		this.tabBarEl = root.createDiv({ cls: "euridian-tabbar" });
		this.bodyEl = root.createDiv({ cls: "euridian-body" });
		this.buildInputArea(root);
		this.setupDragAndDrop(root);

		// Gespeicherte Tabs wiederherstellen oder mit einem leeren Tab starten.
		await this.restoreSessions();
		this.populateModelSelect();
	}

	/** Externe Dateien per Drag & Drop aus dem Finder annehmen. */
	private setupDragAndDrop(root: HTMLElement): void {
		this.dropOverlayEl = root.createDiv({
			cls: "euridian-drop-overlay is-hidden",
		});
		const hint = this.dropOverlayEl.createDiv({ cls: "euridian-drop-hint" });
		setIcon(hint.createSpan({ cls: "euridian-drop-icon" }), "upload");
		hint.createDiv({ text: "Dateien hier ablegen" });
		hint.createDiv({
			cls: "euridian-drop-sub",
			text: "Text- und Bilddateien werden in den Kontext aufgenommen",
		});

		const hasFiles = (evt: DragEvent): boolean =>
			Array.from(evt.dataTransfer?.types ?? []).includes("Files");

		this.registerDomEvent(root, "dragenter", (evt) => {
			if (!hasFiles(evt)) return;
			evt.preventDefault();
			this.dragDepth++;
			this.dropOverlayEl.removeClass("is-hidden");
		});
		this.registerDomEvent(root, "dragover", (evt) => {
			if (!hasFiles(evt)) return;
			evt.preventDefault();
			if (evt.dataTransfer) evt.dataTransfer.dropEffect = "copy";
		});
		this.registerDomEvent(root, "dragleave", (evt) => {
			if (!hasFiles(evt)) return;
			this.dragDepth = Math.max(0, this.dragDepth - 1);
			if (this.dragDepth === 0) this.dropOverlayEl.addClass("is-hidden");
		});
		this.registerDomEvent(root, "drop", (evt) => {
			this.dragDepth = 0;
			this.dropOverlayEl.addClass("is-hidden");
			if (!hasFiles(evt)) return;
			evt.preventDefault();
			void this.handleExternalDrop(evt);
		});
	}

	async onClose(): Promise<void> {
		for (const tab of this.tabs) tab.abortController?.abort();
	}

	private get activeTab(): ChatTab {
		return (
			this.tabs.find((t) => t.id === this.activeTabId) ?? this.tabs[0]
		);
	}

	// ---------------------------------------------------------------- UI-Aufbau

	private buildHeader(root: HTMLElement): void {
		const header = root.createDiv({ cls: "euridian-header" });
		header.createSpan({ cls: "euridian-header-brand", text: "Euridian" });

		// Modell-Schnellwechsel.
		this.modelSelectEl = header.createEl("select", {
			cls: "euridian-model-select dropdown",
		});
		this.modelSelectEl.addEventListener("change", async () => {
			await this.onModelChanged(this.modelSelectEl.value);
		});
		// Beim Öffnen des Dropdowns ggf. Modelle nachladen (Ollama/eigener Server).
		this.modelSelectEl.addEventListener("focus", () => {
			const backend = this.plugin.settings.backend;
			if (backend === "ollama" && !this.ollamaModels) {
				void this.loadOllamaModels();
			} else if (backend === "custom" && !this.customModels) {
				void this.loadCustomModels();
			}
		});
	}

	private buildInputArea(root: HTMLElement): void {
		const wrap = root.createDiv({ cls: "euridian-input-wrap" });

		// Suggest-Popup für „/" und „@" (schwebt über dem Eingabefeld).
		this.suggestEl = wrap.createDiv({
			cls: "euridian-suggest-popup is-hidden",
		});

		// Chips der ausstehenden Datei-Anhänge (anfangs versteckt).
		this.attachmentsEl = wrap.createDiv({
			cls: "euridian-attachments is-hidden",
		});

		this.inputEl = wrap.createEl("textarea", {
			cls: "euridian-input",
			attr: {
				placeholder:
					"Frag etwas … (/ Vorlagen, @ Notizen, Enter sendet, Shift+Enter = Zeile)",
			},
		});
		this.inputEl.rows = 3;
		this.inputEl.addEventListener("keydown", (evt) => {
			// Bei offenem Suggest-Popup fängt es die Navigationstasten ab.
			if (this.suggestOpen) {
				if (evt.key === "ArrowDown") {
					evt.preventDefault();
					this.moveSuggest(1);
					return;
				}
				if (evt.key === "ArrowUp") {
					evt.preventDefault();
					this.moveSuggest(-1);
					return;
				}
				if (evt.key === "Enter" || evt.key === "Tab") {
					evt.preventDefault();
					void this.acceptSuggest();
					return;
				}
				if (evt.key === "Escape") {
					evt.preventDefault();
					this.closeSuggest();
					return;
				}
			}
			if (evt.key === "Enter" && !evt.shiftKey) {
				evt.preventDefault();
				this.onSendOrStop();
			}
		});
		this.inputEl.addEventListener("input", () => {
			this.updateStatus();
			this.updateSuggest();
		});
		// Cursor-Bewegung (Pfeiltasten) bei GESCHLOSSENEM Popup → @mention neu prüfen.
		// Bei offenem Popup steuern die Pfeile die Auswahl (im keydown behandelt).
		this.inputEl.addEventListener("keyup", (evt) => {
			if (
				!this.suggestOpen &&
				(evt.key.startsWith("Arrow") || evt.key === "Home" || evt.key === "End")
			) {
				this.updateSuggest();
			}
		});
		this.inputEl.addEventListener("click", () => this.updateSuggest());
		// Klick außerhalb schließt das Popup (kurze Verzögerung wg. Item-Klick).
		this.inputEl.addEventListener("blur", () => {
			window.setTimeout(() => this.closeSuggest(), 120);
		});

		const bottom = wrap.createDiv({ cls: "euridian-input-bottom" });
		this.statusEl = bottom.createDiv({ cls: "euridian-status" });

		const selectionBtn = bottom.createEl("button", {
			cls: "euridian-icon-btn",
			attr: { "aria-label": "Markierten Text als Kontext anhängen" },
		});
		setIcon(selectionBtn, "highlighter");
		selectionBtn.onclick = () => this.attachCurrentSelection();

		const attachBtn = bottom.createEl("button", {
			cls: "euridian-icon-btn",
			attr: { "aria-label": "Datei anhängen" },
		});
		setIcon(attachBtn, "paperclip");
		attachBtn.onclick = () => this.openFilePicker();

		this.sendBtn = bottom.createEl("button", {
			cls: "euridian-send-btn mod-cta",
			text: "Senden",
		});
		this.sendBtn.onclick = () => this.onSendOrStop();
	}

	// ----------------------------------------- Suggest-Popup („/" und „@mention")

	/** Prüft die Eingabe auf `/command` (Zeilenanfang) oder `@datei` (vor Cursor). */
	private updateSuggest(): void {
		const val = this.inputEl.value;

		// 1) Slash-Command: nur am Zeilenanfang, solange nur der Befehl getippt wird.
		const slashM = /^\/([^\s\n]*)$/.exec(val);
		if (slashM) {
			this.buildSlashItems(slashM[1].toLowerCase());
			return;
		}

		// 2) @mention: ein @-Token unmittelbar vor dem Cursor.
		const pos = this.inputEl.selectionStart ?? val.length;
		const before = val.slice(0, pos);
		const atM = /(?:^|\s)@([^\s@]*)$/.exec(before);
		if (atM) {
			const tokenStart = pos - atM[1].length - 1; // Position des "@"
			this.buildMentionItems(atM[1].toLowerCase(), tokenStart, pos);
			return;
		}

		this.closeSuggest();
	}

	/** Baut die Vorschläge für Slash-Commands (Prompt-Vorlagen). */
	private buildSlashItems(query: string): void {
		const templates = this.plugin.settings.promptTemplates ?? [];
		const matches = templates.filter((t) =>
			t.name.toLowerCase().includes(query)
		);
		if (matches.length === 0) {
			this.closeSuggest();
			return;
		}
		this.suggestItems = matches.map((tpl) => ({
			label: `/${tpl.name}`,
			sub: tpl.description,
			apply: () => this.applyTemplate(tpl),
		}));
		this.openSuggest();
	}

	/** Baut die Vorschläge für @mention (Vault-Notizen). */
	private buildMentionItems(
		query: string,
		tokenStart: number,
		tokenEnd: number
	): void {
		const files = this.app.vault
			.getMarkdownFiles()
			.filter(
				(f) =>
					f.basename.toLowerCase().includes(query) ||
					f.path.toLowerCase().includes(query)
			)
			.sort((a, b) => a.path.localeCompare(b.path))
			.slice(0, 12);

		if (files.length === 0) {
			this.closeSuggest();
			return;
		}
		this.suggestItems = files.map((f) => ({
			label: f.basename,
			sub: f.path,
			apply: () => this.applyMention(f, tokenStart, tokenEnd),
		}));
		this.openSuggest();
	}

	private openSuggest(): void {
		this.suggestActive = 0;
		this.suggestOpen = true;
		this.renderSuggest();
	}

	private renderSuggest(): void {
		if (!this.suggestEl) return;
		this.suggestEl.empty();
		this.suggestEl.removeClass("is-hidden");

		this.suggestItems.forEach((item, i) => {
			const el = this.suggestEl!.createDiv({
				cls:
					"euridian-suggest-item" +
					(i === this.suggestActive ? " is-active" : ""),
			});
			el.createSpan({ cls: "euridian-suggest-label", text: item.label });
			if (item.sub) {
				el.createSpan({ cls: "euridian-suggest-sub", text: item.sub });
			}
			// mousedown statt click: hält den Fokus im Textfeld.
			el.addEventListener("mousedown", (e) => {
				e.preventDefault();
				this.suggestActive = i;
				void this.acceptSuggest();
			});
		});
	}

	private moveSuggest(delta: number): void {
		const n = this.suggestItems.length;
		if (n === 0) return;
		this.suggestActive = (this.suggestActive + delta + n) % n;
		this.renderSuggest();
	}

	private async acceptSuggest(): Promise<void> {
		const item = this.suggestItems[this.suggestActive];
		this.closeSuggest();
		if (item) await item.apply();
	}

	private closeSuggest(): void {
		this.suggestOpen = false;
		this.suggestItems = [];
		if (this.suggestEl) {
			this.suggestEl.empty();
			this.suggestEl.addClass("is-hidden");
		}
	}

	/** Übernimmt eine Prompt-Vorlage: expandiert sie in das Eingabefeld. */
	private applyTemplate(tpl: PromptTemplate): void {
		const { text, cursor } = this.expandTemplate(tpl);
		this.inputEl.value = text;
		this.inputEl.focus();
		const pos = cursor ?? text.length;
		this.inputEl.setSelectionRange(pos, pos);
		this.updateStatus();
	}

	/** Übernimmt eine @mention: entfernt das @-Token und hängt die Notiz an. */
	private async applyMention(
		file: TFile,
		tokenStart: number,
		tokenEnd: number
	): Promise<void> {
		const v = this.inputEl.value;
		this.inputEl.value = v.slice(0, tokenStart) + v.slice(tokenEnd);
		this.inputEl.focus();
		this.inputEl.setSelectionRange(tokenStart, tokenStart);
		await this.addVaultAttachment(file);
		this.updateStatus();
	}

	/**
	 * Ersetzt die Platzhalter einer Vorlage. {{input}} markiert die Cursor-
	 * Position für die Nutzereingabe (zurückgegeben als `cursor`).
	 */
	private expandTemplate(tpl: PromptTemplate): {
		text: string;
		cursor: number | null;
	} {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const selection = view?.editor.getSelection() ?? "";
		const note = view?.editor.getValue() ?? "";
		const title = view?.file?.basename ?? "";

		let text = tpl.template
			.replace(/\{\{selection\}\}/g, selection)
			.replace(/\{\{note\}\}/g, note)
			.replace(/\{\{title\}\}/g, title);

		const idx = text.indexOf("{{input}}");
		let cursor: number | null = null;
		if (idx !== -1) {
			cursor = idx;
			text = text.replace(/\{\{input\}\}/g, "");
		}
		return { text, cursor };
	}

	// ------------------------------------------------------------------- Tabs

	private addTab(): void {
		const id = `tab-${++this.tabCounter}`;
		const container = this.bodyEl.createDiv({ cls: "euridian-messages" });
		const tab = new ChatTab(id, `Chat ${this.tabCounter}`, container);
		this.tabs.push(tab);
		this.activeTabId = id;
		this.renderEmptyState(tab);
		this.renderTabBar();
		this.showActiveTab();
		this.syncInputState();
		this.updateStatus();
		this.persist();
	}

	private closeTab(id: string): void {
		const idx = this.tabs.findIndex((t) => t.id === id);
		if (idx === -1) return;

		const tab = this.tabs[idx];
		tab.abortController?.abort();
		tab.containerEl.remove();
		this.tabs.splice(idx, 1);

		// Nie ohne Tab dastehen.
		if (this.tabs.length === 0) {
			this.addTab();
			return;
		}

		// Aktiven Tab nachziehen.
		if (this.activeTabId === id) {
			const next = this.tabs[Math.max(0, idx - 1)];
			this.activeTabId = next.id;
		}
		this.renderTabBar();
		this.showActiveTab();
		this.syncInputState();
		this.updateStatus();
		this.persist();
	}

	private switchTab(id: string): void {
		if (this.activeTabId === id) return;
		this.activeTabId = id;
		this.renderTabBar();
		this.showActiveTab();
		this.syncInputState();
		this.updateStatus();
		this.persist();
	}

	private renderTabBar(): void {
		this.tabBarEl.empty();

		for (const tab of this.tabs) {
			const tabEl = this.tabBarEl.createDiv({
				cls:
					"euridian-tab" +
					(tab.id === this.activeTabId ? " is-active" : ""),
			});
			tabEl.createSpan({ cls: "euridian-tab-title", text: tab.title });
			tabEl.addEventListener("click", () => this.switchTab(tab.id));

			// Schließen-Knopf (nur wenn mehr als ein Tab oder zum Leeren).
			const closeEl = tabEl.createSpan({ cls: "euridian-tab-close" });
			setIcon(closeEl, "x");
			closeEl.addEventListener("click", (evt) => {
				evt.stopPropagation();
				this.closeTab(tab.id);
			});
		}

		// "+"-Knopf.
		const addEl = this.tabBarEl.createDiv({
			cls: "euridian-tab-add",
			attr: { "aria-label": "Neuer Tab" },
		});
		setIcon(addEl, "plus");
		addEl.addEventListener("click", () => this.addTab());
	}

	/** Zeigt nur den aktiven Tab-Container, blendet die anderen aus. */
	private showActiveTab(): void {
		for (const tab of this.tabs) {
			tab.containerEl.toggleClass("is-hidden", tab.id !== this.activeTabId);
		}
		this.scrollToBottom();
	}

	// ------------------------------------------------------------- Persistenz

	/** Stellt gespeicherte Tabs wieder her — oder startet mit einem leeren Tab. */
	private async restoreSessions(): Promise<void> {
		const saved = this.plugin.sessions;
		if (!saved || saved.tabs.length === 0) {
			this.addTab();
			return;
		}

		this.tabCounter = saved.tabCounter ?? saved.tabs.length;

		for (const session of saved.tabs) {
			const container = this.bodyEl.createDiv({ cls: "euridian-messages" });
			const tab = new ChatTab(session.id, session.title, container);
			tab.messages = session.messages.slice();
			this.tabs.push(tab);
			await this.renderTabMessages(tab);
		}

		this.activeTabId =
			saved.activeTabId && this.tabs.some((t) => t.id === saved.activeTabId)
				? saved.activeTabId
				: this.tabs[0].id;

		this.renderTabBar();
		this.showActiveTab();
		this.syncInputState();
		this.updateStatus();
	}

	/** Rendert den gespeicherten Verlauf eines Tabs (User-Text, Assistant-Markdown). */
	private async renderTabMessages(tab: ChatTab): Promise<void> {
		tab.containerEl.empty();
		if (tab.messages.length === 0) {
			this.renderEmptyState(tab);
			return;
		}
		for (const m of tab.messages) {
			if (m.role === "user") {
				this.appendMessageBubble(
					tab,
					"user",
					m.displayContent ?? m.content,
					m.attachedFiles,
					m.images
				);
			} else if (m.role === "assistant") {
				const { contentEl, bubbleEl } = this.appendMessageBubble(
					tab,
					"assistant",
					""
				);
				await this.renderMarkdown(contentEl, m.content);
				this.addAssistantActions(bubbleEl, m.content);
			}
		}
	}

	/** Schreibt den aktuellen Tab-Zustand zur Persistenz an das Plugin. */
	private persist(): void {
		const state: SessionsState = {
			tabs: this.tabs.map((t) => ({
				id: t.id,
				title: t.title,
				messages: t.messages,
			})),
			activeTabId: this.activeTabId,
			tabCounter: this.tabCounter,
		};
		void this.plugin.saveSessions(state);
	}

	// --------------------------------------------------------------- Modelle

	/** Trägt den aktuell aktiven Modellnamen je Backend ein. */
	private currentModel(): string {
		const s = this.plugin.settings;
		if (s.backend === "ollama") return s.ollamaModel;
		if (s.backend === "custom") return s.customModel;
		return s.infomaniakModel;
	}

	/** Befüllt das Modell-Dropdown abhängig vom Backend. */
	private populateModelSelect(): void {
		const s = this.plugin.settings;
		const select = this.modelSelectEl;
		select.empty();

		const current = this.currentModel();
		let names: string[];

		if (s.backend === "ollama") {
			// Reihenfolge: frisch geladene Liste → gescannte Liste aus Settings → aktuelles.
			names =
				this.ollamaModels ??
				(s.ollamaModels.length
					? s.ollamaModels.slice()
					: current
						? [current]
						: []);
		} else if (s.backend === "custom") {
			names =
				this.customModels ??
				(s.customModels.length
					? s.customModels.slice()
					: current
						? [current]
						: []);
		} else {
			// Infomaniak: nur verfügbare ("ready") Modelle aus dem Katalog.
			const ready = s.infomaniakCatalog
				.filter((e) => e.status === "ready")
				.map((e) => e.name);
			names = ready.length ? ready : current ? [current] : [];
		}

		// Aktuelles Modell sicher als Option vorhanden.
		if (current && !names.includes(current)) names.unshift(current);

		if (names.length === 0) {
			const opt = select.createEl("option", {
				value: "",
				text: "— kein Modell —",
			});
			opt.disabled = true;
			return;
		}

		for (const name of names) {
			select.createEl("option", { value: name, text: this.shortModel(name) });
		}
		select.value = current;
	}

	/** Kürzt lange Modellnamen fürs Dropdown (Vendor-Präfix weg). */
	private shortModel(name: string): string {
		const slash = name.lastIndexOf("/");
		return slash >= 0 ? name.slice(slash + 1) : name;
	}

	private async onModelChanged(value: string): Promise<void> {
		if (!value) return;
		const s = this.plugin.settings;
		if (s.backend === "ollama") s.ollamaModel = value;
		else if (s.backend === "custom") s.customModel = value;
		else s.infomaniakModel = value;
		await this.plugin.saveSettings();
		new Notice(`Modell: ${this.shortModel(value)}`);
	}

	/** Lädt die Ollama-Modellliste lazy und aktualisiert das Dropdown. */
	private async loadOllamaModels(): Promise<void> {
		try {
			const endpoint = resolveEndpoint(this.plugin.settings);
			this.ollamaModels = await this.client.listModels(endpoint);
			// In die Settings spiegeln, damit der Settings-Tab dieselbe Liste zeigt.
			this.plugin.settings.ollamaModels = this.ollamaModels.slice();
			await this.plugin.saveSettings();
			this.populateModelSelect();
		} catch {
			// Das Freitext-Modell bleibt nutzbar; kein harter Fehler nötig.
			this.ollamaModels = [];
		}
	}

	/** Lädt die Modellliste des eigenen Servers lazy und aktualisiert das Dropdown. */
	private async loadCustomModels(): Promise<void> {
		try {
			const endpoint = resolveEndpoint(this.plugin.settings);
			this.customModels = await this.client.listModels(endpoint);
			this.plugin.settings.customModels = this.customModels.slice();
			await this.plugin.saveSettings();
			this.populateModelSelect();
		} catch {
			this.customModels = [];
		}
	}

	// ------------------------------------------------------------ Senden/Stream

	private onSendOrStop(): void {
		const tab = this.activeTab;
		if (tab.isStreaming) {
			tab.abortController?.abort();
			return;
		}
		const displayText = this.inputEl.value.trim();
		const attachments = this.pendingAttachments.splice(0); // leert das Array
		if (!displayText && attachments.length === 0) return;

		this.inputEl.value = "";
		this.renderAttachmentChips();
		this.updateStatus();

		// Textdateien und markierte Auswahlen als XML-Blöcke einbetten.
		const textAtts = attachments.filter(
			(a): a is Extract<PendingAttachment, { kind: "text" | "selection" }> =>
				a.kind === "text" || a.kind === "selection"
		);
		let apiContent = displayText;
		if (textAtts.length > 0) {
			const blocks = textAtts
				.map((a) =>
					a.kind === "selection"
						? `<selected_text source="${a.path}">\n${a.content}\n</selected_text>`
						: `<attached_file path="${a.path}">\n${a.content}\n</attached_file>`
				)
				.join("\n\n");
			apiContent = displayText ? `${displayText}\n\n${blocks}` : blocks;
		}

		// Bilder werden multimodal (image_url) gesendet.
		const images: AttachedImage[] = attachments
			.filter(
				(a): a is Extract<PendingAttachment, { kind: "image" }> =>
					a.kind === "image"
			)
			.map((a) => ({ name: a.name, dataUrl: a.dataUrl }));

		void this.sendMessage(
			tab,
			apiContent,
			displayText,
			textAtts.map((a) => a.name),
			images
		);
	}

	private async sendMessage(
		tab: ChatTab,
		apiContent: string,
		displayText: string,
		attachedFiles: string[] = [],
		images: AttachedImage[] = []
	): Promise<void> {
		if (tab.messages.length === 0) {
			tab.containerEl.empty();
			const titleSrc = displayText || attachedFiles[0] || "Chat";
			tab.title = titleSrc.length > 22 ? titleSrc.slice(0, 22) + "…" : titleSrc;
			this.renderTabBar();
		}

		tab.messages.push({
			role: "user",
			content: apiContent,
			displayContent: displayText || undefined,
			attachedFiles: attachedFiles.length > 0 ? attachedFiles : undefined,
			images: images.length > 0 ? images : undefined,
		});
		this.appendMessageBubble(
			tab,
			"user",
			displayText || "(Anhänge)",
			attachedFiles,
			images
		);
		this.persist();

		const { contentEl, bubbleEl } = this.appendMessageBubble(
			tab,
			"assistant",
			""
		);
		// Werkzeug-Aktivität wird über dem Text angezeigt.
		const toolsEl = bubbleEl.createDiv({ cls: "euridian-tools" });

		// „Denkt"-Indikator: animierte Punkte + Live-Timer (seit Senden).
		const thinkingEl = bubbleEl.createDiv({ cls: "euridian-thinking" });
		const thinkingDots = thinkingEl.createSpan({ cls: "euridian-thinking-dots" });
		thinkingDots.createSpan();
		thinkingDots.createSpan();
		thinkingDots.createSpan();
		const thinkingTimerEl = thinkingEl.createSpan({
			cls: "euridian-thinking-timer",
			text: "denkt 0 s",
		});
		const thinkingStart = Date.now();
		const thinkingTick = window.setInterval(() => {
			const secs = Math.floor((Date.now() - thinkingStart) / 1000);
			thinkingTimerEl.setText(`denkt ${secs} s`);
		}, 1000);

		tab.abortController = new AbortController();
		tab.lastUsage = null;
		tab.lastResponseMs = null;
		tab.lastTokensPerSecond = null;
		this.syncInputState();

		let streamText = "";

		// Live-Markdown während des Streamens — gedrosselt (nicht bei jedem
		// Token, das wäre zu teuer) und serialisiert (Markdown-Render ist async).
		const RENDER_INTERVAL = 120;
		let lastRender = 0;
		let renderTimer: number | null = null;
		let rendering = false;
		let dirty = false;

		const renderNow = async () => {
			if (rendering) {
				dirty = true; // läuft schon → nach Abschluss erneut rendern
				return;
			}
			rendering = true;
			do {
				dirty = false;
				await this.renderMarkdown(contentEl, streamText);
			} while (dirty);
			rendering = false;
			if (tab.id === this.activeTabId) this.scrollToBottom();
		};

		const scheduleRender = () => {
			const elapsed = Date.now() - lastRender;
			if (elapsed >= RENDER_INTERVAL) {
				lastRender = Date.now();
				void renderNow();
			} else if (renderTimer === null) {
				renderTimer = window.setTimeout(() => {
					renderTimer = null;
					lastRender = Date.now();
					void renderNow();
				}, RENDER_INTERVAL - elapsed);
			}
		};

		const callbacks = {
			signal: tab.abortController.signal,
			onToken: (delta: string) => {
				if (thinkingEl.isConnected) thinkingEl.remove();
				streamText += delta;
				scheduleRender();
			},
			onUsage: (usage: TokenUsage) => {
				tab.lastUsage = usage;
			},
		};

		try {
			const endpoint = resolveEndpoint(this.plugin.settings);
			const useAgent = this.plugin.settings.enableVaultAgent;
			const useWeb =
				this.plugin.settings.enableWebSearch &&
				!!this.plugin.settings.braveApiKey.trim();
			// Vault-Agent und Websuche sind unabhängige Schalter — beide, eines
			// oder keines kann aktiv sein. Tools nur senden, wenn mind. eines an ist.
			const tools: ToolDefinition[] | undefined =
				useAgent || useWeb
					? [
							...(useAgent ? getToolDefinitions() : []),
							...(useWeb ? getWebToolDefinitions() : []),
						]
					: undefined;

			// Arbeits-Nachrichten für diese Nutzer-Runde (inkl. Tool-Zwischenschritte).
			const working: ApiMessage[] = await this.buildRequestMessages(tab);

			await this.runAgentLoop(
				tab,
				endpoint,
				working,
				tools,
				callbacks,
				toolsEl,
				thinkingEl
			);

			// t/s aus completionTokens des finalen Turns ÷ dessen Dauer.
			// Cast nötig: TS narrowt tab.lastUsage fälschlich auf den Stand VOR
			// dem await (frühere "= null"-Zuweisung), weil es nicht erkennt, dass
			// die onUsage-Callback-Closure den Wert während runAgentLoop() neu setzt.
			const currentUsage = tab.lastUsage as TokenUsage | null;
			tab.lastTokensPerSecond = null;
			if (currentUsage !== null && tab.lastResponseMs !== null && tab.lastResponseMs > 0) {
				tab.lastTokensPerSecond =
					currentUsage.completionTokens / (tab.lastResponseMs / 1000);
			}

			if (thinkingEl.isConnected) thinkingEl.remove();

			if (streamText.trim()) {
				tab.messages.push({ role: "assistant", content: streamText });
				await this.renderMarkdown(contentEl, streamText);
				this.addAssistantActions(bubbleEl, streamText);
			} else if (toolsEl.childElementCount > 0) {
				contentEl.setText("(Aktionen ausgeführt — siehe oben)");
			} else {
				contentEl.setText("(keine Antwort)");
			}
		} catch (err) {
			if (thinkingEl.isConnected) thinkingEl.remove();
			this.handleStreamError(err, tab, contentEl, streamText, bubbleEl);
		} finally {
			// Geplanten Live-Render abbrechen — der finale Render oben ist maßgeblich.
			if (renderTimer !== null) window.clearTimeout(renderTimer);
			window.clearInterval(thinkingTick);
			tab.abortController = null;
			this.syncInputState();
			this.updateStatus();
			if (tab.id === this.activeTabId) this.scrollToBottom();
			this.persist();
		}
	}

	/**
	 * Agent-Schleife: streamt einen Turn; fordert das Modell Werkzeuge an,
	 * führt sie aus, reicht die Ergebnisse zurück und streamt weiter — bis das
	 * Modell ohne Tool-Call antwortet oder das Iterationslimit erreicht ist.
	 */
	private async runAgentLoop(
		tab: ChatTab,
		endpoint: ReturnType<typeof resolveEndpoint>,
		working: ApiMessage[],
		tools: ReturnType<typeof getToolDefinitions> | undefined,
		callbacks: Parameters<EuridianApiClient["streamChat"]>[4],
		toolsEl: HTMLElement,
		thinkingEl: HTMLElement
	): Promise<void> {
		for (let i = 0; i < MAX_AGENT_ITERATIONS; i++) {
			const turnStart = Date.now();
			const result = await this.client.streamChat(
				endpoint,
				working,
				effectiveThinking(this.plugin.settings),
				this.plugin.settings.temperature,
				callbacks,
				tools
			);

			// Keine Werkzeuge angefordert → fertige Antwort. Dauer NUR dieses
			// finalen Turns merken (schließt Tool-Ausführung/Bestätigungen aus
			// vorherigen Runden aus — sonst würde t/s durch Wartezeiten verzerrt).
			if (result.toolCalls.length === 0) {
				tab.lastResponseMs = Date.now() - turnStart;
				return;
			}

			// Infomaniak verlangt tool_call_id = exakt 9 alphanumerische Zeichen.
			// Abweichende IDs konsistent normalisieren (gilt für assistant + tool).
			for (const call of result.toolCalls) {
				if (!/^[a-zA-Z0-9]{9}$/.test(call.id)) call.id = this.randomToolId();
			}

			// Assistant-Turn mit Tool-Calls in den Verlauf aufnehmen.
			working.push({
				role: "assistant",
				content: result.content || null,
				tool_calls: result.toolCalls,
			});

			// Jeden Tool-Call anzeigen, ausführen und Ergebnis zurückgeben.
			for (const call of result.toolCalls) {
				if (thinkingEl.isConnected) thinkingEl.remove();
				const chipEl = this.renderToolChip(toolsEl, describeToolCall(call));

				let output: string;

				if (isWebTool(call.function.name)) {
					// Websuche ist rein lesend — keine Schreib-Bestätigung nötig.
					output = await executeWebToolCall(
						this.plugin.settings.braveApiKey.trim(),
						call
					);
					chipEl.addClass("is-done");
				} else {
					const needsConfirm =
						this.plugin.settings.confirmBeforeWrite &&
						isWriteTool(call.function.name);

					if (needsConfirm) {
						const action = this.parseWriteAction(call);
						const approved = action
							? await confirmWrite(this.app, action)
							: true;
						if (!approved) {
							chipEl.addClass("is-rejected");
							output =
								"Der Nutzer hat diese Schreibaktion abgelehnt. Führe sie nicht aus. " +
								"Frage bei Bedarf nach, was stattdessen geschehen soll.";
						} else {
							output = await executeToolCall(this.app, call);
							chipEl.addClass("is-done");
						}
					} else {
						output = await executeToolCall(this.app, call);
						chipEl.addClass("is-done");
					}
				}

				working.push({
					role: "tool",
					tool_call_id: call.id,
					content: output,
				});
			}
			// Vor dem nächsten Turn wieder „denkt …" zeigen.
			if (i < MAX_AGENT_ITERATIONS - 1) {
				toolsEl.insertAdjacentElement("afterend", thinkingEl);
			}
		}

		new Notice("Euridian: Maximale Werkzeug-Schritte erreicht.");
	}

	// ------------------------------------------------------- Datei-Anhänge

	private openFilePicker(): void {
		new FileSuggestModal(this.app, async (file) => {
			await this.addVaultAttachment(file);
		}).open();
	}

	/** Holt die aktuelle Editor-Selektion und hängt sie als Kontext an. */
	private attachCurrentSelection(): void {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const sel = view?.editor.getSelection() ?? "";
		if (!sel.trim()) {
			new Notice("Kein Text markiert.");
			return;
		}
		this.addSelectionAttachment(sel, view?.file?.path ?? "Notiz");
	}

	/**
	 * Hängt markierten Text als Kontext-Snippet an die nächste Nachricht.
	 * Öffentlich, damit Command und Editor-Kontextmenü (main.ts) es nutzen können.
	 */
	addSelectionAttachment(text: string, path: string): void {
		let content = text;
		let truncated = false;
		if (content.length > MAX_ATTACHMENT_CHARS) {
			content = content.slice(0, MAX_ATTACHMENT_CHARS);
			truncated = true;
		}
		const noteName = path.split("/").pop() ?? path;
		const name = `Auswahl: ${noteName} (${text.length} Z.)`;
		this.pendingAttachments.push({ kind: "selection", name, path, content });
		this.renderAttachmentChips();
		this.updateStatus();
		new Notice(
			truncated
				? `Auswahl angehängt (auf ${MAX_ATTACHMENT_CHARS.toLocaleString()} Zeichen gekürzt).`
				: "Auswahl zum Kontext hinzugefügt."
		);
	}

	/** Vault-Notiz (Markdown) als Text-Anhang. */
	private async addVaultAttachment(file: TFile): Promise<void> {
		if (this.pendingAttachments.some((a) => a.path === file.path)) {
			new Notice(`${file.name} ist bereits angehängt.`);
			return;
		}
		let content = await this.app.vault.cachedRead(file);
		if (content.length > MAX_ATTACHMENT_CHARS) {
			content = content.slice(0, MAX_ATTACHMENT_CHARS);
			new Notice(
				`${file.name}: auf ${MAX_ATTACHMENT_CHARS.toLocaleString()} Zeichen gekürzt.`
			);
		}
		this.pendingAttachments.push({
			kind: "text",
			name: file.name,
			path: file.path,
			content,
		});
		this.renderAttachmentChips();
		this.updateStatus();
	}

	/** Verarbeitet alle per Drag & Drop fallengelassenen Dateien. */
	private async handleExternalDrop(evt: DragEvent): Promise<void> {
		const files = evt.dataTransfer?.files;
		if (!files || files.length === 0) return;
		for (let i = 0; i < files.length; i++) {
			await this.addExternalFile(files[i]);
		}
	}

	/** Externe Datei (aus dem Finder) klassifizieren und als Anhang aufnehmen. */
	private async addExternalFile(file: File): Promise<void> {
		// Bei externen Dateien gibt Electron einen .path; sonst nur den Namen.
		const path = (file as File & { path?: string }).path || file.name;
		if (this.pendingAttachments.some((a) => a.path === path)) {
			new Notice(`${file.name} ist bereits angehängt.`);
			return;
		}

		const kind = classifyFile(file.name, file.type);
		if (kind === null) {
			new Notice(
				`${file.name}: Dateityp nicht unterstützt (nur Text- und Bilddateien).`
			);
			return;
		}

		if (kind === "image") {
			if (file.size > MAX_IMAGE_BYTES) {
				new Notice(
					`${file.name} ist zu groß (max. ${MAX_IMAGE_BYTES / 1024 / 1024} MB).`
				);
				return;
			}
			let dataUrl: string;
			try {
				dataUrl = await this.readAsDataUrl(file);
			} catch {
				new Notice(`${file.name} konnte nicht gelesen werden.`);
				return;
			}
			this.pendingAttachments.push({
				kind: "image",
				name: file.name,
				path,
				dataUrl,
			});
		} else {
			let content: string;
			try {
				content = await file.text();
			} catch {
				new Notice(`${file.name} konnte nicht gelesen werden.`);
				return;
			}
			if (content.length > MAX_ATTACHMENT_CHARS) {
				content = content.slice(0, MAX_ATTACHMENT_CHARS);
				new Notice(
					`${file.name}: auf ${MAX_ATTACHMENT_CHARS.toLocaleString()} Zeichen gekürzt.`
				);
			}
			this.pendingAttachments.push({
				kind: "text",
				name: file.name,
				path,
				content,
			});
		}

		new Notice(`${file.name} zum Kontext hinzugefügt.`);
		this.renderAttachmentChips();
		this.updateStatus();
	}

	/** Liest eine Datei als Base64-Data-URL. */
	private readAsDataUrl(file: File): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => resolve(reader.result as string);
			reader.onerror = () => reject(reader.error);
			reader.readAsDataURL(file);
		});
	}

	private renderAttachmentChips(): void {
		this.attachmentsEl.empty();
		this.attachmentsEl.toggleClass(
			"is-hidden",
			this.pendingAttachments.length === 0
		);
		for (const att of this.pendingAttachments) {
			const chip = this.attachmentsEl.createDiv({
				cls: "euridian-attachment-chip",
			});
			const icon =
				att.kind === "image"
					? "image"
					: att.kind === "selection"
						? "highlighter"
						: "paperclip";
			setIcon(chip.createSpan({ cls: "euridian-tool-icon" }), icon);
			chip.createSpan({
				cls: "euridian-tool-label",
				text: att.name,
				attr: { title: att.path },
			});
			const removeEl = chip.createSpan({ cls: "euridian-attachment-remove" });
			setIcon(removeEl, "x");
			removeEl.addEventListener("click", () => {
				// Identitätsbasiert entfernen — mehrere Auswahlen können denselben
				// Pfad teilen, dürfen aber einzeln entfernbar sein.
				this.pendingAttachments = this.pendingAttachments.filter(
					(a) => a !== att
				);
				this.renderAttachmentChips();
				this.updateStatus();
			});
		}
	}

	/** Liest path/content eines Schreib-Tool-Calls für die Bestätigungs-Vorschau. */
	private parseWriteAction(call: {
		function: { name: string; arguments: string };
	}): WriteAction | null {
		try {
			const a = JSON.parse(call.function.arguments || "{}");
			return {
				tool: call.function.name,
				path: a.path ?? "",
				content: a.content ?? "",
			};
		} catch {
			return null;
		}
	}

	/** Erzeugt eine gültige 9-stellige alphanumerische Tool-Call-ID. */
	private randomToolId(): string {
		const chars =
			"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
		let id = "";
		for (let i = 0; i < 9; i++) {
			id += chars[Math.floor(Math.random() * chars.length)];
		}
		return id;
	}

	/**
	 * Rendert einen Werkzeug-Aktivitäts-Chip und gibt ihn zurück. Baut beim
	 * ersten Chip lazy einen einklappbaren Header (Klick = auf-/zuklappen).
	 * Standardmäßig eingeklappt: nur der jeweils neueste Chip ist sichtbar,
	 * damit lange Werkzeug-Ketten nicht das Chat-Fenster fluten.
	 */
	private renderToolChip(toolsEl: HTMLElement, label: string): HTMLElement {
		let listEl = toolsEl.querySelector<HTMLElement>(":scope > .euridian-tools-list");
		let headerEl = toolsEl.querySelector<HTMLElement>(":scope > .euridian-tools-header");

		if (!listEl || !headerEl) {
			headerEl = toolsEl.createDiv({ cls: "euridian-tools-header" });
			const chevron = headerEl.createSpan({ cls: "euridian-tools-chevron" });
			setIcon(chevron, "chevron-right");
			headerEl.createSpan({ cls: "euridian-tools-count" });
			listEl = toolsEl.createDiv({ cls: "euridian-tools-list is-collapsed" });

			const list = listEl;
			headerEl.addEventListener("click", () => {
				const collapsed = list.classList.toggle("is-collapsed");
				headerEl!.classList.toggle("is-expanded", !collapsed);
			});
		}

		const chip = listEl.createDiv({ cls: "euridian-tool-chip" });
		setIcon(chip.createSpan({ cls: "euridian-tool-icon" }), "wrench");
		chip.createSpan({ cls: "euridian-tool-label", text: label });

		const count = listEl.childElementCount;
		headerEl.querySelector(".euridian-tools-count")?.setText(
			`${count} Werkzeug-Aufruf${count === 1 ? "" : "e"}`
		);

		if (this.activeTab.id === this.activeTabId) this.scrollToBottom();
		return chip;
	}

	private async buildRequestMessages(tab: ChatTab): Promise<ApiMessage[]> {
		const s = this.plugin.settings;
		const result: ApiMessage[] = [];

		// Reihenfolge bewusst: Hintergrund-Dokumente ZUERST, das Agent-Mandat
		// ZULETZT. Modelle gewichten das Ende stärker (Recency) — so überschreibt
		// ein langer CLAUDE.md-Block nicht die Werkzeug-Anweisung.
		const systemParts: string[] = [];

		if (s.euridianInstructionsPath) {
			const instructions = await this.loadInstructionsFile(s.euridianInstructionsPath);
			if (instructions) systemParts.push(instructions);
		}

		if (s.includeCurrentNote) {
			const noteContext = this.getCurrentNoteContext();
			if (noteContext) systemParts.push(noteContext);
		}

		if (s.systemPrompt.trim()) systemParts.push(s.systemPrompt.trim());

		// Agent-Mandat ans Ende. Vault-Agent und Websuche sind unabhängig schaltbar.
		const useWebForPrompt = s.enableWebSearch && !!s.braveApiKey.trim();
		if (s.enableVaultAgent || useWebForPrompt) {
			systemParts.push(buildAgentSystemPrompt(s.enableVaultAgent, useWebForPrompt));
		}

		if (systemParts.length > 0) {
			result.push({ role: "system", content: systemParts.join("\n\n") });
		}

		for (const m of tab.messages.slice(-s.maxContextMessages)) {
			if (m.role === "user" && m.images && m.images.length > 0) {
				// Multimodal: Text + ein image_url-Teil pro Bild.
				const parts: ContentPart[] = [];
				if (m.content) parts.push({ type: "text", text: m.content });
				for (const img of m.images) {
					parts.push({ type: "image_url", image_url: { url: img.dataUrl } });
				}
				result.push({ role: m.role, content: parts });
			} else {
				result.push({ role: m.role, content: m.content });
			}
		}
		return result;
	}

	/** Lädt eine einzelne Instruktionsdatei aus dem Vault (Pfad relativ zum Root). */
	private async loadInstructionsFile(path: string): Promise<string | null> {
		const f = this.app.vault.getAbstractFileByPath(path);
		if (!(f instanceof TFile)) return null;
		const content = await this.app.vault.cachedRead(f);
		if (!content.trim()) return null;
		return `<euridian_instructions path="${path}">\n${content}\n</euridian_instructions>`;
	}

	private getCurrentNoteContext(): string | null {
		const file = this.app.workspace.getActiveFile();
		if (!file) return null;
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const content = view?.editor.getValue();
		if (!content) return null;
		return `<current_note path="${file.path}">\n${content}\n</current_note>`;
	}

	private handleStreamError(
		err: unknown,
		tab: ChatTab,
		contentEl: HTMLElement,
		partialText: string,
		bubbleEl: HTMLElement
	): void {
		if (err instanceof EuridianError && err.kind === "aborted") {
			if (partialText.trim()) {
				tab.messages.push({ role: "assistant", content: partialText });
				void this.renderMarkdown(contentEl, partialText);
				contentEl.createDiv({
					cls: "euridian-aborted-note",
					text: "— abgebrochen —",
				});
			} else {
				bubbleEl.remove();
			}
			return;
		}

		const msg =
			err instanceof EuridianError
				? err.message
				: `Unerwarteter Fehler: ${String(err)}`;
		contentEl.empty();
		contentEl.createDiv({ cls: "euridian-error", text: `⚠ ${msg}` });
		new Notice(`Euridian: ${msg}`, 8000);
	}

	// ----------------------------------------------------------- Nachrichten-UI

	private appendMessageBubble(
		tab: ChatTab,
		role: "user" | "assistant",
		text: string,
		attachedFiles?: string[],
		images?: AttachedImage[]
	): { bubbleEl: HTMLElement; contentEl: HTMLElement } {
		const bubbleEl = tab.containerEl.createDiv({
			cls: `euridian-msg euridian-msg-${role}`,
		});
		const contentEl = bubbleEl.createDiv({ cls: "euridian-msg-content" });
		if (text) contentEl.setText(text);

		// Bild-Vorschauen unter der Nachricht.
		if (role === "user" && images && images.length > 0) {
			const imgWrap = bubbleEl.createDiv({ cls: "euridian-msg-images" });
			for (const img of images) {
				imgWrap.createEl("img", {
					cls: "euridian-msg-thumb",
					attr: { src: img.dataUrl, title: img.name, alt: img.name },
				});
			}
		}

		// Datei-Chips unter User-Nachrichten (nicht-interaktiv, da bereits gesendet).
		if (role === "user" && attachedFiles && attachedFiles.length > 0) {
			const filesEl = bubbleEl.createDiv({ cls: "euridian-msg-files" });
			for (const name of attachedFiles) {
				const chip = filesEl.createSpan({ cls: "euridian-file-chip" });
				setIcon(chip.createSpan({ cls: "euridian-tool-icon" }), "file-text");
				chip.createSpan({
					text: name.split("/").pop() ?? name,
					attr: { title: name },
				});
			}
		}

		if (tab.id === this.activeTabId) this.scrollToBottom();
		return { bubbleEl, contentEl };
	}

	private addAssistantActions(bubbleEl: HTMLElement, text: string): void {
		const actions = bubbleEl.createDiv({ cls: "euridian-msg-actions" });

		const copyBtn = actions.createEl("button", {
			cls: "euridian-icon-btn",
			attr: { "aria-label": "Kopieren" },
		});
		setIcon(copyBtn, "copy");
		copyBtn.onclick = async () => {
			await navigator.clipboard.writeText(text);
			new Notice("Kopiert.");
		};

		const insertBtn = actions.createEl("button", {
			cls: "euridian-icon-btn",
			attr: { "aria-label": "In Notiz einfügen" },
		});
		setIcon(insertBtn, "file-down");
		insertBtn.onclick = () => this.insertIntoNote(text);
	}

	private insertIntoNote(text: string): void {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) {
			new Notice("Keine aktive Notiz zum Einfügen geöffnet.");
			return;
		}
		view.editor.replaceSelection(text);
		new Notice("In Notiz eingefügt.");
	}

	private async renderMarkdown(el: HTMLElement, markdown: string): Promise<void> {
		el.empty();
		await MarkdownRenderer.render(
			this.app,
			markdown,
			el,
			this.app.workspace.getActiveFile()?.path ?? "",
			this
		);
	}

	// -------------------------------------------------------------- Hilfsmethoden

	private renderEmptyState(tab: ChatTab): void {
		tab.containerEl.empty();
		const empty = tab.containerEl.createDiv({ cls: "euridian-empty" });
		empty.createDiv({ cls: "euridian-empty-title", text: "Euridian Chat" });
		empty.createDiv({
			cls: "euridian-empty-sub",
			text: this.plugin.settings.includeCurrentNote
				? "Die aktuelle Notiz wird als Kontext mitgesendet."
				: "Stell eine Frage, um zu starten.",
		});
	}

	/** Send-Button + Eingabe an den Streaming-Zustand des aktiven Tabs anpassen. */
	private syncInputState(): void {
		const streaming = this.activeTab.isStreaming;
		this.sendBtn.setText(streaming ? "Stop" : "Senden");
		this.sendBtn.toggleClass("mod-warning", streaming);
		this.sendBtn.toggleClass("mod-cta", !streaming);
	}

	private updateStatus(): void {
		const tab = this.activeTab;
		const inputTokens = estimateTokens(this.inputEl.value);
		const imageAttCount = this.pendingAttachments.filter(
			(a) => a.kind === "image"
		).length;
		const attachmentTokens = this.pendingAttachments.reduce(
			(sum, a) => (a.kind === "image" ? sum : sum + estimateTokens(a.content)),
			0
		);
		const historyTokens = tab.messages.reduce(
			(sum, m) => sum + estimateTokens(m.content),
			0
		);
		let status = `~${historyTokens + inputTokens + attachmentTokens} Token im Kontext`;
		if (imageAttCount > 0) {
			status += ` · ${imageAttCount} Bild${imageAttCount > 1 ? "er" : ""}`;
		}
		if (tab.lastUsage) {
			status += ` · letzte Antwort: ${tab.lastUsage.totalTokens} Token`;
			if (tab.lastTokensPerSecond) {
				status += ` · ~${tab.lastTokensPerSecond.toFixed(1)} t/s`;
			}
		}
		this.statusEl.setText(status);
	}

	private scrollToBottom(): void {
		const el = this.activeTab?.containerEl;
		if (el) el.scrollTop = el.scrollHeight;
	}
}
