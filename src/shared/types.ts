/**
 * main 프로세스와 renderer가 함께 쓰는 타입.
 * IPC로 오가는 값은 모두 구조화 복제 가능한 순수 데이터만 담는다.
 */

export interface ChatSample {
  /** 채팅 로그 기준 초 (오프셋 적용 전) */
  t: number;
  user: string;
  text: string;
  /** 반응 가중치 */
  w?: number;
}

export type TimeMode = 'elapsed' | 'clock';

export interface ChatLoadResult {
  path: string;
  name: string;
  /** 감지한 로그 형식 (text, json-array, twitch-json, ndjson) */
  format: string;
  /** elapsed: 방송 경과 시간 / clock: 벽시계 시각(첫 메시지 = 0초로 환산) */
  timeMode: TimeMode;
  totalMessages: number;
  skippedLines: number;
  durationSec: number;
  /** 1초 단위 메시지 수 */
  perSecond: number[];
  /** 1초 단위 반응 가중 합 (ㅋㅋ, ㄷㄷ 같은 반응 표현에 가중치) */
  perSecondWeighted: number[];
  /** sampleBucketSec 단위 버킷 → 대표 메시지 몇 개 */
  samples: Record<number, ChatSample[]>;
  sampleBucketSec: number;
}

export interface VideoInfo {
  path: string;
  url: string;
  name: string;
  durationSec: number;
  fps: number;
}

export interface AnalysisParams {
  /** 집계 단위 (초) */
  binSec: number;
  /** 평소 대비 몇 배 튀어야 후보로 볼지 (robust z-score 기준) */
  threshold: number;
  /** 채팅은 장면보다 늦게 반응하므로 시작점을 앞으로 당기는 시간 */
  preRollSec: number;
  postRollSec: number;
  /** 이 간격 이하로 떨어진 급증은 한 구간으로 합침 */
  mergeGapSec: number;
  /** "평소"를 계산하는 이동 창 크기 */
  baselineWindowSec: number;
  useWeighted: boolean;
  maxSegments: number;
}

export interface Segment {
  id: string;
  start: number;
  end: number;
  peakTime: number;
  /** 구간 내 최대 점수 */
  score: number;
  /** 구간 내 메시지(가중) 합 */
  volume: number;
  /** 점수 순위 (1부터) */
  rank: number;
}

export interface AnalysisResult {
  binSec: number;
  bins: number[];
  baseline: number[];
  scores: number[];
  segments: Segment[];
}

export type Decision = 'pending' | 'accepted' | 'rejected';

export interface ClipJob {
  start: number;
  end: number;
  label: string;
}

export interface ClipProgress {
  index: number;
  total: number;
  file: string;
}
