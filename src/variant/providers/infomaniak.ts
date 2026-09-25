import { Provider } from "../../core/provider";
import { Notice, Setting } from "obsidian";
import { fetchCatalog } from "../model-catalog";
import { renderConnectionTest, SettingsHost } from "../../core/settings-host";
import { t } from "../../core/i18n";
import { EuridianError } from "../../core/types";
import { CatalogEntry } from "../settings";

export const infomaniakProvider: Provider = {
	id: "infomaniak",
	label: "Infomaniak Euria",
	lazyScan: false,
	resolve(s, model) {
		const key = s.infomaniakApiKey.trim();
		const productId = s.infomaniakProductId.trim();
		if (!key) {
			throw new EuridianError(
				"auth",
				t("Infomaniak API key is missing. Enter it in the settings.")
			);
		}
		if (!productId) {
			throw new EuridianError(
				"bad_request",
				t("Infomaniak product ID is missing. Enter it in the settings.")
			);
		}
		if (!model) {
			throw new EuridianError(
				"bad_request",
				t("No Infomaniak model selected. Choose one in the settings.")
			);
		}
		const base = "https://api.infomaniak.com";
		return {
			// Aktueller V2-Endpunkt (V1 ist deprecated).
			chatUrl: `${base}/2/ai/${productId}/openai/v1/chat/completions`,
			modelsUrl: `${base}/2/ai/${productId}/openai/v1/models`,
			headers: { Authorization: `Bearer ${key}` },
			model,
			label: "Infomaniak Euria",
			offlineHint: t("Check your internet connection."),
		};
	},
	getModel: (s) => s.infomaniakModel,
	setModel: (s, m) => {
		s.infomaniakModel = m;
	},
	// Nur verfügbare ("ready") Modelle aus dem Katalog.
	cachedModels: (s) =>
		s.infomaniakCatalog.filter((e) => e.status === "ready").map((e) => e.name),
	storeModels: () => {
		// Der Katalog wird ausschließlich im Settings-Tab geladen.
	},
	renderSettings: renderInfomaniakSettings,
	renderAdvancedSettings: renderInfomaniakAdvanced,
	usesSharedThinking: true,
	thinking: (s) => s.enableThinking,
};

// ---------------------------------------------------------------- Settings-UI

export function renderInfomaniakSettings(host: SettingsHost): void {
	const { containerEl } = host;
	const s = host.plugin.settings;

	new Setting(containerEl)
		.setName(t("API key"))
		.setDesc(t("kSuite → AI Tools → API token. Stored locally in data.json."))
		.addText((tg) => {
			tg.setPlaceholder(t("Bearer token"))
				.setValue(s.infomaniakApiKey)
				.onChange(async (v) => {
					s.infomaniakApiKey = v.trim();
					await host.plugin.saveSettings();
				});
			// Key nicht im Klartext anzeigen.
			tg.inputEl.type = "password";
		});

	new Setting(containerEl)
		.setName(t("Product ID"))
		.setDesc(t("Numeric ID of your AI Tools product (GET /1/ai)."))
		.addText((tg) => {
			tg.setPlaceholder(t("e.g. 12345"))
				.setValue(s.infomaniakProductId)
				.onChange(async (v) => {
					s.infomaniakProductId = v.trim();
					await host.plugin.saveSettings();
				});
			tg.inputEl.autocomplete = "off";
		});

	renderModelSelector(host);
	renderConnectionTest(host);
}

/** Selten nötig: Modellliste auf verfügbare Modelle einschränken. */
function renderInfomaniakAdvanced(host: SettingsHost): void {
	const s = host.plugin.settings;
	const catalog = s.infomaniakCatalog;
	if (catalog.length === 0) return;
	const availableCount = catalog.filter((e) => isAvailable(host, e)).length;

	new Setting(host.containerEl)
		.setName(t("Show only available models"))
		.setDesc(
			t(
				'{available} of {total} models are currently usable ("soon" = announced by Infomaniak, not yet enabled).',
				{ available: availableCount, total: catalog.length }
			)
		)
		.addToggle((tg) =>
			tg.setValue(s.infomaniakOnlyAvailable).onChange(async (v) => {
				s.infomaniakOnlyAvailable = v;
				await host.plugin.saveSettings();
				host.display();
			})
		);
}

/**
 * Modell-Auswahl für Infomaniak: Dropdown aus dem gecachten Katalog
 * (API-Modelle + Tarif-Preise), Preiszeile darunter, Aktualisieren-Button.
 * Fällt auf ein Freitextfeld zurück, wenn noch kein Katalog geladen ist.
 */
/** Ein Modell ist nutzbar, wenn die API es als "ready" meldet. */
function isAvailable(host: SettingsHost, entry: CatalogEntry): boolean {
	return entry.status === "ready";
}

