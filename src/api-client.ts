/**
 * Euridian — generischer OpenAI-kompatibler API-Client.
 *
 * Kennt KEINE konkreten Backends. Er bekommt einen `ResolvedEndpoint`
 * (URL + Header + Modell) und spricht das standardisierte
 * `/chat/completions`-Protokoll. Dadurch funktioniert exakt derselbe Code
 * für Infomaniak Euria, lokales Ollama und jedes weitere OpenAI-kompatible
 * Backend.
 *
 * STREAMING-STRATEGIE:
 *   Die Infomaniak-API sendet KEINE CORS-Header. Ein Browser-`fetch` aus dem
 *   Obsidian-Renderer (Origin `app://obsidian.md`) wird daher blockiert. Wir
 *   streamen deshalb über Node's `http`/`https` (Desktop/Electron) — das ist
 *   kein Browser-Request, also CORS-frei, liefert echtes Token-Streaming und
 *   macht bei Ollama auch `OLLAMA_ORIGINS` überflüssig.
 *
 *   Fällt Node weg (z. B. Obsidian Mobile), nutzen wir `requestUrl` als
 *   Fallback: zuverlässig, aber ohne echtes Streaming (Antwort kommt am Stück).
 *
 *   Verbindungstest/Modell-Liste laufen immer über `requestUrl`.
 */

import { requestUrl } from "obsidian";
import {
	ApiMessage,
	EuridianError,
	EuridianErrorKind,
	ResolvedEndpoint,
	StreamCallbacks,
	StreamChunk,
	StreamResult,
	ToolCall,
	ToolDefinition,
	TokenUsage,
} from "./types";

/** Akkumulator für einen Streaming-Turn (Text + zusammengesetzte Tool-Calls). */
interface StreamAccumulator {
	content: string;
	toolCalls: Map<number, { id: string; name: string; args: string }>;
}

export class EuridianApiClient {
	/**
	 * Streamt eine Chat-Completion. Liefert Text-Deltas über `callbacks.onToken`
	 * und am Ende optional Usage über `callbacks.onUsage`.
	 */
	async streamChat(
		endpoint: ResolvedEndpoint,
		messages: ApiMessage[],
		enableThinking: boolean,
		temperature: number,
		callbacks: StreamCallbacks,
		tools?: ToolDefinition[]
	): Promise<StreamResult> {
		const body: Record<string, unknown> = {
			model: endpoint.model,
			messages,
			stream: true,
			temperature,
			stream_options: { include_usage: true },
		};
		// reasoning_effort nur senden, wenn Thinking AUS soll UND das Modell es
		// unterstützt. Mistral-Tokenizer (Mistral/Ministral/Mixtral/Magistral)
		// lehnen es mit 400 ab: "chat_template is not supported for Mistral
		// tokenizers". Diese Modelle haben ohnehin keinen Reasoning-Modus.
		if (!enableThinking && this.supportsReasoningEffort(endpoint.model)) {
			body.reasoning_effort = "none";
		}
		const hasTools = !!(tools && tools.length > 0);
		if (hasTools) {
			body.tools = tools;
			body.tool_choice = "auto";
		}

		// Manche Modelle (z. B. swiss-ai/Apertus) liefern Function-Calls NUR im
		// Non-Streaming-Modus. Beim Streamen ignorieren sie die Tools und
		// halluzinieren stattdessen einen Fließtext. Sind Tools aktiv und das
		// Modell streamt keine Tool-Calls → bewusst non-streaming anfragen.
		if (hasTools && !this.streamsToolCalls(endpoint.model)) {
			return this.requestNonStreaming(endpoint, body, callbacks);
		}

		const bodyStr = JSON.stringify(body);

		const nodeHttp = this.getNodeHttp(endpoint.chatUrl);
		if (nodeHttp) {
			return this.streamViaNode(nodeHttp, endpoint, bodyStr, callbacks);
		}
		// Mobile/kein Node: nicht-streamender Fallback.
		return this.requestNonStreaming(endpoint, body, callbacks);
	}

	/**
	 * Ob das Modell den `reasoning_effort`-Parameter verträgt. Mistral-Tokenizer
	 * (Mistral/Ministral/Mixtral/Magistral) lehnen ihn mit 400 ab.
	 */
	private supportsReasoningEffort(model: string): boolean {
		return !/(mistral|ministral|mixtral|magistral)/i.test(model);
	}

