/**
 * Euridian — Variante.
 *
 * Variante: Euridian (Infomaniak Euria).
 *
 * Vertrag zwischen gemeinsamem Kern (src/core, identisch in beiden Plugins) und
 * Variante: Der Kern importiert von hier `PROVIDERS`, `DEFAULT_BACKEND` und
 * `VARIANT`, und aus `./settings` `ProviderSettings` + `PROVIDER_DEFAULTS`.
 * Alles, was sich zwischen Euridian (Euria) und Self-hosted LLM Vault Agent
 * unterscheidet, liegt in src/variant.
 */

import { Provider } from "../core/provider";
import { Backend } from "../core/types";
import { infomaniakProvider } from "./providers/infomaniak";

export const PROVIDERS: Provider[] = [infomaniakProvider];

/** Backend, das in frischen Einstellungen vorausgewählt ist. */
export const DEFAULT_BACKEND: Backend = infomaniakProvider.id;

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

/**
 * Wird auf den rohen Inhalt von data.json angewendet, bevor Settings und
 * Sessions daraus gelesen werden. Hier landen Umbenennungen von Feldern und
 * Backend-IDs (auch in `__euridianSessions[].modelRef`).
 */
export function migrateData(data: Record<string, unknown>): Record<string, unknown> {
	// Ollama und eigene Server gibt es hier nicht mehr (Plugin „Self-hosted LLM
	// Vault Agent“). Ihre alten Felder bleiben in data.json liegen, damit sie
	// dorthin übernommen werden können; Backend und Chat-Verweise werden auf
	// Infomaniak umgestellt.
	const out: Record<string, unknown> = { ...data };
	if (out.backend !== infomaniakProvider.id) out.backend = infomaniakProvider.id;
	const sessions = out.__euridianSessions as
		| { tabs?: { modelRef?: { backend?: string } }[] }
		| undefined;
	for (const tab of sessions?.tabs ?? []) {
		if (tab.modelRef && tab.modelRef.backend !== infomaniakProvider.id) {
			delete tab.modelRef;
		}
	}
	return out;
}
