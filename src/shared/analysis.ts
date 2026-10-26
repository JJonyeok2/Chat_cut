/**
 * 채팅 반응 급증 탐지.
 *
 * 핵심 판단
 * 1. "많다"의 기준은 방송마다, 같은 방송 안에서도 시간대마다 다르다.
 *    그래서 전체 평균이 아니라 주변 몇 분의 이동 중앙값을 "평소"로 본다.
 * 2. 평균/표준편차는 한 번의 폭발에 끌려가므로 중앙값과 MAD(중앙 절대 편차)를 쓴다.
 * 3. 채팅은 장면보다 늦게 반응한다. 그래서 후보 구간 시작을 preRoll 만큼 앞으로 당긴다.
 * 4. 이 모듈은 후보만 만든다. 쓸지 말지는 편집자가 정한다.
 */
import type { AnalysisParams, AnalysisResult, Decision, Segment } from './types.js';

export const DEFAULT_PARAMS: AnalysisParams = {
  binSec: 5,
  threshold: 4,
  preRollSec: 15,
  postRollSec: 5,
  mergeGapSec: 15,
  baselineWindowSec: 600,
  useWeighted: true,
  maxSegments: 40,
};

const LAUGH_RE = /ㅋ{2,}|ㅎ{3,}|lol|lmao|kek|zz{2,}/i;
const HYPE_RE = /ㄷㄷ|와{1,}[아ㅏ]*|미쳤|미친|레전드|대박|클립|clip|pog|ㄹㅇ|!{2,}|\?{2,}/i;

/** 반응 표현이 담긴 메시지에 가중치를 준다. 일반 메시지는 1. */
export function reactionWeight(text: string): number {
  let w = 1;
  if (LAUGH_RE.test(text)) w += 0.5;
  if (HYPE_RE.test(text)) w += 0.5;
  return w;
}

/** 채팅 시각과 영상 시각의 차이(offsetSec)만큼 시계열을 민다. 영상 t = 채팅 t - offset */
export function shiftSeries(perSecond: number[], offsetSec: number, length: number): number[] {
  const out = new Array<number>(Math.max(0, length)).fill(0);
  const off = Math.round(offsetSec);
  for (let i = 0; i < perSecond.length; i++) {
    const j = i - off;
    if (j >= 0 && j < out.length) out[j] += perSecond[i];
  }
  return out;
}

export function binSeries(perSecond: number[], binSec: number): number[] {
  const n = Math.ceil(perSecond.length / binSec);
  const bins = new Array<number>(n).fill(0);
  for (let i = 0; i < perSecond.length; i++) bins[Math.floor(i / binSec)] += perSecond[i];
  return bins;
}

function median(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = n >> 1;
  return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * 각 bin에 대해 주변 창의 중앙값(평소)과 robust z-score를 계산한다.
 * 정렬된 창을 삽입/삭제로 유지해서 O(n·w) 정도로 끝난다. 4시간 방송(5초 bin)이 2,880개라 충분하다.
 */
export function robustScores(bins: number[], windowBins: number): { baseline: number[]; scores: number[] } {
  const n = bins.length;
  const half = Math.max(1, Math.floor(windowBins / 2));
  const baseline = new Array<number>(n).fill(0);
  const scores = new Array<number>(n).fill(0);
  const win: number[] = [];

  const insert = (v: number) => {
    let lo = 0;
    let hi = win.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (win[m] < v) lo = m + 1;
      else hi = m;
    }
    win.splice(lo, 0, v);
  };
  const remove = (v: number) => {
    let lo = 0;
    let hi = win.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (win[m] < v) lo = m + 1;
      else hi = m;
    }
    win.splice(lo, 1);
  };

  let left = 0;
  let right = -1;
  for (let i = 0; i < n; i++) {
    const wantL = Math.max(0, i - half);
    const wantR = Math.min(n - 1, i + half);
    while (right < wantR) insert(bins[++right]);
    while (left < wantL) remove(bins[left++]);

    const med = median(win);
    const devs = win.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
    const mad = median(devs);
    // 조용한 방송은 MAD가 0이 되기 쉽다. 포아송 잡음 수준(√평소)을 바닥으로 깔아 작은 흔들림을 걸러낸다.
    const scale = Math.max(1.4826 * mad, Math.sqrt(med), 1);
    baseline[i] = med;
    scores[i] = (bins[i] - med) / scale;
  }
  return { baseline, scores };
}

