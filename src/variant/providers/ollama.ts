import { Provider } from "../../core/provider";
import { Notice, Setting } from "obsidian";
import { renderConnectionTest, SettingsHost } from "../../core/settings-host";
import { EuridianError } from "../../core/types";
import { trimTrailingSlash } from "./util";

export const ollamaProvider: Provider = {
	id: "ollama",
	label: "Ollama",
	lazyScan: true,
	resolve(s, model) {
		const base = trimTrailingSlash(s.ollamaUrl || "http://localhost:11434");
		if (!model) {
			throw new EuridianError(
				"bad_request",
				"Kein Ollama-Modell gewählt — in den Einstellungen festlegen."
			);
		}
		return {
			chatUrl: `${base}/v1/chat/completions`,
			modelsUrl: `${base}/v1/models`,
			headers: {},
			model,
			label: "Ollama",
		};
	},
	getModel: (s) => s.ollamaModel,
	setModel: (s, m) => {
		s.ollamaModel = m;
	},
	cachedModels: (s) => s.ollamaModels,
	storeModels: (s, names) => {
		s.ollamaModels = names;
	},
	renderSettings: renderOllamaSettings,
	thinking: (s) => s.ollamaThinking,
};

// ---------------------------------------------------------------- Settings-UI

export function renderOllamaSettings(host: SettingsHost): void {
	const { containerEl } = host;
	const s = host.plugin.settings;

	containerEl.createEl("h3", { text: "Ollama (lokal)" });

	new Setting(containerEl)
		.setName("Server-URL")
		.setDesc("Standard: http://localhost:11434")
		.addText((t) => {
			t.setPlaceholder("http://localhost:11434")
				.setValue(s.ollamaUrl)
				.onChange(async (v) => {
					s.ollamaUrl = v.trim();
					await host.plugin.saveSettings();
				});
			t.inputEl.autocomplete = "off";
		});

	renderOllamaModelSelector(host);
	renderOllamaScanButton(host);
	renderOllamaPreloadButton(host);
}

/** Modell-Auswahl für Ollama: Dropdown aus gescannter Liste, sonst Freitext. */
function renderOllamaModelSelector(host: SettingsHost): void {
	const { containerEl } = host;
	const s = host.plugin.settings;
	const list = s.ollamaModels;

	if (list.length === 0) {
		new Setting(containerEl)
			.setName("Modell")
			.setDesc("Noch nicht gescannt — unten „Modelle scannen“ klicken. Oder manuell:")
			.addText((t) => {
				t.setPlaceholder("qwen3")
					.setValue(s.ollamaModel)
					.onChange(async (v) => {
						s.ollamaModel = v.trim();
						await host.plugin.saveSettings();
					});
				// Freitext-Fallback vor dem ersten Scan — ohne autocomplete=off kann
				// der Browser hier eine völlig unabhängige gespeicherte Autofill-
				// Vorschlag (z. B. aus einem anderen Formular) einsetzen, die dann
				// als "aktuelles Modell" persistiert wird (siehe "Fleet Operator"-Fall).
				t.inputEl.autocomplete = "off";
			});
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
				await host.plugin.saveSettings();
			});
		});

	new Setting(host.containerEl)
		.setName("Thinking / Reasoning (Ollama)")
		.setDesc(
			"Lokale Reasoning-Modelle (z. B. qwen3.5) „denken“ sonst minutenlang " +
				"vor jeder Antwort — auch im Agenten. Standardmäßig AUS empfohlen."
		)
		.addToggle((t) =>
			t.setValue(s.ollamaThinking).onChange(async (v) => {
				s.ollamaThinking = v;
				await host.plugin.saveSettings();
			})
		);
}

/** Button: installierte Modelle vom Ollama-Server scannen (/v1/models). */
function renderOllamaScanButton(host: SettingsHost): void {
	const s = host.plugin.settings;
	const desc =
		s.ollamaModels.length > 0
			? `Aktuell bekannt: ${s.ollamaModels.join(", ")}`
			: "Liest die lokal installierten Modelle vom Server.";

	new Setting(host.containerEl)
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
						const models = await host.client.listModels({
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
						await host.plugin.saveSettings();
						new Notice(
							models.length
								? `✓ ${models.length} Modell(e) gefunden.`
								: "Keine Modelle gefunden — mit „ollama pull …“ eines laden."
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

/** Button: gewähltes Modell vorab in den Speicher laden (Preload/„warm"). */
function renderOllamaPreloadButton(host: SettingsHost): void {
	const s = host.plugin.settings;

	new Setting(host.containerEl)
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
						await host.client.preloadOllama(
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

