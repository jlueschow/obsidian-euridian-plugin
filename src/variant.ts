/**
 * Euridian — Variante.
 *
 * Diese Datei legt fest, welche Provider in diesem Plugin verfügbar sind.
 * Sie ist der Punkt, an dem sich Euridian (Euria) und Selfhost Agent
 * unterscheiden; der restliche Code liest nur `PROVIDERS`.
 */

import { Provider } from "./provider";
import { customProvider } from "./providers/custom";
import { infomaniakProvider } from "./providers/infomaniak";
import { ollamaProvider } from "./providers/ollama";

export const PROVIDERS: Provider[] = [
	ollamaProvider,
	customProvider,
	infomaniakProvider,
];
