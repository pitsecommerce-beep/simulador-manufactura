import Anthropic from '@anthropic-ai/sdk';
import { AiProviderError, type AiProvider, type StopKind } from './provider.ts';

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined;
  maxTokens: number;
  timeoutMs: number;
  /** Solo para tests. */
  fetch?: typeof fetch;
}

const STOP: Record<string, StopKind> = {
  end_turn: 'end',
  stop_sequence: 'end',
  tool_use: 'tool_use',
  max_tokens: 'max_tokens',
  refusal: 'refusal',
};

/**
 * Proveedor Anthropic con el SDK oficial. Pensamiento adaptativo, herramientas con elección
 * `auto` y caché automática del prefijo (herramientas, instrucciones e historial).
 */
export function anthropicProvider(opts: AnthropicOptions): AiProvider {
  const client = new Anthropic({
    apiKey: opts.apiKey,
    timeout: opts.timeoutMs,
    maxRetries: 2,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  return {
    name: 'anthropic',
    model: opts.model,
    userMessage: (text): Anthropic.MessageParam => ({ role: 'user', content: text }),
    toolResultsMessage: (results): Anthropic.MessageParam => ({
      role: 'user',
      content: results.map((r) => ({
        type: 'tool_result',
        tool_use_id: r.id,
        content: r.content,
        is_error: r.is_error,
      })),
    }),
    async turn({ system, tools, history }) {
      let msg: Anthropic.Message;
      try {
        msg = await client.messages
          .stream({
            model: opts.model,
            max_tokens: opts.maxTokens,
            system,
            tools: tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.input_schema as Anthropic.Tool.InputSchema,
              ...(t.strict ? { strict: true } : {}),
            })),
            tool_choice: { type: 'auto' },
            thinking: { type: 'adaptive' },
            ...(opts.effort ? { output_config: { effort: opts.effort } } : {}),
            cache_control: { type: 'ephemeral' },
            messages: history as Anthropic.MessageParam[],
          })
          .finalMessage();
      } catch (err) {
        if (err instanceof Anthropic.AuthenticationError)
          throw new AiProviderError('La clave de Anthropic no es válida (ANTHROPIC_API_KEY).');
        if (err instanceof Anthropic.NotFoundError)
          throw new AiProviderError(`El modelo ${opts.model} no existe o no está disponible.`);
        if (err instanceof Anthropic.RateLimitError)
          throw new AiProviderError('Anthropic limitó las peticiones. Intenta en un momento.');
        if (err instanceof Anthropic.BadRequestError)
          throw new AiProviderError(`Anthropic rechazó la petición: ${err.message}`);
        if (err instanceof Anthropic.APIError)
          throw new AiProviderError(
            `Anthropic no respondió correctamente (${err.status ?? 'red'}).`,
          );
        throw err;
      }
      const u = msg.usage;
      return {
        // Se guarda el contenido completo (incluidos bloques de pensamiento) sin editarlo.
        message: { role: 'assistant', content: msg.content } satisfies Anthropic.MessageParam,
        text: msg.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
          .trim(),
        toolCalls: msg.content
          .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
          .map((b) => ({ id: b.id, name: b.name, input: b.input })),
        stop: STOP[msg.stop_reason ?? ''] ?? 'other',
        usage: {
          input:
            u.input_tokens +
            (u.cache_creation_input_tokens ?? 0) +
            (u.cache_read_input_tokens ?? 0),
          output: u.output_tokens,
        },
      };
    },
  };
}
