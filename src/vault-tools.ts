/**
 * Euridian — Vault-Werkzeuge für den Agenten (Function Calling).
 *
 * Definiert die Tools, die dem Modell angeboten werden, und führt sie gegen
 * Obsidians `vault`-API aus. Pfade sind immer relativ zum Vault-Root.
 *
 * SICHERHEIT: Es gibt bewusst KEIN Lösch-Werkzeug (globale Datei-Sicherheits-
 * regel). Schreibende Aktionen melden sich über `Notice`, damit der Nutzer
 * sie mitbekommt, auch wenn der Agent ohne Rückfrage arbeitet.
 */

import { App, Notice, TFile, TFolder, normalizePath } from "obsidian";
import { ToolCall, ToolDefinition } from "./types";

/** Max. Zeichen, die ein read_note an das Modell zurückgibt (Token-Schutz). */
const MAX_READ_CHARS = 40_000;
/** Max. Treffer bei der Suche. */
const MAX_SEARCH_HITS = 25;
/** Max. Pfade bei list_notes. */
const MAX_LIST = 300;

/** Stellt sicher, dass ein Notizpfad auf .md endet und normalisiert ist. */
export function asNotePath(path: string): string {
	let p = normalizePath(path.trim());
	if (!p.toLowerCase().endsWith(".md")) p += ".md";
	return p;
}

/** Legt fehlende Elternordner für einen Pfad an. */
async function ensureParentFolder(app: App, path: string): Promise<void> {
	const slash = path.lastIndexOf("/");
	if (slash <= 0) return;
	const folder = path.slice(0, slash);
	if (!app.vault.getAbstractFileByPath(folder)) {
		await app.vault.createFolder(folder).catch(() => {
			/* existiert evtl. schon — egal */
		});
	}
}

/** Die Werkzeug-Definitionen, die dem Modell mitgeschickt werden. */
export function getToolDefinitions(): ToolDefinition[] {
	return [
		{
			type: "function",
			function: {
				name: "list_notes",
				description:
					"Listet Markdown-Notizen im Vault auf (Pfad + Dateigröße in Byte), optional " +
					"gefiltert auf einen Ordner (Präfix). NUTZE DIE DATEIGRÖSSE, um leere/fast-leere " +
					"Notizen zu erkennen (⚠-Markierung bei ≤50 Byte) — rufe dafür NICHT read_note " +
					"für jede einzelne Datei auf, das ist unnötig teuer und sprengt bei vielen " +
					"Dateien den Kontext. read_note nur für Notizen nutzen, deren Inhalt du wirklich brauchst.",
				parameters: {
					type: "object",
					properties: {
						folder: {
							type: "string",
							description:
								"Optionaler Ordner-Präfix, z. B. '03 Projekte'. Leer = ganzer Vault.",
						},
					},
				},
			},
		},
		{
			type: "function",
			function: {
				name: "read_note",
				description:
					"Liest den vollständigen Inhalt einer Markdown-Notiz aus dem Vault.",
				parameters: {
					type: "object",
					properties: {
						path: {
							type: "string",
							description: "Pfad zur Notiz relativ zum Vault-Root.",
						},
					},
					required: ["path"],
				},
			},
		},
		{
			type: "function",
			function: {
				name: "search_vault",
				description:
					"Durchsucht alle Notizen nach einem Suchbegriff (in Dateiname und Inhalt). Gibt Treffer mit Pfad und kurzem Kontext zurück.",
				parameters: {
					type: "object",
					properties: {
						query: {
							type: "string",
							description: "Suchbegriff (Groß-/Kleinschreibung egal).",
						},
					},
					required: ["query"],
				},
			},
		},
		{
			type: "function",
			function: {
				name: "create_note",
				description:
					"Erstellt eine NEUE Markdown-Notiz mit dem gegebenen Inhalt. Schlägt fehl, wenn die Notiz bereits existiert (dann edit_note oder append_to_note nutzen).",
				parameters: {
					type: "object",
					properties: {
						path: {
							type: "string",
							description: "Zielpfad relativ zum Vault-Root.",
						},
						content: { type: "string", description: "Markdown-Inhalt." },
					},
					required: ["path", "content"],
				},
			},
		},
		{
			type: "function",
			function: {
				name: "append_to_note",
				description:
					"BEVORZUGT zum Ergänzen: Hängt Text ans Ende einer Notiz an, ohne " +
					"Bestehendes zu verändern (nicht-destruktiv). Legt die Notiz an, falls " +
					"sie nicht existiert. Nutze dies, um Notizen zu erweitern/zu ergänzen.",
				parameters: {
					type: "object",
					properties: {
						path: {
							type: "string",
							description: "Pfad relativ zum Vault-Root.",
						},
						content: { type: "string", description: "Anzuhängender Text." },
					},
					required: ["path", "content"],
				},
			},
		},
		{
			type: "function",
			function: {
				name: "edit_note",
				description:
					"GEFÄHRLICH/DESTRUKTIV: Ersetzt den GESAMTEN Inhalt einer Notiz. Alles " +
					"bisher Vorhandene, das du NICHT mitschickst, geht VERLOREN. Nutze dies " +
					"NUR, wenn der Nutzer ausdrücklich ein Überschreiben/Neuschreiben will — " +
					"und gib dann den vollständigen Inhalt inkl. ALLER bestehenden Teile zurück. " +
					"Zum bloßen Ergänzen stattdessen append_to_note verwenden.",
				parameters: {
					type: "object",
					properties: {
						path: {
							type: "string",
							description: "Pfad relativ zum Vault-Root.",
						},
						content: { type: "string", description: "Neuer vollständiger Inhalt." },
					},
					required: ["path", "content"],
				},
			},
		},
	];
}

