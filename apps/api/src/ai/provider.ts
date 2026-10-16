// Capa de proveedor del asistente. El bucle de herramientas vive en la api y solo usa esta
// interfaz; el historial se guarda en el formato nativo del proveedor y se reenvía tal cual.

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  /** Esquema estricto (el proveedor garantiza argumentos válidos). */
  strict: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResult {
  id: string;
  /** JSON con el resultado o el error. */
  content: string;
  is_error: boolean;
}

export type StopKind = 'end' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';

export interface TurnResult {
  /** Mensaje del asistente en formato nativo: se agrega al historial sin cambios. */
  message: unknown;
  /** Texto visible de la respuesta. */
  text: string;
  toolCalls: ToolCall[];
  stop: StopKind;
  /** Tokens de entrada (incluye los leídos o escritos en caché) y de salida. */
  usage: { input: number; output: number };
}

export interface AiProvider {
  readonly name: string;
  readonly model: string;
  userMessage(text: string): unknown;
  toolResultsMessage(results: ToolResult[]): unknown;
  turn(req: { system: string; tools: ToolSpec[]; history: unknown[] }): Promise<TurnResult>;
}

/** Error del proveedor con un mensaje apto para el usuario. */
export class AiProviderError extends Error {}

export interface AiSettings {
  provider: AiProvider;
  requestLimit: number;
  tokenLimit: number;
  globalTokenLimit: number;
  /** Vueltas máximas del bucle de herramientas por mensaje. */
  maxTurns: number;
  /** Corrida rápida del asistente: espera máxima y frecuencia de consulta. */
  quickRun: { timeoutMs: number; pollMs: number; replications: number; horizonH: number };
}
