import { Provider } from "../../core/provider";
import { Notice, Setting } from "obsidian";
import { renderConnectionTest, SettingsHost } from "../../core/settings-host";
import { EuridianError } from "../../core/types";
import { trimTrailingSlash } from "./util";

export const customProvider: Provider = {
	id: "custom",
	label: "Eigener Server",
	lazyScan: true,
	resolve(s, model) {
		const base = trimTrailingSlash(s.customUrl.trim());
		if (!base) {
			throw new EuridianError(
				"bad_request",
				"Server-URL fehlt — in den Einstellungen eintragen."
			);
		}
		if (!model) {
			throw new EuridianError(
				"bad_request",
				"Kein Modell gewählt — in den Einstellungen festlegen."
			);
		}
		const key = s.customApiKey.trim();
		const headers: Record<string, string> = {};
		if (key) headers.Authorization = `Bearer ${key}`;
		return {
			chatUrl: `${base}/v1/chat/completions`,
			modelsUrl: `${base}/v1/models`,
			headers,
			model,
			label: "Eigener Server",
		};
	},
	getModel: (s) => s.customModel,
	setModel: (s, m) => {
		s.customModel = m;
	},
	cachedModels: (s) => s.customModels,
	storeModels: (s, names) => {
		s.customModels = names;
	},
	renderSettings: renderCustomSettings,
	thinking: (s) => s.enableThinking,
};

// ---------------------------------------------------------------- Settings-UI

/** Eigener OpenAI-kompatibler Server (z. B. Hochschul-/Firmennetz). */
export function renderCustomSettings(host: SettingsHost): void {
	const { containerEl } = host;
	const s = host.plugin.settings;

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
		.addText((t) => {
			t.setPlaceholder("https://llm.example.org")
				.setValue(s.customUrl)
				.onChange(async (v) => {
					s.customUrl = v.trim();
					await host.plugin.saveSettings();
				});
			t.inputEl.autocomplete = "off";
		});

	new Setting(containerEl)
		.setName("API-Key")
		.setDesc("Nur falls der Server Authentifizierung verlangt. Sonst leer lassen.")
		.addText((t) => {
			t.setPlaceholder("Bearer-Token (optional)")
				.setValue(s.customApiKey)
				.onChange(async (v) => {
					s.customApiKey = v.trim();
					await host.plugin.saveSettings();
				});
			t.inputEl.type = "password";
		});

	renderCustomModelSelector(host);
	renderCustomScanButton(host);
	renderConnectionTest(host);
}

/** Modell-Auswahl für den eigenen Server: Dropdown aus gescannter Liste, sonst Freitext. */
function renderCustomModelSelector(host: SettingsHost): void {
	const { containerEl } = host;
	const s = host.plugin.settings;
	const list = s.customModels;

	if (list.length === 0) {
		new Setting(containerEl)
			.setName("Modell")
			.setDesc("Noch nicht gescannt — unten „Modelle scannen“ klicken. Oder manuell:")
			.addText((t) => {
				t.setPlaceholder("Modellname")
					.setValue(s.customModel)
					.onChange(async (v) => {
						s.customModel = v.trim();
						await host.plugin.saveSettings();
					});
				// Siehe Kommentar bei der Ollama-Variante oben — gleicher Grund.
				t.inputEl.autocomplete = "off";
			});
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
				await host.plugin.saveSettings();
			});
		});
}

/** Button: Modelle vom eigenen Server scannen (/v1/models). */
function renderCustomScanButton(host: SettingsHost): void {
	const s = host.plugin.settings;
	const desc =
		s.customModels.length > 0
			? `Aktuell bekannt: ${s.customModels.join(", ")}`
			: "Liest die verfügbaren Modelle vom Server (falls unterstützt).";

	new Setting(host.containerEl)
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
						const models = await host.client.listModels({
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
						await host.plugin.saveSettings();
						new Notice(
							models.length
								? `✓ ${models.length} Modell(e) gefunden.`
								: "Keine Modelle gefunden — Modellname manuell eintragen."
						);
						host.display();
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