/** Werkzeuge, die den Vault verändern (für die Bestätigungs-Abfrage). */
const WRITE_TOOLS = new Set(["create_note", "append_to_note", "edit_note"]);

/** True, wenn das Werkzeug schreibend in den Vault eingreift. */
export function isWriteTool(name: string): boolean {
	return WRITE_TOOLS.has(name);
}

/** Kurzbeschreibung eines Tool-Calls für die UI-Anzeige (Chip). */
export function describeToolCall(call: ToolCall): string {
	let arg = "";
	try {
		const args = JSON.parse(call.function.arguments || "{}");
		arg = args.path ?? args.query ?? args.folder ?? "";
	} catch {
		/* ignore */
	}
	return arg ? `${call.function.name}(${arg})` : call.function.name;
}

/**
 * Führt einen Tool-Call aus und gibt das Ergebnis als String zurück
 * (wird dem Modell als tool-Nachricht zurückgereicht).
 */
export async function executeToolCall(
	app: App,
	call: ToolCall
): Promise<string> {
	let args: Record<string, string>;
	try {
		args = JSON.parse(call.function.arguments || "{}");
	} catch {
		return "Fehler: Argumente waren kein gültiges JSON.";
	}

	try {
		switch (call.function.name) {
			case "list_notes":
				return listNotes(app, args.folder);
			case "read_note":
				return readNote(app, args.path);
			case "search_vault":
				return searchVault(app, args.query);
			case "create_note":
				return await createNote(app, args.path, args.content);
			case "append_to_note":
				return await appendToNote(app, args.path, args.content);
			case "edit_note":
				return await editNote(app, args.path, args.content);
			default:
				return `Fehler: Unbekanntes Werkzeug "${call.function.name}".`;
		}
	} catch (err) {
		return `Fehler bei ${call.function.name}: ${
			err instanceof Error ? err.message : String(err)
		}`;
	}
}

// ------------------------------------------------------------------ Lesen

/** Ab dieser Bytegröße gilt eine Notiz in der list_notes-Ausgabe als "nahezu leer". */
const NEAR_EMPTY_BYTES = 50;

function listNotes(app: App, folder?: string): string {
	const prefix = folder ? normalizePath(folder) : "";
	let files = app.vault.getMarkdownFiles();
	if (prefix) {
		files = files.filter((f) => f.path.startsWith(prefix));
	}
	if (files.length === 0) {
		// Unterscheiden zwischen "Ordner existiert nicht" und "Ordner ist leer" —
		// sonst sehen beide Fälle für das Modell identisch aus und es zieht
		// falsche Schlüsse (z. B. eine veraltete Struktur-Referenz als reale,
		// aber leere Ordner interpretieren statt als nicht existent).
		if (prefix && !(app.vault.getAbstractFileByPath(prefix) instanceof TFolder)) {
			return `Ordner "${folder}" existiert nicht in diesem Vault.`;
		}
		return "Keine Notizen gefunden.";
	}

	// Dateigröße kommt aus Obsidians Metadaten (file.stat), OHNE den Inhalt zu
	// lesen — so kann das Modell leere/fast-leere Notizen direkt hier erkennen,
	// statt jede einzeln per read_note zu öffnen (teuer, sprengt schnell den
	// Kontext bei vielen Dateien).
	const lines = files.slice(0, MAX_LIST).map((f) => {
		const size = f.stat.size;
		const flag = size <= NEAR_EMPTY_BYTES ? "  ⚠ nahezu leer" : "";
		return `${f.path} (${size} B)${flag}`;
	});
	const more =
		files.length > MAX_LIST ? `\n… und ${files.length - MAX_LIST} weitere.` : "";
	return `${files.length} Notiz(en) mit Dateigröße (⚠ = ≤${NEAR_EMPTY_BYTES} Byte, vermutlich leer/nur Titel):\n${lines.join("\n")}${more}`;
}

