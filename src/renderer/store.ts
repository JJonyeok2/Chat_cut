/**
 * 앱 상태를 한 곳에서 관리하는 작은 reducer 스토어.
 *
 * 상태가 얽히는 지점
 * - 채팅 로그, 영상 길이, 싱크 오프셋, 민감도 중 하나만 바뀌어도 후보 구간 전체가 다시 계산된다.
 * - 다시 계산돼도 편집자가 이미 내린 채택/제외 판단은 유지돼야 한다 (carryDecisions).
 * 그래서 파생 상태(analysis)는 reducer 안에서만 만들고, 화면은 상태를 읽기만 한다.
 */
import { analyze, carryDecisions, DEFAULT_PARAMS, shiftSeries } from '../shared/analysis.js';
import type { AnalysisParams, AnalysisResult, ChatLoadResult, Decision, VideoInfo } from '../shared/types.js';

export type Filter = 'all' | Decision;

export interface Status {
  kind: 'busy' | 'error' | 'info';
  text: string;
}

export interface State {
  video: VideoInfo | null;
  chat: ChatLoadResult | null;
  params: AnalysisParams;
  offsetSec: number;
  duration: number;
  analysis: AnalysisResult | null;
  decisions: Record<string, Decision>;
  selectedId: string | null;
  filter: Filter;
  status: Status | null;
}

export type Action =
  | { type: 'videoLoaded'; video: VideoInfo }
  | { type: 'videoDuration'; durationSec: number }
  | { type: 'chatLoaded'; chat: ChatLoadResult }
  | { type: 'setParams'; params: Partial<AnalysisParams> }
  | { type: 'setOffset'; offsetSec: number }
  | { type: 'decide'; id: string; decision: Decision }
  | { type: 'select'; id: string | null }
  | { type: 'setFilter'; filter: Filter }
  | { type: 'status'; status: Status | null };

export const initialState: State = {
  video: null,
  chat: null,
  params: DEFAULT_PARAMS,
  offsetSec: 0,
  duration: 0,
  analysis: null,
  decisions: {},
  selectedId: null,
  filter: 'all',
  status: null,
};

/** 입력이 바뀌었을 때 후보 구간을 다시 계산하고 기존 판단을 이어받는다. */
function recompute(prev: State, next: State, resetDecisions = false): State {
  const duration = next.video?.durationSec || next.chat?.durationSec || 0;
  if (!next.chat || duration <= 0) return { ...next, duration, analysis: null, decisions: {}, selectedId: null };

  const source = next.params.useWeighted ? next.chat.perSecondWeighted : next.chat.perSecond;
  const series = shiftSeries(source, next.offsetSec, Math.ceil(duration));
  const analysis = analyze(series, duration, next.params);
  const decisions = resetDecisions
    ? Object.fromEntries(analysis.segments.map((s) => [s.id, 'pending' as Decision]))
    : carryDecisions(prev.analysis?.segments ?? [], prev.decisions, analysis.segments);
  const selectedId = analysis.segments.some((s) => s.id === next.selectedId) ? next.selectedId : null;
  return { ...next, duration, analysis, decisions, selectedId };
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'videoLoaded':
      return recompute(state, { ...state, video: action.video });
    case 'videoDuration':
      if (!state.video || state.video.durationSec > 0) return state;
      return recompute(state, { ...state, video: { ...state.video, durationSec: action.durationSec } });
    case 'chatLoaded':
      return recompute(state, { ...state, chat: action.chat, offsetSec: 0, selectedId: null }, true);
    case 'setParams':
      return recompute(state, { ...state, params: { ...state.params, ...action.params } });
    case 'setOffset':
      return recompute(state, { ...state, offsetSec: action.offsetSec });
    case 'decide':
      return { ...state, decisions: { ...state.decisions, [action.id]: action.decision } };
    case 'select':
      return { ...state, selectedId: action.id };
    case 'setFilter':
      return { ...state, filter: action.filter };
    case 'status':
      return { ...state, status: action.status };
  }
}

export interface Store {
  getState(): State;
  dispatch(a: Action): void;
  subscribe(fn: (s: State, prev: State) => void): () => void;
}

export function createStore(init: State): Store {
  let state = init;
  const subs = new Set<(s: State, prev: State) => void>();
  return {
    getState: () => state,
    dispatch(a) {
      const prev = state;
      state = reducer(state, a);
      if (state !== prev) subs.forEach((fn) => fn(state, prev));
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

/** 선택된 필터에 맞는 후보 목록 */
export function visibleSegments(s: State) {
  const segs = s.analysis?.segments ?? [];
  return s.filter === 'all' ? segs : segs.filter((x) => (s.decisions[x.id] ?? 'pending') === s.filter);
}
