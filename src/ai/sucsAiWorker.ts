import { AiMemory } from './campaignAi';
import { AiDifficulty, chooseSucsAction, SucsAiDecision } from './sucsAi';
import { Side, VisibleState } from '../engine/types';

export interface SucsWorkerRequest {
  id: number;
  visible: VisibleState;
  memory: AiMemory;
  difficulty: AiDifficulty;
  rngState: number;
  aiSide: Side;
}

export interface SucsWorkerResponse {
  id: number;
  decision: SucsAiDecision;
}

const workerScope = self as unknown as {
  onmessage: ((ev: MessageEvent<SucsWorkerRequest>) => void) | null;
  postMessage: (msg: SucsWorkerResponse) => void;
};

workerScope.onmessage = (ev: MessageEvent<SucsWorkerRequest>): void => {
  const { id, visible, memory, difficulty, rngState, aiSide } = ev.data;
  const decision = chooseSucsAction(visible, memory, {
    difficulty,
    rngState,
    aiSide,
  });
  workerScope.postMessage({ id, decision });
};
