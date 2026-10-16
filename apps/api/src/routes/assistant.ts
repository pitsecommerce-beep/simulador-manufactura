import {
  AssistantRequest,
  ProposalUpdate,
  Uuid,
  projectAccess,
  type AiProposal,
  type AssistantConversation,
  type AssistantLimit,
  type AssistantReply,
  type AssistantStatus,
  type TranscriptEntry,
} from '@sim/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { httpError } from '../errors.ts';
import { SYSTEM_PROMPT, userTurnText } from '../ai/prompt.ts';
import { AiProviderError, type ToolResult } from '../ai/provider.ts';
import { toolExecutor, toolSpecs } from '../ai/tools.ts';
import type { AiUsageResult, StoredConversation, ToolCallLog } from '../repo.ts';

const IdParams = z.object({ id: Uuid });
const ConvParams = z.object({ id: Uuid, cid: Uuid });
const ProposalParams = z.object({ id: Uuid, cid: Uuid, pid: Uuid });

const NOT_CONFIGURED =
  'El asistente de IA no está configurado: define AI_MODEL y la clave del proveedor en el servicio api.';

/** Medianoche UTC siguiente: cuando se reinician los límites diarios. */
function nextUtcMidnight(now = new Date()): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  ).toISOString();
}

function limitFor(
  blocked: NonNullable<AiUsageResult['blocked']>,
  limits: { requests: number; tokens: number },
): AssistantLimit {
  const resets_at = nextUtcMidnight();
  const when = 'Se reinicia a medianoche UTC.';
  const message = {
    requests: `Alcanzaste el límite de ${limits.requests} mensajes al asistente por día. ${when}`,
    tokens: `Alcanzaste el límite diario de ${limits.tokens.toLocaleString('es-MX')} tokens del asistente. ${when}`,
    global_tokens: `La aplicación alcanzó su tope diario de uso del asistente. ${when}`,
  }[blocked];
  return { kind: blocked, message, resets_at };
}

/** Vista de la conversación para el cliente (sin el historial nativo ni el registro). */
function publicView(c: StoredConversation): AssistantConversation {
  return {
    id: c.id,
    project_id: c.project_id,
    title: c.title,
    model: c.model,
    transcript: c.transcript,
    proposals: c.proposals,
    tokens_in: c.tokens_in,
    tokens_out: c.tokens_out,
    updated_at: c.updated_at,
  };
}

