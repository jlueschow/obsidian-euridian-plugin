/**
 * Euridian — Modell-Katalog für Infomaniak.
 *
 * Führt zwei Live-Quellen zusammen:
 *   1. `/1/ai/models`  → autoritative API-Namen (die im Request funktionieren),
 *                        Verfügbarkeit (info_status) und Beta-Status.
 *   2. Tarif-Seite (HTML) → Preise je 1M Token.
 *
 * Warum zwei Quellen? Die Developer-API liefert KEINE Preise, und die
 * Anzeigenamen auf der Tarif-Seite stimmen nicht immer mit den API-Namen
 * überein (z. B. "Apertus-70B-Instruct-2509" vs "swiss-ai/Apertus-70B-…").
 * Gematcht wird daher über das letzte Namenssegment.
 *
 * Beides via Obsidian `requestUrl` → umgeht CORS, kein Stream nötig.
 */

import { requestUrl } from "obsidian";
import { ApiModel, CatalogEntry, EuridianError, ModelPrice } from "./types";

const MODELS_URL =
	"https://api.infomaniak.com/1/ai/models?has_endpoint_contains=chat/completions";

/** Deutsche Tarif-Seite (Labels "Eingehendes/Ausgehendes Token" sind sprachabhängig). */
const TARIFE_URL = "https://www.infomaniak.com/de/hosting/ai-services/tarife";

/**
 * Baut den vollständigen Katalog: API-Modelle + zugeordnete Preise.
 * Preise sind "best effort" — schlägt der Tarif-Abruf fehl, kommen Modelle
 * trotzdem (nur ohne Preis) zurück.
 */
export async function fetchCatalog(apiKey: string): Promise<CatalogEntry[]> {
	const models = await fetchApiModels(apiKey);

	let prices: ModelPrice[] = [];
	try {
		prices = await fetchTarifePrices();
	} catch {
		// Preise sind optional — Tarif-Seite kann sich ändern / offline sein.
		prices = [];
	}

	return mergeCatalog(models, prices);
}

/** Ruft die LLM-Chat-Modelle der Infomaniak-API ab. */
async function fetchApiModels(apiKey: string): Promise<ApiModel[]> {
	let res;
	try {
		res = await requestUrl({
			url: MODELS_URL,
			method: "GET",
			headers: { Authorization: `Bearer ${apiKey}` },
			throw: false,
		});
	} catch {
		throw new EuridianError(
			"offline",
			"Infomaniak nicht erreichbar — Internetverbindung prüfen."
		);
	}

	if (res.status === 401 || res.status === 403) {
		throw new EuridianError(
			"auth",
			"Infomaniak: API-Key ungültig — bitte prüfen.",
			res.status
		);
	}
	if (res.status >= 400) {
		throw new EuridianError(
			"unknown",
			`Infomaniak: HTTP ${res.status} beim Abrufen der Modelle.`,
			res.status
		);
	}

	const data = res.json?.data;
	if (!Array.isArray(data)) return [];

	return data
		.filter((m: { type?: string }) => m.type === "llm")
		.map(
			(m: {
				name?: string;
				info_status?: string;
				max_token_input?: number | null;
				meta?: { is_beta?: boolean };
			}): ApiModel => ({
				name: m.name ?? "",
				status: m.info_status ?? "unknown",
				beta: m.meta?.is_beta ?? false,
				maxTokenInput: m.max_token_input ?? null,
			})
		)
		.filter((m: ApiModel) => m.name.length > 0);
}

/** Lädt die Tarif-Seite und extrahiert die Preise je Modell. */
async function fetchTarifePrices(): Promise<ModelPrice[]> {
	const res = await requestUrl({ url: TARIFE_URL, method: "GET", throw: false });
	if (res.status >= 400 || !res.text) return [];
	return parsePrices(res.text);
}

/**
 * Parst die (server-gerenderte) Tarif-Seite.
 * Muster pro Modell:
 *   "<Name> Eingehendes Token: <CUR> <Betrag> / 1M tokens
 *           Ausgehendes Token: <CUR> <Betrag> / 1M tokens"
 */
export function parsePrices(html: string): ModelPrice[] {
	// HTML-Tags entfernen, Whitespace normalisieren → gut parsebarer Fließtext.
	const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

	const re =
		/([\w./+-]+?)\s+Eingehendes Token:\s*([A-Z]{3})\s*([\d.]+)\s*\/\s*1M tokens\s*Ausgehendes Token:\s*([A-Z]{3})\s*([\d.]+)\s*\/\s*1M tokens/gi;

	const result: ModelPrice[] = [];
	const seen = new Set<string>();
	let m: RegExpExecArray | null;

	while ((m = re.exec(text)) !== null) {
		const displayName = m[1];
		if (seen.has(displayName)) continue;
		seen.add(displayName);

		result.push({
			displayName,
			currency: m[2].toUpperCase(),
			inputPerM: Number(m[3]),
			outputPerM: Number(m[5]),
		});
	}
	return result;
}

/** Letztes Namenssegment, kleingeschrieben — für den Preis-Match. */
function matchKey(name: string): string {
	const parts = name.split("/");
	return parts[parts.length - 1].toLowerCase();
}

/** Ordnet jedem API-Modell (falls vorhanden) seinen Preis zu. */
function mergeCatalog(
	models: ApiModel[],
	prices: ModelPrice[]
): CatalogEntry[] {
	const priceByKey = new Map<string, ModelPrice>();
	for (const p of prices) priceByKey.set(matchKey(p.displayName), p);

	return models.map((m) => ({
		name: m.name,
		status: m.status,
		beta: m.beta,
		maxTokenInput: m.maxTokenInput,
		price: priceByKey.get(matchKey(m.name)) ?? null,
	}));
}