	/**
	 * Ob das Modell Function-Calls im Streaming-Modus liefert. Apertus liefert
	 * sie nur non-streaming (empirisch gegen die Infomaniak-API verifiziert:
	 * streamend 0 tool_calls, non-streamend korrekt). Für solche Modelle umgeht
	 * `streamChat` das Streaming, sobald Tools aktiv sind.
	 */
	private streamsToolCalls(model: string): boolean {
		return !/apertus/i.test(model);
	}

	/** Erzeugt einen leeren Akkumulator. */
	private newAccumulator(): StreamAccumulator {
		return { content: "", toolCalls: new Map() };
	}

	/** Wandelt den Akkumulator in das finale StreamResult um. */
	private buildResult(acc: StreamAccumulator): StreamResult {
		const toolCalls: ToolCall[] = [...acc.toolCalls.entries()]
			.sort((a, b) => a[0] - b[0])
			.map(([, tc]) => ({
				id: tc.id,
				type: "function" as const,
				function: { name: tc.name, arguments: tc.args },
			}))
			.filter((tc) => tc.function.name);
		return { content: acc.content, toolCalls };
	}

	// ----------------------------------------------------- Node-Streaming (primär)

	/** Lädt Node's `http`/`https`-Modul passend zum Protokoll, oder null. */
	private getNodeHttp(url: string): NodeHttpModule | null {
		try {
			// `require` existiert im Electron-Renderer, nicht auf Mobile.
			if (typeof require === "undefined") return null;
			const isHttps = url.startsWith("https:");
			return require(isHttps ? "https" : "http") as NodeHttpModule;
		} catch {
			return null;
		}
	}