function renderModelSelector(host: SettingsHost): void {
	const { containerEl } = host;
	const s = host.plugin.settings;
	const catalog = s.infomaniakCatalog;

	if (catalog.length === 0) {
		// Noch kein Katalog → Freitext, damit der Nutzer nicht blockiert ist.
		new Setting(containerEl)
			.setName(t("Model"))
			.setDesc(t("No model list loaded yet. Click \"Load models and prices\" below."))
			.addText((tg) => {
				tg.setPlaceholder("mistralai/Mistral-Small-4-119B-2603")
					.setValue(s.infomaniakModel)
					.onChange(async (v) => {
						s.infomaniakModel = v.trim();
						await host.plugin.saveSettings();
					});
				tg.inputEl.autocomplete = "off";
			});
		renderRefreshButton(host);
		return;
	}

	// Anzeigeliste: optional gefiltert, immer „verfügbar zuerst", dann nach Preis.
	const displayList = catalog
		.filter((e) => !s.infomaniakOnlyAvailable || isAvailable(host, e))
		.sort((a, b) => {
			const av = isAvailable(host, a) ? 0 : 1;
			const bv = isAvailable(host, b) ? 0 : 1;
			if (av !== bv) return av - bv;
			const ap = a.price?.outputPerM ?? Number.POSITIVE_INFINITY;
			const bp = b.price?.outputPerM ?? Number.POSITIVE_INFINITY;
			return ap - bp;
		});

	// Element für die Preiszeile (wird bei Auswahl aktualisiert).
	const priceEl = createDiv({ cls: "euridian-price-info" });

	new Setting(containerEl)
		.setName(t("Model"))
		.setDesc(t("Live from your Infomaniak account and the price page."))
		.addDropdown((dd) => {
			for (const entry of displayList) {
				dd.addOption(entry.name, modelLabel(host, entry));
			}
			// Falls das gespeicherte Modell nicht in der Anzeigeliste ist
			// (gefiltert oder nicht im Katalog), trotzdem als Option anbieten.
			if (!displayList.some((e) => e.name === s.infomaniakModel)) {
				dd.addOption(s.infomaniakModel, t("{model} (selected)", { model: s.infomaniakModel }));
			}
			dd.setValue(s.infomaniakModel).onChange(async (v) => {
				s.infomaniakModel = v;
				await host.plugin.saveSettings();
				updatePriceLine(host, priceEl, v);
			});
		});

	containerEl.appendChild(priceEl);
	updatePriceLine(host, priceEl, s.infomaniakModel);

	renderRefreshButton(host);
}

/** Dropdown-Label inkl. Status-/Beta-Markierung. */
function modelLabel(host: SettingsHost, entry: CatalogEntry): string {
	const tags: string[] = [];
	if (entry.status !== "ready") tags.push(t("soon"));
	if (entry.beta) tags.push("beta");
	return tags.length ? `${entry.name} · ${tags.join(", ")}` : entry.name;
}

/** Schreibt die Preiszeile für ein Modell in das gegebene Element. */
function updatePriceLine(host: SettingsHost, el: HTMLElement, modelName: string): void {
	el.empty();
	const entry = host.plugin.settings.infomaniakCatalog.find(
		(e) => e.name === modelName
	);

	if (!entry?.price) {
		el.createSpan({
			cls: "euridian-price-muted",
			text: t("Price not available."),
		});
		return;
	}

	const p = entry.price;
	el.createSpan({
		text: t("Input: {currency} {input} · Output: {currency} {output} per 1M tokens", {
			currency: p.currency,
			input: p.inputPerM.toFixed(2),
			output: p.outputPerM.toFixed(2),
		}),
	});
	if (entry.maxTokenInput) {
		el.createSpan({
			cls: "euridian-price-muted",
			text: `  ·  ${t("Context: {count} tokens", { count: entry.maxTokenInput.toLocaleString() })}`,
		});
	}
}

/** Button, der Modelle (API) + Preise (Tarif-Seite) neu lädt. */
function renderRefreshButton(host: SettingsHost): void {
	const s = host.plugin.settings;
	const desc =
		s.infomaniakCatalogFetchedAt > 0
			? t("Last loaded: {date}", { date: new Date(s.infomaniakCatalogFetchedAt).toLocaleString() })
			: t("Never loaded.");

	new Setting(host.containerEl)
		.setName(t("Load models and prices"))
		.setDesc(desc)
		.addButton((btn) =>
			btn
				.setButtonText(t("Refresh"))
				.onClick(async () => {
					if (!s.infomaniakApiKey.trim()) {
						new Notice(t("Enter the API key first."));
						return;
					}
					btn.setDisabled(true).setButtonText(t("Loading …"));
					try {
						const catalog = await fetchCatalog(s.infomaniakApiKey.trim());
						s.infomaniakCatalog = catalog;
						s.infomaniakCatalogFetchedAt = Date.now();
						// Falls aktuelles Modell nicht im Katalog: erstes „ready“ wählen.
						if (!catalog.some((e) => e.name === s.infomaniakModel)) {
							const firstReady = catalog.find((e) => e.status === "ready");
							if (firstReady) s.infomaniakModel = firstReady.name;
						}
						await host.plugin.saveSettings();
						new Notice(t("✓ {count} model(s) loaded.", { count: catalog.length }));
						host.display(); // UI mit Dropdown neu rendern
					} catch (err) {
						const msg =
							err instanceof EuridianError
								? err.message
								: t("Unknown error: {error}", { error: String(err) });
						new Notice(`✕ ${msg}`, 8000);
					} finally {
						btn.setDisabled(false).setButtonText(t("Refresh"));
					}
				})
		);
}

