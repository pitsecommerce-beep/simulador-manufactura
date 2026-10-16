import {
  DISCLAIMERS,
  MAX_ASSISTANT_MESSAGE,
  type AiProposal,
  type AssistantConversation,
  type AssistantStatus,
  type Scene,
} from '@sim/domain';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Message, Spinner } from '../components/ui';
import { ApiError } from '../lib/api';
import { useApp } from '../lib/context';
import { ICON_NOTICE, RobotIcon } from './RobotIcon';

export type AcceptMode = 'replace' | 'merge';

const STATUS_LABEL: Record<AiProposal['status'], [string, string]> = {
  pending: ['Pendiente', 'bg-violet-50 text-violet-700'],
  accepted: ['Aceptada', 'bg-emerald-50 text-emerald-700'],
  discarded: ['Descartada', 'bg-slate-100 text-slate-500'],
};

const fmt = (v: number) => v.toLocaleString('es-MX', { maximumFractionDigits: 1 });

/** Panel lateral del asistente de IA: chat, propuestas y su aceptación. */
export function AssistantPanel({
  projectId,
  canEdit,
  scene,
  previewId,
  canUndo,
  onPreview,
  onAccept,
  onUndo,
  onClose,
}: {
  projectId: string;
  canEdit: boolean;
  /** Escena actual del editor (aunque no esté guardada): se envía como contexto. */
  scene: Scene;
  previewId: string | null;
  canUndo: boolean;
  onPreview: (p: AiProposal | null) => void;
  onAccept: (p: AiProposal, mode: AcceptMode) => void;
  onUndo: () => void;
  onClose: () => void;
}) {
  const { api } = useApp();
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const [list, setList] = useState<{ id: string; title: string | null }[]>([]);
  const [conv, setConv] = useState<AssistantConversation | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const refreshList = useCallback(() => {
    api
      .listConversations(projectId)
      .then((r) => setList(r.conversations))
      .catch(() => {});
  }, [api, projectId]);

  useEffect(() => {
    api
      .assistantStatus()
      .then(setStatus)
      .catch((e: Error) => setError(e.message));
    refreshList();
  }, [api, refreshList]);

  useEffect(() => {
    bottom.current?.scrollIntoView?.({ block: 'end' });
  }, [conv, sending]);

  async function open(id: string) {
    setError(null);
    onPreview(null);
    if (!id) return setConv(null);
    try {
      setConv((await api.getConversation(projectId, id)).conversation);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    const message = text.trim();
    if (!message || sending) return;
    setSending(true);
    setError(null);
    setLimit(null);
    try {
      const reply = await api.askAssistant(projectId, {
        conversation_id: conv?.id ?? null,
        message,
        current_scene: scene,
      });
      setConv(reply.conversation);
      setText('');
      if (reply.limit) setLimit(reply.limit.message);
      const last = reply.proposals.at(-1);
      if (last) onPreview(last);
      if (!conv) refreshList();
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) setLimit(err.message);
      else setError((err as Error).message);
    } finally {
      setSending(false);
    }
  }

  async function setProposal(p: AiProposal, next: 'accepted' | 'discarded', mode?: AcceptMode) {
    if (!conv) return;
    setError(null);
    try {
      const r = await api.setProposalStatus(projectId, conv.id, p.id, next);
      setConv(r.conversation);
      if (next === 'accepted' && mode) onAccept(p, mode);
      if (previewId === p.id) onPreview(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const proposals = new Map((conv?.proposals ?? []).map((p) => [p.id, p]));

  return (
    <aside
      className="fixed inset-y-0 right-0 z-40 flex w-full flex-col border-l border-slate-200 bg-white shadow-2xl sm:w-[27rem]"
      aria-label="Asistente de IA"
    >
      <header className="flex items-center gap-2 border-b border-slate-200 px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-slate-900">Asistente</h2>
          <p className="truncate text-xs text-slate-500">
            {status?.configured ? `Modelo: ${status.model}` : 'Propone layouts con el catálogo'}
          </p>
        </div>
        {canUndo && (
          <button className="btn btn-secondary px-2.5 py-1 text-xs" onClick={onUndo}>
            Deshacer
          </button>
        )}
        <button className="btn btn-ghost px-2.5 py-1 text-xs" onClick={onClose}>
          Cerrar
        </button>
      </header>

      {list.length > 0 && (
        <div className="border-b border-slate-100 px-4 py-2">
          <select
            className="input py-1 text-xs"
            aria-label="Conversación"
            value={conv?.id ?? ''}
            onChange={(e) => void open(e.target.value)}
          >
            <option value="">Nueva conversación</option>
            {list.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title ?? 'Sin título'}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {status && !status.configured && (
          <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            El asistente no está configurado en el servidor (falta AI_MODEL y la clave del
            proveedor).
          </p>
        )}
        {!canEdit && (
          <p className="text-sm text-slate-500">
            Solo el propietario y los editores pueden usar el asistente.
          </p>
        )}
        {!conv && status?.configured && canEdit && (
          <div className="space-y-2 text-sm text-slate-600">
            <p>
              Describe la línea que necesitas. El asistente elige robots y componentes del catálogo,
              valida alcance, carga, colisiones y flujo, y te deja una propuesta en la cuadrícula.
            </p>
            <p className="text-xs text-slate-500">
              Ejemplo: “Celda de paletizado para cajas de 12 kg que llegan cada 8 s por una banda, a
              un pallet EUR”.
            </p>
          </div>
        )}
        {conv?.transcript.map((m, i) =>
          m.role === 'user' ? (
            <div key={i} className="ml-8 rounded-2xl bg-brand-600 px-3 py-2 text-sm text-white">
              <p className="whitespace-pre-wrap">{m.text}</p>
            </div>
          ) : (
            <div key={i} className="mr-4 space-y-2">
              <div
                className={`rounded-2xl px-3 py-2 text-sm ${
                  m.notice
                    ? 'border border-amber-200 bg-amber-50 text-amber-900'
                    : 'bg-slate-100 text-slate-800'
                }`}
              >
                <p className="whitespace-pre-wrap">{m.text}</p>
              </div>
              {m.proposal_ids?.map((id) => {
                const p = proposals.get(id);
                return p ? (
                  <ProposalCard
                    key={id}
                    p={p}
                    canEdit={canEdit}
                    previewing={previewId === id}
                    onPreview={() => onPreview(previewId === id ? null : p)}
                    onAccept={(mode) => void setProposal(p, 'accepted', mode)}
                    onDiscard={() => void setProposal(p, 'discarded')}
                  />
                ) : null;
              })}
            </div>
          ),
        )}
        {sending && (
          <p className="flex items-center gap-2 text-sm text-slate-500">
            <Spinner /> El asistente está trabajando (consulta el catálogo y valida)…
          </p>
        )}
        {limit && (
          <p
            role="status"
            className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
          >
            {limit}
          </p>
        )}
        {error && <Message kind="error">{error}</Message>}
        <div ref={bottom} />
      </div>

      {canEdit && status?.configured && (
        <form onSubmit={send} className="space-y-2 border-t border-slate-200 p-3">
          <textarea
            className="input min-h-20 resize-y text-sm"
            placeholder="Escribe lo que necesitas…"
            aria-label="Mensaje al asistente"
            maxLength={MAX_ASSISTANT_MESSAGE}
            value={text}
            disabled={sending}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void send(e);
            }}
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-slate-500">
              Envía tu escena actual, aunque no esté guardada.
            </span>
            <button className="btn btn-primary py-1.5" disabled={sending || !text.trim()}>
              {sending && <Spinner />}
              Enviar
            </button>
          </div>
        </form>
      )}
    </aside>
  );
}

function ProposalCard({
  p,
  canEdit,
  previewing,
  onPreview,
  onAccept,
  onDiscard,
}: {
  p: AiProposal;
  canEdit: boolean;
  previewing: boolean;
  onPreview: () => void;
  onAccept: (mode: AcceptMode) => void;
  onDiscard: () => void;
}) {
  const [label, cls] = STATUS_LABEL[p.status];
  const warnings = [
    ...p.warnings.filter((w) => w.level === 'warning').map((w) => w.message),
    ...p.process_issues.filter((i) => i.level === 'warning').map((i) => i.message),
  ];
  const infos = [
    ...p.warnings.filter((w) => w.level === 'info').map((w) => w.message),
    ...p.process_issues.filter((i) => i.level === 'info').map((i) => i.message),
  ];
  const th = p.estimate?.throughput_per_hour;
  return (
    <div
      className={`space-y-3 rounded-2xl border border-dashed p-3 text-sm ${
        previewing ? 'border-violet-500 bg-violet-50/60' : 'border-violet-300 bg-white'
      }`}
    >
      <div className="flex items-start gap-2">
        <p className="flex-1 font-medium text-slate-900">{p.summary}</p>
        <span className={`badge ${cls}`}>{label}</span>
      </div>

      {p.robots.length > 0 && (
        <ul className="space-y-1.5">
          {p.robots.map((r) => (
            <li key={r.slug} className="flex items-center gap-2">
              <RobotIcon kinematicType={r.kinematic_type} />
              <div className="min-w-0">
                <Link to={`/catalogo/${r.slug}`} className="link text-sm" target="_blank">
                  {r.variant_code}
                </Link>
                <p className="truncate text-xs text-slate-500">{r.family ?? r.model}</p>
              </div>
            </li>
          ))}
          <li className="text-[11px] text-slate-400">{ICON_NOTICE}</li>
        </ul>
      )}
      {p.components.length > 0 && (
        <p className="text-xs text-slate-600">
          Componentes:{' '}
          {p.components
            .map((c) => `${c.manufacturer ? `${c.manufacturer} ` : ''}${c.model}`)
            .join(', ')}
        </p>
      )}

      {th ? (
        <div className="rounded-xl bg-slate-50 px-3 py-2">
          <p className="text-[11px] font-semibold tracking-wide text-amber-700 uppercase">
            Estimación
          </p>
          <p className="text-slate-900">
            <strong>{fmt(th.mean)} u/h</strong>
            {th.low != null && th.high != null && (
              <span className="text-slate-600">
                {' '}
                (rango {fmt(th.low)} a {fmt(th.high)})
              </span>
            )}
          </p>
          <p className="text-xs text-slate-500">
            {p.estimate!.replications} réplicas de {p.estimate!.horizon_h} h
            {p.estimate!.bottleneck ? ` · cuello de botella: ${p.estimate!.bottleneck}` : ''}
          </p>
        </div>
      ) : (
        <p className="text-xs text-slate-500">Sin simulación de esta propuesta.</p>
      )}

      {warnings.length > 0 && (
        <ul className="space-y-1 text-xs text-amber-800">
          {warnings.map((w, i) => (
            <li key={i}>⚠ {w}</li>
          ))}
        </ul>
      )}
      {(infos.length > 0 || p.assumptions.length > 0) && (
        <details className="text-xs text-slate-600">
          <summary className="cursor-pointer text-slate-500">
            Supuestos y datos no publicados ({infos.length + p.assumptions.length})
          </summary>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {p.assumptions.map((a, i) => (
              <li key={`a${i}`}>{a}</li>
            ))}
            {infos.map((a, i) => (
              <li key={`i${i}`}>{a}</li>
            ))}
          </ul>
        </details>
      )}

      <div className="flex flex-wrap gap-1.5">
        <button className="btn btn-secondary px-2.5 py-1 text-xs" onClick={onPreview}>
          {previewing ? 'Ocultar vista previa' : 'Ver en la cuadrícula'}
        </button>
        {canEdit && p.status === 'pending' && (
          <>
            <button
              className="btn btn-primary px-2.5 py-1 text-xs"
              onClick={() => onAccept('replace')}
            >
              Aceptar (reemplazar)
            </button>
            <button
              className="btn btn-secondary px-2.5 py-1 text-xs"
              onClick={() => onAccept('merge')}
            >
              Aceptar (fusionar)
            </button>
            <button className="btn btn-ghost px-2.5 py-1 text-xs" onClick={onDiscard}>
              Descartar
            </button>
          </>
        )}
      </div>
      <p className="text-[11px] text-slate-400">{DISCLAIMERS.estimates}</p>
    </div>
  );
}