	/** Echtes Streaming über Node's http(s).request — CORS-frei. */
	private streamViaNode(
		mod: NodeHttpModule,
		endpoint: ResolvedEndpoint,
		bodyStr: string,
		callbacks: StreamCallbacks
	): Promise<StreamResult> {
		return new Promise<StreamResult>((resolve, reject) => {
			let url: URL;
			try {
				url = new URL(endpoint.chatUrl);
			} catch {
				reject(
					new EuridianError("bad_request", `Ungültige URL: ${endpoint.chatUrl}`)
				);
				return;
			}

			const acc = this.newAccumulator();

			const req = mod.request(
				{
					hostname: url.hostname,
					port: url.port || (url.protocol === "https:" ? 443 : 80),
					path: url.pathname + url.search,
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"Content-Length": Buffer.byteLength(bodyStr),
						...endpoint.headers,
					},
				},
				(res) => {
					const status = res.statusCode ?? 0;

					if (status >= 400) {
						// Fehler-Body sammeln, dann strukturierten Fehler werfen.
						res.setEncoding("utf8");
						let errText = "";
						res.on("data", (c) => (errText += String(c)));
						res.on("end", () =>
							reject(this.mapHttpError(status, errText, endpoint))
						);
						return;
					}

					res.setEncoding("utf8");
					let buffer = "";
					res.on("data", (chunk) => {
						buffer = this.processSseBuffer(
							buffer + String(chunk),
							callbacks,
							acc
						);
					});
					res.on("end", () => {
						if (buffer.trim()) this.handleSseLine(buffer.trim(), callbacks, acc);
						resolve(this.buildResult(acc));
					});
					res.on("error", (err) =>
						reject(
							new EuridianError(
								"unknown",
								`Stream-Fehler: ${(err as Error)?.message ?? "unbekannt"}`
							)
						)
					);
				}
			);

			req.on("error", (err: Error) => {
				if (callbacks.signal?.aborted) {
					reject(new EuridianError("aborted", "Anfrage abgebrochen."));
				} else {
					reject(
						new EuridianError(
							"offline",
							`${endpoint.label} ist nicht erreichbar. ` +
								this.offlineHint(endpoint) +
								` (${err.message})`
						)
					);
				}
			});

			// Abbruch von außen.
			if (callbacks.signal) {
				callbacks.signal.addEventListener("abort", () => req.destroy(), {
					once: true,
				});
			}

			req.write(bodyStr);
			req.end();
		});
	}

	// ------------------------------------------------ requestUrl-Fallback (mobile)

	/** Nicht-streamender Fallback: ganze Antwort holen, dann als ein Block liefern. */
	private async requestNonStreaming(
		endpoint: ResolvedEndpoint,
		body: Record<string, unknown>,
		callbacks: StreamCallbacks
	): Promise<StreamResult> {
		// Ohne echtes Streaming brauchen wir den Stream-Modus nicht.
		const payload = { ...body, stream: false, stream_options: undefined };

		let res;
		try {
			res = await requestUrl({
				url: endpoint.chatUrl,
				method: "POST",
				headers: { "Content-Type": "application/json", ...endpoint.headers },
				body: JSON.stringify(payload),
				throw: false,
			});
		} catch {
			throw new EuridianError(
				"offline",
				`${endpoint.label} ist nicht erreichbar. ${this.offlineHint(endpoint)}`
			);
		}

		if (res.status >= 400) {
			throw this.mapHttpError(res.status, res.text ?? "", endpoint);
		}

		const message = res.json?.choices?.[0]?.message;
		const content: string = message?.content ?? "";
		if (content) callbacks.onToken(content);

		if (res.json?.usage && callbacks.onUsage) {
			callbacks.onUsage(this.mapUsage(res.json.usage));
		}

		// Tool-Calls aus der nicht-gestreamten Antwort übernehmen.
		const toolCalls: ToolCall[] = Array.isArray(message?.tool_calls)
			? message.tool_calls.map(
					(tc: {
						id?: string;
						function?: { name?: string; arguments?: string };
					}) => ({
						id: tc.id ?? "",
						type: "function" as const,
						function: {
							name: tc.function?.name ?? "",
							arguments: tc.function?.arguments ?? "",
						},
					})
			  )
			: [];

		return { content, toolCalls };
	}

	// ------------------------------------------------------------- SSE-Verarbeitung

	/**
	 * Verarbeitet alle vollständigen Zeilen im Puffer und gibt den Rest zurück.
	 * Robust gegen über Chunk-Grenzen zerteilte Zeilen.
	 */
	private processSseBuffer(
		buffer: string,
		callbacks: StreamCallbacks,
		acc: StreamAccumulator
	): string {
		let newlineIndex: number;
		while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
			const line = buffer.slice(0, newlineIndex).trim();
			buffer = buffer.slice(newlineIndex + 1);
			this.handleSseLine(line, callbacks, acc);
		}
		return buffer;
	}

	/** Verarbeitet eine SSE-Zeile (`data: {...}` oder `data: [DONE]`). */
	private handleSseLine(
		line: string,
		callbacks: StreamCallbacks,
		acc: StreamAccumulator
	): void {
		if (!line.startsWith("data:")) return;

		const payload = line.slice("data:".length).trim();
		if (payload === "[DONE]" || payload === "") return;

		let chunk: StreamChunk;
		try {
			chunk = JSON.parse(payload);
		} catch {
			return; // Keep-Alive / unvollständiges JSON ignorieren.
		}

		const delta = chunk.choices?.[0]?.delta;

		if (delta?.content) {
			acc.content += delta.content;
			callbacks.onToken(delta.content);
		}

		// Tool-Calls über mehrere Chunks zusammensetzen (pro index).
		if (delta?.tool_calls) {
			for (const tc of delta.tool_calls) {
				const cur = acc.toolCalls.get(tc.index) ?? {
					id: "",
					name: "",
					args: "",
				};
				if (tc.id) cur.id = tc.id;
				if (tc.function?.name) cur.name = tc.function.name;
				if (tc.function?.arguments) cur.args += tc.function.arguments;
				acc.toolCalls.set(tc.index, cur);
			}
		}

		if (chunk.usage && callbacks.onUsage) {
			callbacks.onUsage(this.mapUsage(chunk.usage));
		}
	}

	private mapUsage(raw: {
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
	}): TokenUsage {
		return {
			promptTokens: raw.prompt_tokens ?? 0,
			completionTokens: raw.completion_tokens ?? 0,
			totalTokens: raw.total_tokens ?? 0,
		};
	}

	// ------------------------------------------------------------- Modell-Liste

	/**
	 * Testet die Verbindung über die Modell-Liste. Nutzt `requestUrl`.
	 * @returns Liste der Modell-IDs (kann leer sein).
	 */
	async listModels(endpoint: ResolvedEndpoint): Promise<string[]> {
		let res;
		try {
			res = await requestUrl({
				url: endpoint.modelsUrl,
				method: "GET",
				headers: endpoint.headers,
				throw: false,
			});
		} catch {
			throw new EuridianError(
				"offline",
				`${endpoint.label} ist nicht erreichbar. ${this.offlineHint(endpoint)}`
			);
		}

		if (res.status >= 400) {
			throw this.mapHttpError(res.status, res.text ?? "", endpoint);
		}

		const data = res.json?.data;
		if (!Array.isArray(data)) return [];
		return data
			.map((m: { id?: string }) => m.id)
			.filter((id): id is string => typeof id === "string");
	}

	/**
	 * Lädt ein Ollama-Modell vorab in den Speicher — über Ollamas native Route
	 * `/api/generate` mit leerem Prompt. Die lädt nur und generiert NICHTS;
	 * die OpenAI-Chat-Route würde bei Reasoning-Modellen (z. B. qwen3.5) erst
	 * lange „denken". Wirft bei Fehler.
	 */
	async preloadOllama(baseUrl: string, model: string): Promise<void> {
		const base = baseUrl.replace(/\/+$/, "");
		let res;
		try {
			res = await requestUrl({
				url: `${base}/api/generate`,
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model, prompt: "", stream: false }),
				throw: false,
			});
		} catch {
			throw new EuridianError(
				"offline",
				"Ollama ist nicht erreichbar. Läuft der Server? (`ollama serve`)"
			);
		}
		if (res.status >= 400) {
			throw new EuridianError(
				"bad_request",
				`Ollama: Modell „${model}“ konnte nicht geladen werden (HTTP ${res.status}).`
			);
		}
	}

	// ------------------------------------------------------------- Fehler-Mapping

	/** Mappt HTTP-Status + Detailtext auf einen strukturierten Fehler. */
	private mapHttpError(
		status: number,
		detail: string,
		endpoint: ResolvedEndpoint
	): EuridianError {
		const kindByStatus: Record<number, EuridianErrorKind> = {
			400: "bad_request",
			401: "auth",
			403: "auth",
			404: "not_found",
			429: "rate_limit",
		};
		const kind: EuridianErrorKind = kindByStatus[status] ?? "unknown";

		switch (kind) {
			case "auth":
				return new EuridianError(
					"auth",
					`${endpoint.label}: Authentifizierung fehlgeschlagen — API-Key / Product-ID prüfen.`,
					status
				);
			case "not_found":
				return new EuridianError(
					"not_found",
					`${endpoint.label}: Modell "${endpoint.model}" oder Endpunkt nicht gefunden.`,
					status
				);
			case "rate_limit":
				return new EuridianError(
					"rate_limit",
					`${endpoint.label}: Rate-Limit erreicht — bitte kurz warten.`,
					status
				);
			case "bad_request":
				return new EuridianError(
					"bad_request",
					`${endpoint.label}: Ungültige Anfrage. ` +
						`Evtl. unterstützt "${endpoint.model}" einen Parameter nicht. ` +
						this.shortDetail(detail),
					status
				);
			default:
				return new EuridianError(
					"unknown",
					`${endpoint.label}: HTTP ${status}. ${this.shortDetail(detail)}`,
					status
				);
		}
	}

	private shortDetail(detail: string): string {
		if (!detail) return "";
		const trimmed = detail.trim().slice(0, 200);
		return trimmed.length < detail.trim().length ? `${trimmed}…` : trimmed;
	}

	private offlineHint(endpoint: ResolvedEndpoint): string {
		if (endpoint.label === "Ollama") {
			return "Läuft der Server? (`ollama serve`)";
		}
		if (endpoint.label === "Eigener Server") {
			return "Server-URL korrekt? Ggf. VPN/Netzwerk nötig, um den Server zu erreichen.";
		}
		return "Internetverbindung prüfen.";
	}
}

/** Minimale Typ-Beschreibung des genutzten Node-http(s)-Moduls. */
interface NodeHttpModule {
	request(
		options: {
			hostname: string;
			port: number | string;
			path: string;
			method: string;
			headers: Record<string, string | number>;
		},
		callback: (res: NodeIncomingMessage) => void
	): NodeClientRequest;
}

interface NodeIncomingMessage {
	statusCode?: number;
	setEncoding(enc: string): void;
	// Einheitliche, permissive Signatur (chunk je nach setEncoding Buffer/String).
	on(event: string, cb: (arg?: unknown) => void): void;
}

interface NodeClientRequest {
	on(event: "error", cb: (err: Error) => void): void;
	write(chunk: string): void;
	end(): void;
	destroy(): void;
}