export function analyze(series: number[], durationSec: number, params: AnalysisParams): AnalysisResult {
  const { binSec } = params;
  const bins = binSeries(series, binSec);
  const windowBins = Math.max(3, Math.round(params.baselineWindowSec / binSec));
  const { baseline, scores } = robustScores(bins, windowBins);

  // 1) 임계값을 넘은 bin을 모아 가까운 것끼리 묶는다.
  type Group = { first: number; last: number; peak: number };
  const groups: Group[] = [];
  const gapBins = Math.max(0, Math.floor(params.mergeGapSec / binSec));
  for (let i = 0; i < scores.length; i++) {
    if (scores[i] < params.threshold) continue;
    const g = groups[groups.length - 1];
    if (g && i - g.last - 1 <= gapBins) {
      g.last = i;
      if (scores[i] > scores[g.peak]) g.peak = i;
    } else {
      groups.push({ first: i, last: i, peak: i });
    }
  }

  // 2) 반응 지연을 반영해 앞뒤 여유를 붙이고, 겹치면 합친다.
  type Raw = { start: number; end: number; peak: number };
  const raws: Raw[] = [];
  for (const g of groups) {
    const start = Math.max(0, g.first * binSec - params.preRollSec);
    const end = Math.min(durationSec, (g.last + 1) * binSec + params.postRollSec);
    const prev = raws[raws.length - 1];
    if (prev && start <= prev.end) {
      prev.end = Math.max(prev.end, end);
      if (scores[g.peak] > scores[prev.peak]) prev.peak = g.peak;
    } else {
      raws.push({ start, end, peak: g.peak });
    }
  }

  // 3) 점수를 매기고, 상위 maxSegments개만 시간순으로 돌려준다.
  const segs: Segment[] = raws
    .filter((r) => r.end > r.start)
    .map((r) => {
      let volume = 0;
      const a = Math.floor(r.start / binSec);
      const b = Math.min(bins.length - 1, Math.ceil(r.end / binSec) - 1);
      for (let i = a; i <= b; i++) volume += bins[i];
      return {
        id: `seg-${Math.round(r.start * 10)}-${Math.round(r.end * 10)}`,
        start: r.start,
        end: r.end,
        peakTime: r.peak * binSec + binSec / 2,
        score: round2(scores[r.peak]),
        volume: round2(volume),
        rank: 0,
      };
    })
    .sort((x, y) => y.score - x.score || y.volume - x.volume)
    .slice(0, params.maxSegments);

  segs.forEach((s, i) => (s.rank = i + 1));
  segs.sort((x, y) => x.start - y.start);

  return { binSec, bins, baseline, scores, segments: segs };
}

/**
 * 민감도를 바꾸면 후보 구간이 다시 계산된다.
 * 편집자가 이미 내린 판단(채택/제외)을 잃지 않도록, 새 구간이 가장 많이 겹치는 옛 구간의 판단을 물려받는다.
 */
export function carryDecisions(
  oldSegs: Segment[],
  oldDecisions: Record<string, Decision>,
  newSegs: Segment[],
): Record<string, Decision> {
  const out: Record<string, Decision> = {};
  for (const s of newSegs) {
    let best: Segment | undefined;
    let bestOverlap = 0;
    for (const o of oldSegs) {
      const ov = Math.min(s.end, o.end) - Math.max(s.start, o.start);
      if (ov > bestOverlap) {
        bestOverlap = ov;
        best = o;
      }
    }
    const d = best && bestOverlap >= 0.5 * Math.min(s.end - s.start, best.end - best.start) ? oldDecisions[best.id] : undefined;
    out[s.id] = d ?? 'pending';
  }
  return out;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** 0:12:34 형식 */
export function formatTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

/** HH:MM:SS:FF (non-drop). 29.97 같은 값은 반올림한 정수 fps로 계산한다. */
export function toTimecode(sec: number, fps: number): string {
  const f = Math.max(1, Math.round(fps));
  const total = Math.round(Math.max(0, sec) * f);
  const frames = total % f;
  const s = Math.floor(total / f);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}:${p(frames)}`;
}

/**
 * 채택한 구간을 CMX3600 EDL로 만든다. Premiere Pro, DaVinci Resolve에서 불러와 바로 이어서 편집할 수 있다.
 * 레코드 타임라인은 구간을 순서대로 이어 붙인 형태.
 */
export function buildEdl(title: string, clipName: string, segments: { start: number; end: number; note?: string }[], fps: number): string {
  const lines = [`TITLE: ${title}`, 'FCM: NON-DROP FRAME', ''];
  let rec = 0;
  segments.forEach((s, i) => {
    const dur = s.end - s.start;
    const num = String(i + 1).padStart(3, '0');
    lines.push(
      `${num}  AX       AA/V  C        ${toTimecode(s.start, fps)} ${toTimecode(s.end, fps)} ${toTimecode(rec, fps)} ${toTimecode(rec + dur, fps)}`,
    );
    lines.push(`* FROM CLIP NAME: ${clipName}`);
    if (s.note) lines.push(`* COMMENT: ${s.note}`);
    lines.push('');
    rec += dur;
  });
  return lines.join('\n');
}