// Asistente de IA (fase 9, parte C). Ninguna ruta escribe en `layouts`: aceptar una propuesta
// la aplica en el editor y el usuario guarda con el botón de siempre.
export async function assistantRoutes(app: FastifyInstance) {
  async function projectFor(req: FastifyRequest, id: string) {
    const user = app.requireUser(req);
    const repo = app.deps.userRepo(user);
    const project = await repo.getProject(id);
    if (!project) throw httpError(404, 'Proyecto no encontrado');
    const access = projectAccess(project, await repo.listMembers(id), user.id);
    return { user, repo, access };
  }

  async function ownConversation(req: FastifyRequest, id: string, cid: string) {
    const ctx = await projectFor(req, id);
    const conv = await ctx.repo.getConversation(cid);
    if (!conv || conv.project_id !== id) throw httpError(404, 'Conversación no encontrada');
    return { ...ctx, conv };
  }

  app.get('/assistant/status', async (req): Promise<AssistantStatus> => {
    app.requireUser(req);
    const ai = app.deps.ai;
    return {
      configured: ai != null,
      provider: ai?.provider.name ?? null,
      model: ai?.provider.model ?? null,
      limits: ai ? { requests_per_day: ai.requestLimit, tokens_per_day: ai.tokenLimit } : null,
    };
  });

  app.get('/projects/:id/assistant/conversations', async (req) => {
    const { id } = IdParams.parse(req.params);
    const { repo } = await projectFor(req, id);
    return { conversations: await repo.listConversations(id) };
  });

  app.get('/projects/:id/assistant/conversations/:cid', async (req) => {
    const { id, cid } = ConvParams.parse(req.params);
    const { conv } = await ownConversation(req, id, cid);
    return { conversation: publicView(conv) };
  });

  app.patch('/projects/:id/assistant/conversations/:cid/proposals/:pid', async (req) => {
    const { id, cid, pid } = ProposalParams.parse(req.params);
    const { status } = ProposalUpdate.parse(req.body);
    const { user, access, conv } = await ownConversation(req, id, cid);
    if ((access !== 'owner' && access !== 'editor') || conv.owner_id !== user.id)
      throw httpError(403, 'Solo el autor de la conversación puede cambiar sus propuestas');
    const proposal = conv.proposals.find((p) => p.id === pid);
    if (!proposal) throw httpError(404, 'Propuesta no encontrada');
    const { updated_at, ...rest } = conv;
    const saved = await app.deps.systemRepo.saveConversation(
      { ...rest, proposals: conv.proposals.map((p) => (p.id === pid ? { ...p, status } : p)) },
      updated_at,
    );
    return { conversation: publicView(saved) };
  });

  app.post('/projects/:id/assistant', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const { user, repo, access } = await projectFor(req, id);
    if (access !== 'owner' && access !== 'editor')
      throw httpError(403, 'Solo el propietario y los editores pueden usar el asistente');
    const ai = app.deps.ai;
    if (!ai) throw httpError(503, NOT_CONFIGURED);
    const body = AssistantRequest.parse(req.body);

    let conv: StoredConversation | null = null;
    if (body.conversation_id) {
      conv = await repo.getConversation(body.conversation_id);
      if (!conv || conv.project_id !== id) throw httpError(404, 'Conversación no encontrada');
      if (conv.owner_id !== user.id)
        throw httpError(403, 'Solo el autor puede continuar esta conversación');
    }

    const limits = {
      requests: ai.requestLimit,
      tokens: ai.tokenLimit,
      globalTokens: ai.globalTokenLimit,
    };
    const system = app.deps.systemRepo;
    const usage = await system.consumeAiUsage(
      user.id,
      { requests: 1, tokensIn: 0, tokensOut: 0 },
      limits,
    );
    if (!usage.allowed) {
      const limit = limitFor(usage.blocked!, limits);
      return reply.status(429).send({ error: 'ai_limit', message: limit.message, limit });
    }

    const provider = ai.provider;
    const now = () => new Date().toISOString();
    // El historial solo crece: se agregan mensajes, nunca se editan los anteriores.
    // Los mensajes previos se reenvían y se vuelven a guardar con su texto original.
    const stored = conv?.messages ?? [];
    const history: unknown[] = stored.map((m) => JSON.parse(m) as unknown);
    const proposals: AiProposal[] = [...(conv?.proposals ?? [])];
    const before = new Set(proposals.map((p) => p.id));
    const toolLog: ToolCallLog[] = [...(conv?.tool_calls ?? [])];
    const transcript: TranscriptEntry[] = [
      ...(conv?.transcript ?? []),
      { role: 'user', text: body.message, at: now() },
    ];
    history.push(
      provider.userMessage(userTurnText(body.message, JSON.stringify(body.current_scene))),
    );

    const tools = toolSpecs(app.deps.sim != null);
    const run = toolExecutor({
      user,
      repo,
      systemRepo: system,
      projectId: id,
      sim: app.deps.sim,
      ai,
      proposals,
    });

    let tokensIn = 0;
    let tokensOut = 0;
    let limit: AssistantLimit | null = null;
    const texts: string[] = [];
    const notices: string[] = [];
    try {
      for (let turn = 0; ; turn++) {
        if (turn === ai.maxTurns) {
          notices.push(
            `El asistente llegó al máximo de ${ai.maxTurns} vueltas para este mensaje. Pídele que continúe.`,
          );
          break;
        }
        const res = await provider.turn({ system: SYSTEM_PROMPT, tools, history });
        history.push(res.message);
        tokensIn += res.usage.input;
        tokensOut += res.usage.output;
        const after = await system.consumeAiUsage(
          user.id,
          { requests: 0, tokensIn: res.usage.input, tokensOut: res.usage.output },
          limits,
        );
        if (res.text) texts.push(res.text);
        if (res.stop === 'refusal') {
          notices.push('El modelo no quiso responder esta solicitud. Reformúlala.');
          break;
        }
        if (res.stop === 'max_tokens')
          notices.push('La respuesta se cortó por longitud. Pide que continúe.');
        if (res.stop !== 'tool_use' || res.toolCalls.length === 0) break;

        const results: ToolResult[] = [];
        for (const call of res.toolCalls) {
          let outcome;
          try {
            outcome = await run(call.name, call.input);
          } catch (err) {
            req.log.error(err);
            outcome = {
              ok: false,
              result: { ok: false, errors: ['La herramienta falló. Intenta de otra forma.'] },
              detail: (err as Error).message,
            };
          }
          toolLog.push({ name: call.name, ok: outcome.ok, at: now(), detail: outcome.detail });
          results.push({
            id: call.id,
            content: JSON.stringify(outcome.result),
            is_error: !outcome.ok,
          });
        }
        history.push(provider.toolResultsMessage(results));

        const blocked =
          after.tokens >= limits.tokens
            ? 'tokens'
            : after.global_tokens >= limits.globalTokens
              ? 'global_tokens'
              : null;
        if (blocked) {
          limit = limitFor(blocked, limits);
          notices.push(`${limit.message} La respuesta quedó incompleta.`);
          break;
        }
      }
    } catch (err) {
      if (!(err instanceof AiProviderError)) throw err;
      req.log.warn(err);
      notices.push(err.message);
    }

    const created = proposals.filter((p) => !before.has(p.id));
    const answer = texts.join('\n\n').trim();
    if (answer || created.length)
      transcript.push({
        role: 'assistant',
        text: answer || 'Te dejé una propuesta en la cuadrícula.',
        at: now(),
        ...(created.length ? { proposal_ids: created.map((p) => p.id) } : {}),
      });
    for (const n of notices)
      transcript.push({ role: 'assistant', text: n, at: now(), notice: true });

    const saved = await system.saveConversation(
      {
        id: conv?.id ?? null,
        project_id: id,
        owner_id: user.id,
        provider: provider.name,
        model: provider.model,
        title: conv?.title ?? body.message.slice(0, 80),
        messages: [...stored, ...history.slice(stored.length).map((m) => JSON.stringify(m))],
        tool_calls: toolLog,
        transcript,
        proposals,
        tokens_in: (conv?.tokens_in ?? 0) + tokensIn,
        tokens_out: (conv?.tokens_out ?? 0) + tokensOut,
      },
      conv?.updated_at ?? null,
    );
    const out: AssistantReply = { conversation: publicView(saved), proposals: created, limit };
    return out;
  });
}
