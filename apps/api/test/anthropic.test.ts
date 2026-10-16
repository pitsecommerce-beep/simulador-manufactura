import { describe, expect, it } from 'vitest';
import { anthropicProvider } from '../src/ai/anthropic.ts';
import { AiProviderError } from '../src/ai/provider.ts';

/** Respuesta SSE del endpoint de mensajes con un bloque de pensamiento, texto y una herramienta. */
function sse(): string {
  const events: [string, unknown][] = [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'modelo-x',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 50,
            output_tokens: 1,
            cache_creation_input_tokens: 1000,
            cache_read_input_tokens: 4000,
          },
        },
      },
    ],
    [
      'content_block_start',
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      },
    ],
    [
      'content_block_delta',
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'sig' },
      },
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'content_block_start',
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    ],
    [
      'content_block_delta',
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Busco.' } },
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 1 }],
    [
      'content_block_start',
      {
        type: 'content_block_start',
        index: 2,
        content_block: { type: 'tool_use', id: 'tu_1', name: 'get_variant', input: {} },
      },
    ],
    [
      'content_block_delta',
      {
        type: 'content_block_delta',
        index: 2,
        delta: { type: 'input_json_delta', partial_json: '{"slug":"irb-1300-7-1-4"}' },
      },
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 2 }],
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { output_tokens: 30 },
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  ];
  return events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
}

describe('proveedor Anthropic', () => {
  it('envía pensamiento adaptativo, herramientas auto/strict, caché y esfuerzo; normaliza la respuesta', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchMock = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string) as Record<string, unknown>);
      return new Response(sse(), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch;
    const p = anthropicProvider({
      apiKey: 'sk-ant-test-0000000000000000',
      model: 'modelo-x',
      effort: 'high',
      maxTokens: 32000,
      timeoutMs: 5000,
      fetch: fetchMock,
    });
    const res = await p.turn({
      system: 'instrucciones',
      tools: [
        { name: 'get_variant', description: 'd', strict: true, input_schema: { type: 'object' } },
        {
          name: 'propose_scene',
          description: 'd',
          strict: false,
          input_schema: { type: 'object' },
        },
      ],
      history: [p.userMessage('hola')],
    });
    const body = bodies[0]!;
    expect(body).toMatchObject({
      model: 'modelo-x',
      max_tokens: 32000,
      system: 'instrucciones',
      tool_choice: { type: 'auto' },
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      cache_control: { type: 'ephemeral' },
      stream: true,
      messages: [{ role: 'user', content: 'hola' }],
    });
    expect((body.tools as { strict?: boolean }[]).map((t) => t.strict)).toEqual([true, undefined]);

    expect(res).toMatchObject({
      text: 'Busco.',
      stop: 'tool_use',
      toolCalls: [{ id: 'tu_1', name: 'get_variant', input: { slug: 'irb-1300-7-1-4' } }],
      usage: { input: 5050, output: 30 },
    });
    // El mensaje guardado conserva el bloque de pensamiento para reenviarlo sin cambios.
    const msg = res.message as { role: string; content: { type: string; signature?: string }[] };
    expect(msg.role).toBe('assistant');
    expect(msg.content.map((b) => b.type)).toEqual(['thinking', 'text', 'tool_use']);
    expect(msg.content[0]!.signature).toBe('sig');
    expect(p.toolResultsMessage([{ id: 'tu_1', content: '{}', is_error: false }])).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '{}', is_error: false }],
    });
  });

  it('traduce errores de la API a mensajes para el usuario', async () => {
    const fetchMock = (async () =>
      new Response(
        JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'x' } }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch;
    const p = anthropicProvider({
      apiKey: 'sk-ant-test-0000000000000000',
      model: 'modelo-x',
      maxTokens: 1000,
      timeoutMs: 5000,
      fetch: fetchMock,
    });
    const err = await p
      .turn({ system: 's', tools: [], history: [p.userMessage('hola')] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiProviderError);
    expect((err as Error).message).toMatch(/ANTHROPIC_API_KEY/);
  });
});
