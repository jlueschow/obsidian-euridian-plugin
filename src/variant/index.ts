/**
 * Euridian — Variante.
 *
 * Vertrag zwischen gemeinsamem Kern (src/core, identisch in beiden Plugins) und
 * Variante: Der Kern importiert von hier `PROVIDERS`, `DEFAULT_BACKEND` und
 * `VARIANT`, und aus `./settings` `ProviderSettings` + `PROVIDER_DEFAULTS`.
 * Alles, was sich zwischen Euridian (Euria) und Self-hosted LLM Vault Agent
 * unterscheidet, liegt in src/variant.
 */

import { Provider } from "../core/provider";
import { Backend } from "../core/types";
import { customProvider } from "./providers/custom";
import { infomaniakProvider } from "./providers/infomaniak";
import { ollamaProvider } from "./providers/ollama";

export const PROVIDERS: Provider[] = [
	ollamaProvider,
	customProvider,
	infomaniakProvider,
];

/** Backend, das in frischen Einstellungen vorausgewählt ist. */
export const DEFAULT_BACKEND: Backend = "ollama";

/** Name, Bezeichner und Texte, in denen sich die Varianten unterscheiden. */
export const VARIANT = {
	/** Anzeigename (View-Titel, Kopfzeile, Meldungen, Befehle). */
	name: "Euridian",
	/** Eindeutiger View-Typ — muss sich zwischen den Plugins unterscheiden. */
	viewType: "euridian-chat-view",
	/** Selbstvorstellung im System-Prompt. */
	intro: "Du bist Euridian, ein KI-Assistent direkt in Obsidian.",
	/** Vorbelegter Pfad der optionalen Instruktionsdatei im Vault. */
	defaultInstructionsPath: "Euria.md",
};
