import type { SimRequest } from '@sim/domain';

/** Cliente del sim-worker (servicio HTTP interno). */
export interface SimClient {
  submit(req: SimRequest): Promise<void>;
}

export interface SimSettings {
  client: SimClient;
  maxReplications: number;
  maxHorizonH: number;
  runTimeoutS: number;
  /** Ventana del registro de eventos para el reproductor (s). */
  playbackWindowS: number;
  maxEvents: number;
}

export class SimWorkerError extends Error {}

export function httpSimClient(baseUrl: string, token: string, timeoutMs = 15_000): SimClient {
  const url = `${baseUrl.replace(/\/+$/, '')}/runs`;
  return {
    async submit(req) {
      let res: Response;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify(req),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw new SimWorkerError(
          `No se pudo contactar al motor de simulación (${(err as Error).message})`,
        );
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new SimWorkerError(
          `El motor de simulación respondió ${res.status}: ${text.slice(0, 300)}`,
        );
      }
    },
  };
}
