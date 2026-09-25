import { Provider } from "../../core/provider";
import { Notice, Setting } from "obsidian";
import { fetchCatalog } from "../model-catalog";
import { renderConnectionTest, SettingsHost } from "../../core/settings-host";
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
				"Infomaniak API-Key fehlt — in den Einstellungen eintragen."
			);
		}
		if (!productId) {
			throw new EuridianError(
				"bad_request",
				"Infomaniak Product-ID fehlt — in den Einstellungen eintragen."
			);
		}
		if (!model) {
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
			model,
			label: "Infomaniak Euria",
			offlineHint: "Internetverbindung prüfen.",
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
	usesSharedThinking: true,
	thinking: (s) => s.enableThinking,
};

// ---------------------------------------------------------------- Settings-UI

export function renderInfomaniakSettings(host: SettingsHost): void {
	const { containerEl } = host;
	const s = host.plugin.settings;

	containerEl.createEl("h3", { text: "Infomaniak Euria (Cloud)" });

	new Setting(containerEl)
		.setName("API-Key")
		.setDesc("kSuite → AI Tools → API-Token. Wird lokal in data.json gespeichert.")
		.addText((t) => {
			t.setPlaceholder("Bearer-Token")
				.setValue(s.infomaniakApiKey)
				.onChange(async (v) => {
					s.infomaniakApiKey = v.trim();
					await host.plugin.saveSettings();
				});
			// Key nicht im Klartext anzeigen.
			t.inputEl.type = "password";
		});

	new Setting(containerEl)
		.setName("Product-ID")
		.setDesc("Numerische ID deines AI-Tools-Produkts (GET /1/ai).")
		.addText((t) => {
			t.setPlaceholder("z. B. 12345")
				.setValue(s.infomaniakProductId)
				.onChange(async (v) => {
					s.infomaniakProductId = v.trim();
					await host.plugin.saveSettings();
				});
			t.inputEl.autocomplete = "off";
		});

	renderModelSelector(host);
	renderConnectionTest(host);
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
			.setName("Modell")
			.setDesc(
				"Noch keine Modell-Liste geladen. Unten „Modelle & Preise laden“ klicken."
			)
			.addText((t) => {
				t.setPlaceholder("mistralai/Mistral-Small-4-119B-2603")
					.setValue(s.infomaniakModel)
					.onChange(async (v) => {
						s.infomaniakModel = v.trim();
						await host.plugin.saveSettings();
					});
				t.inputEl.autocomplete = "off";
			});
		renderRefreshButton(host);
		return;
	}

	const availableCount = catalog.filter((e) => isAvailable(host, e)).length;

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
				await host.plugin.saveSettings();
				host.display();
			})
		);

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
		.setName("Modell")
		.setDesc("Live aus deinem Infomaniak-Konto + Tarif-Seite.")
		.addDropdown((dd) => {
			for (const entry of displayList) {
				dd.addOption(entry.name, modelLabel(host, entry));
			}
			// Falls das gespeicherte Modell nicht in der Anzeigeliste ist
			// (gefiltert oder nicht im Katalog), trotzdem als Option anbieten.
			if (!displayList.some((e) => e.name === s.infomaniakModel)) {
				dd.addOption(s.infomaniakModel, `${s.infomaniakModel} (gewählt)`);
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
	if (entry.status !== "ready") tags.push("bald");
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
function renderRefreshButton(host: SettingsHost): void {
	const s = host.plugin.settings;
	const desc =
		s.infomaniakCatalogFetchedAt > 0
			? `Zuletzt: ${new Date(s.infomaniakCatalogFetchedAt).toLocaleString("de-DE")}`
			: "Noch nie geladen.";

	new Setting(host.containerEl)
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
						await host.plugin.saveSettings();
						new Notice(`✓ ${catalog.length} Modell(e) geladen.`);
						host.display(); // UI mit Dropdown neu rendern
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

