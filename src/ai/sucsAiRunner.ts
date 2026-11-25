import { Side, VisibleState } from '../engine/types';
import { AiMemory } from './campaignAi';
import { AiDifficulty, chooseSucsAction, SucsAiDecision } from './sucsAi';
import type { SucsWorkerRequest, SucsWorkerResponse } from './sucsAiWorker';

/**
 * Off-main-thread runner for S.U.C.S. AI using a bundled Vite Web Worker,
 * with automatic synchronous fallback when Web Workers are unavailable.
 */
export class SucsAiRunner {
  private worker: Worker | null = null;
  private workerBroken = false;
  private nextRequestId = 1;
  private pending = new Map<number, (decision: SucsAiDecision) => void>();

  public run(
    visible: VisibleState,
    memory: AiMemory,
    difficulty: AiDifficulty,
    rngState: number,
    aiSide: Side = 'ENEMY',
  ): Promise<SucsAiDecision> {
    const worker = this.ensureWorker();
    if (worker === null) {
      return Promise.resolve(
        chooseSucsAction(visible, memory, {
          difficulty,
          rngState,
          aiSide,
        }),
      );
    }

    const id = this.nextRequestId++;
    return new Promise<SucsAiDecision>((resolve) => {
      this.pending.set(id, resolve);
      const req: SucsWorkerRequest = {
        id,
        visible,
        memory,
        difficulty,
        rngState,
        aiSide,
      };
      try {
        worker.postMessage(req);
      } catch {
        this.pending.delete(id);
        this.workerBroken = true;
        this.terminateWorker();
        resolve(
          chooseSucsAction(visible, memory, {
            difficulty,
            rngState,
            aiSide,
          }),
        );
      }
    });
  }

  public cancelPending(): void {
    this.pending.clear();
  }

  public destroy(): void {
    this.pending.clear();
    this.terminateWorker();
  }

  private ensureWorker(): Worker | null {
    if (this.workerBroken || typeof Worker !== 'function') return null;
    if (this.worker !== null) return this.worker;

    try {
      const worker = new Worker(new URL('./sucsAiWorker.ts', import.meta.url), {
        type: 'module',
      });
      worker.onmessage = (ev: MessageEvent<SucsWorkerResponse>): void => {
        const resolver = this.pending.get(ev.data.id);
        if (resolver !== undefined) {
          this.pending.delete(ev.data.id);
          resolver(ev.data.decision);
        }
      };
      worker.onerror = (): void => {
        this.workerBroken = true;
        this.terminateWorker();
      };
      this.worker = worker;
      return worker;
    } catch {
      this.workerBroken = true;
      return null;
    }
  }

  private terminateWorker(): void {
    if (this.worker !== null) {
      try {
        this.worker.terminate();
      } catch {
        // ignore
      }
      this.worker = null;
    }
  }
}