async function readNote(app: App, path: string): Promise<string> {
	const file = app.vault.getAbstractFileByPath(asNotePath(path));
	if (!(file instanceof TFile)) {
		return `Fehler: Notiz "${path}" nicht gefunden.`;
	}
	const content = await app.vault.cachedRead(file);
	if (content.length > MAX_READ_CHARS) {
		return (
			content.slice(0, MAX_READ_CHARS) +
			`\n\n[… gekürzt, ${content.length - MAX_READ_CHARS} Zeichen ausgelassen]`
		);
	}
	return content || "(leere Notiz)";
}

/**
 * Normalisiert Text für tolerante Suche: Bindestriche, Unterstriche und Slashes
 * werden zu Leerzeichen, Mehrfach-Whitespace kollabiert. So findet
 * "recherche prompt" auch "Recherche-Prompt.md".
 */
function normalizeForSearch(s: string): string {
	return s
		.toLowerCase()
		.replace(/[-_/]+/g, " ")
		.replace(/\s+/g, " ");
}

async function searchVault(app: App, query: string): Promise<string> {
	if (!query?.trim()) return "Fehler: leerer Suchbegriff.";

	// In Suchwörter zerlegen — ALLE müssen vorkommen (AND), Reihenfolge/Trenner egal.
	const terms = normalizeForSearch(query)
		.split(" ")
		.filter((t) => t.length > 0);
	if (terms.length === 0) return "Fehler: leerer Suchbegriff.";

	const hits: string[] = [];
	for (const file of app.vault.getMarkdownFiles()) {
		if (hits.length >= MAX_SEARCH_HITS) break;

		const content = await app.vault.cachedRead(file);
		const hayName = normalizeForSearch(file.path);
		const hayContent = normalizeForSearch(content);

		// Treffer: alle Terme im Dateinamen ODER alle im Inhalt.
		const inName = terms.every((t) => hayName.includes(t));
		const inContent = terms.every((t) => hayContent.includes(t));
		if (!inName && !inContent) continue;

		// Snippet rund um den ersten Term-Treffer im Originaltext.
		const idx = content.toLowerCase().indexOf(terms[0]);
		let snippet = "";
		if (idx >= 0) {
			const start = Math.max(0, idx - 40);
			snippet = content
				.slice(start, idx + terms[0].length + 40)
				.replace(/\s+/g, " ")
				.trim();
		}
		hits.push(snippet ? `- ${file.path}: …${snippet}…` : `- ${file.path}`);
	}

	if (hits.length === 0) return `Keine Treffer für "${query}".`;
	return `${hits.length} Treffer für "${query}":\n${hits.join("\n")}`;
}

// --------------------------------------------------------------- Schreiben

async function createNote(
	app: App,
	path: string,
	content: string
): Promise<string> {
	const target = asNotePath(path);
	if (app.vault.getAbstractFileByPath(target)) {
		return `Fehler: "${target}" existiert bereits. Nutze edit_note oder append_to_note.`;
	}
	await ensureParentFolder(app, target);
	await app.vault.create(target, content ?? "");
	new Notice(`Euridian hat Notiz erstellt: ${target}`);
	return `Notiz "${target}" wurde erstellt.`;
}

async function appendToNote(
	app: App,
	path: string,
	content: string
): Promise<string> {
	const target = asNotePath(path);
	const file = app.vault.getAbstractFileByPath(target);

	if (file instanceof TFile) {
		await app.vault.append(file, "\n" + (content ?? ""));
		new Notice(`Euridian hat an Notiz angehängt: ${target}`);
		return `An "${target}" angehängt.`;
	}
	if (file instanceof TFolder) {
		return `Fehler: "${target}" ist ein Ordner.`;
	}
	// Existiert nicht → neu anlegen.
	await ensureParentFolder(app, target);
	await app.vault.create(target, content ?? "");
	new Notice(`Euridian hat Notiz erstellt: ${target}`);
	return `Notiz "${target}" existierte nicht und wurde erstellt.`;
}

async function editNote(
	app: App,
	path: string,
	content: string
): Promise<string> {
	const target = asNotePath(path);
	const file = app.vault.getAbstractFileByPath(target);

	if (file instanceof TFile) {
		await app.vault.modify(file, content ?? "");
		new Notice(`Euridian hat Notiz überschrieben: ${target}`);
		return `Inhalt von "${target}" wurde ersetzt.`;
	}
	if (file instanceof TFolder) {
		return `Fehler: "${target}" ist ein Ordner.`;
	}
	await ensureParentFolder(app, target);
	await app.vault.create(target, content ?? "");
	new Notice(`Euridian hat Notiz erstellt: ${target}`);
	return `Notiz "${target}" existierte nicht und wurde erstellt.`;
}
