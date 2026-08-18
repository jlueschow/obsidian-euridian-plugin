/**
 * Euridian — Backend-Auflösung.
 *
 * Die EINZIGE Stelle, die konkrete Backend-Details (URLs, Auth, Pfade) kennt.
 * Wandelt die Plugin-Einstellungen in einen generischen `ResolvedEndpoint` um,
 * mit dem der `EuridianApiClient` arbeitet. Neue lokale Backends werden hier
 * (und nur hier) ergänzt.
 */

import { EuridianError, PluginSettings, ResolvedEndpoint } from "./types";

/** Entfernt einen abschließenden Slash, damit Pfad-Joins sauber bleiben. */
function trimTrailingSlash(url: string): string {
	return url.replace(/\/+$/, "");
}

/**
 * Effektiver Thinking-Schalter für das aktive Backend. Ollama hat einen eigenen
 * (default AUS), weil lokale Reasoning-Modelle sonst minutenlang „denken".
 */
export function effectiveThinking(settings: PluginSettings): boolean {
	return settings.backend === "ollama"
		? settings.ollamaThinking
		: settings.enableThinking;
}

/**
 * Baut den Endpunkt für das aktuell gewählte Backend.
 * Wirft `EuridianError("bad_request", …)` bei offensichtlich fehlender Config,
 * damit der Nutzer einen klaren Hinweis statt eines Netzwerkfehlers bekommt.
 */
export function resolveEndpoint(settings: PluginSettings): ResolvedEndpoint {
	if (settings.backend === "ollama") {
		const base = trimTrailingSlash(
			settings.ollamaUrl || "http://localhost:11434"
		);
		if (!settings.ollamaModel) {
			throw new EuridianError(
				"bad_request",
				"Kein Ollama-Modell gewählt — in den Einstellungen festlegen."
			);
		}
		return {
			chatUrl: `${base}/v1/chat/completions`,
			modelsUrl: `${base}/v1/models`,
			headers: {},
			model: settings.ollamaModel,
			label: "Ollama",
		};
	}

	if (settings.backend === "custom") {
		const base = trimTrailingSlash(settings.customUrl.trim());
		if (!base) {
			throw new EuridianError(
				"bad_request",
				"Server-URL fehlt — in den Einstellungen eintragen."
			);
		}
		if (!settings.customModel) {
			throw new EuridianError(
				"bad_request",
				"Kein Modell gewählt — in den Einstellungen festlegen."
			);
		}
		const key = settings.customApiKey.trim();
		return {
			chatUrl: `${base}/v1/chat/completions`,
			modelsUrl: `${base}/v1/models`,
			headers: key ? { Authorization: `Bearer ${key}` } : {},
			model: settings.customModel,
			label: "Eigener Server",
		};
	}

	// --- Infomaniak Euria ---
	const key = settings.infomaniakApiKey.trim();
	const productId = settings.infomaniakProductId.trim();

	if (!key) {
		throw new EuridianError(
			"auth",
			"Infomaniak API-Key fehlt — in den Einstellungen eintragen."
		);
	}
	if (!productId) {
		throw new EuridianError(
			"bad_request",
			"Infomaniak Product-ID fehlt — in den Einstellungen eintragen."
		);
	}
	if (!settings.infomaniakModel) {
		throw new EuridianError(
			"bad_request",
			"Kein Infomaniak-Modell gewählt — in den Einstellungen festlegen."
		);
	}

	const base = "https://api.infomaniak.com";
	return {
		// Aktueller V2-Endpunkt (V1 ist deprecated).
		chatUrl: `${base}/2/ai/${productId}/openai/v1/chat/completions`,
		modelsUrl: `${base}/2/ai/${productId}/openai/v1/models`,
		headers: { Authorization: `Bearer ${key}` },
		model: settings.infomaniakModel,
		label: "Infomaniak Euria",
	};
}
