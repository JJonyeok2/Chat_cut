/**
 * 채팅 반응 타임라인 (canvas).
 * - 반응량 그래프, 평소 수준(점선), 후보 구간, 재생 위치를 그린다.
 * - 클릭/드래그: 해당 시점으로 이동, 후보 위를 누르면 그 후보 선택
 * - 휠: 커서 기준 확대/축소, Shift+휠 또는 가로 스크롤: 좌우 이동, 더블클릭: 전체 보기
 * 몇 시간짜리 방송도 픽셀당 최댓값만 그리므로 확대 수준과 관계없이 그리는 양이 화면 폭에 비례한다.
 */
import { formatTime } from '../shared/analysis.js';
import type { AnalysisResult, Decision, Segment } from '../shared/types.js';

export interface TimelineData {
  duration: number;
  analysis: AnalysisResult | null;
  decisions: Record<string, Decision>;
  selectedId: string | null;
}

interface Callbacks {
  onSeek(t: number): void;
  onSelect(id: string): void;
}

const RULER_H = 22;
const COLORS = {
  bg: '#14171d',
  grid: 'rgba(255,255,255,0.05)',
  ruler: '#8b93a3',
  area: 'rgba(124, 154, 255, 0.55)',
  areaTop: '#9db2ff',
  baseline: 'rgba(255,255,255,0.35)',
  playhead: '#ff5a5f',
  hover: 'rgba(255,255,255,0.4)',
  pending: [255, 196, 87],
  accepted: [74, 222, 128],
  rejected: [120, 126, 138],
} as const;

export class Timeline {
  private ctx: CanvasRenderingContext2D;
  private data: TimelineData = { duration: 0, analysis: null, decisions: {}, selectedId: null };
  private viewStart = 0;
  private viewEnd = 0;
  private time = 0;
  private hoverX: number | null = null;
  private dragging = false;
  private dirty = true;

  constructor(private canvas: HTMLCanvasElement, private cb: Callbacks) {
    this.ctx = canvas.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(canvas);
    canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    canvas.addEventListener('pointerup', (e) => {
      this.dragging = false;
      canvas.releasePointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointerleave', () => {
      this.hoverX = null;
      this.dirty = true;
    });
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    canvas.addEventListener('dblclick', () => this.resetView());
    const loop = () => {
      if (this.dirty) this.draw();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  setData(d: TimelineData): void {
    const durationChanged = d.duration !== this.data.duration;
    this.data = d;
    if (durationChanged) this.resetView();
    this.dirty = true;
  }

  setTime(t: number): void {
    if (Math.abs(t - this.time) < 0.01) return;
    this.time = t;
    // 재생 위치가 화면 밖으로 나가면 따라간다.
    const span = this.viewEnd - this.viewStart;
    if (span > 0 && span < this.data.duration && (t > this.viewEnd || t < this.viewStart)) {
      this.viewStart = Math.max(0, Math.min(this.data.duration - span, t - span * 0.1));
      this.viewEnd = this.viewStart + span;
    }
    this.dirty = true;
  }

  /** 특정 구간이 보이도록 화면을 옮긴다 */
  reveal(seg: Segment): void {
    const span = this.viewEnd - this.viewStart;
    if (seg.start >= this.viewStart && seg.end <= this.viewEnd) return;
    const mid = (seg.start + seg.end) / 2;
    this.viewStart = Math.max(0, Math.min(this.data.duration - span, mid - span / 2));
    this.viewEnd = this.viewStart + span;
    this.dirty = true;
  }

  resetView(): void {
    this.viewStart = 0;
    this.viewEnd = this.data.duration;
    this.dirty = true;
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const r = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.dirty = true;
  }

  private get w(): number {
    return this.canvas.clientWidth;
  }
  private get h(): number {
    return this.canvas.clientHeight;
  }
  private xToT(x: number): number {
    return this.viewStart + (x / this.w) * (this.viewEnd - this.viewStart);
  }
  private tToX(t: number): number {
    return ((t - this.viewStart) / (this.viewEnd - this.viewStart)) * this.w;
  }

  private segmentAt(t: number): Segment | undefined {
    return this.data.analysis?.segments.find((s) => t >= s.start && t <= s.end);
  }

  private onDown(e: PointerEvent): void {
    if (!this.data.duration) return;
    this.canvas.setPointerCapture(e.pointerId);
    this.dragging = true;
    const t = this.clampT(this.xToT(e.offsetX));
    const seg = e.offsetY > RULER_H ? this.segmentAt(t) : undefined;
    if (seg) this.cb.onSelect(seg.id);
    this.cb.onSeek(t);
  }

  private onMove(e: PointerEvent): void {
    this.hoverX = e.offsetX;
    this.dirty = true;
    if (this.dragging) this.cb.onSeek(this.clampT(this.xToT(e.offsetX)));
  }

  private onWheel(e: WheelEvent): void {
    if (!this.data.duration) return;
    e.preventDefault();
    const span = this.viewEnd - this.viewStart;
    const horizontal = e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY);
    if (horizontal) {
      const d = ((e.shiftKey ? e.deltaY : e.deltaX) / this.w) * span;
      this.viewStart = Math.max(0, Math.min(this.data.duration - span, this.viewStart + d));
      this.viewEnd = this.viewStart + span;
    } else {
      const anchor = this.xToT(e.offsetX);
      const factor = Math.exp(e.deltaY * 0.002);
      const newSpan = Math.max(20, Math.min(this.data.duration, span * factor));
      const ratio = (anchor - this.viewStart) / span;
      this.viewStart = Math.max(0, Math.min(this.data.duration - newSpan, anchor - ratio * newSpan));
      this.viewEnd = this.viewStart + newSpan;
    }
    this.dirty = true;
  }

  private clampT(t: number): number {
    return Math.max(0, Math.min(this.data.duration, t));
  }

  private draw(): void {
    this.dirty = false;
    const { ctx, w, h } = this;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, w, h);
    const { duration, analysis } = this.data;
    if (!duration || this.viewEnd <= this.viewStart) {
      ctx.fillStyle = COLORS.ruler;
      ctx.font = '13px -apple-system, "Apple SD Gothic Neo", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('채팅 로그를 불러오면 반응 그래프가 여기에 그려집니다', w / 2, h / 2);
      return;
    }

    this.drawRuler();
    const top = RULER_H + 6;
    const bottom = h - 4;
    const gh = bottom - top;

    if (analysis) {
      // 후보 구간 배경
      for (const s of analysis.segments) this.drawSegment(s, top, gh);

      // 반응량: 픽셀 열마다 그 안의 최댓값
      const { bins, baseline, binSec } = analysis;
      const cols = Math.max(1, Math.floor(w));
      const vals = new Float32Array(cols);
      const base = new Float32Array(cols);
      let vmax = 1;
      for (let x = 0; x < cols; x++) {
        const a = Math.max(0, Math.floor(this.xToT(x) / binSec));
        const b = Math.min(bins.length - 1, Math.max(a, Math.floor(this.xToT(x + 1) / binSec)));
        let m = 0;
        let bm = 0;
        for (let i = a; i <= b; i++) {
          if (bins[i] > m) m = bins[i];
          bm = Math.max(bm, baseline[i] ?? 0);
        }
        vals[x] = m;
        base[x] = bm;
      }
      for (const v of bins) if (v > vmax) vmax = v;
      const y = (v: number) => bottom - (v / (vmax * 1.08)) * gh;

      const grad = ctx.createLinearGradient(0, top, 0, bottom);
      grad.addColorStop(0, COLORS.area);
      grad.addColorStop(1, 'rgba(124,154,255,0.06)');
      ctx.beginPath();
      ctx.moveTo(0, bottom);
      for (let x = 0; x < cols; x++) ctx.lineTo(x + 0.5, y(vals[x]));
      ctx.lineTo(cols, bottom);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.beginPath();
      for (let x = 0; x < cols; x++) (x ? ctx.lineTo : ctx.moveTo).call(ctx, x + 0.5, y(vals[x]));
      ctx.strokeStyle = COLORS.areaTop;
      ctx.lineWidth = 1;
      ctx.stroke();

      // 평소 수준
      ctx.beginPath();
      for (let x = 0; x < cols; x++) (x ? ctx.lineTo : ctx.moveTo).call(ctx, x + 0.5, y(base[x]));
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = COLORS.baseline;
      ctx.stroke();
      ctx.setLineDash([]);

      // 후보 번호
      ctx.font = '600 11px -apple-system, sans-serif';
      ctx.textAlign = 'left';
      for (const s of analysis.segments) {
        const x0 = this.tToX(s.start);
        const x1 = this.tToX(s.end);
        if (x1 < 0 || x0 > w || x1 - x0 < 16) continue;
        const d = this.data.decisions[s.id] ?? 'pending';
        ctx.fillStyle = rgba(COLORS[d], 1);
        ctx.fillText(`#${s.rank}`, Math.max(2, x0 + 3), top + 12);
      }
    }

    // 마우스 위치
    if (this.hoverX !== null && analysis) {
      const t = this.xToT(this.hoverX);
      const bin = analysis.bins[Math.floor(t / analysis.binSec)] ?? 0;
      ctx.fillStyle = COLORS.hover;
      ctx.fillRect(Math.round(this.hoverX), RULER_H, 1, h - RULER_H);
      const label = `${formatTime(t)}  ·  ${bin.toFixed(0)} / ${analysis.binSec}초`;
      ctx.font = '12px "SF Mono", Menlo, monospace';
      const tw = ctx.measureText(label).width + 12;
      const lx = Math.min(w - tw - 2, Math.max(2, this.hoverX + 8));
      ctx.fillStyle = 'rgba(10,12,16,0.92)';
      ctx.fillRect(lx, h - 26, tw, 20);
      ctx.fillStyle = '#e6e9ef';
      ctx.textAlign = 'left';
      ctx.fillText(label, lx + 6, h - 12);
    }

    // 재생 위치
    const px = this.tToX(this.time);
    if (px >= 0 && px <= w) {
      ctx.fillStyle = COLORS.playhead;
      ctx.fillRect(Math.round(px) - 1, 0, 2, h);
      ctx.beginPath();
      ctx.moveTo(px - 6, 0);
      ctx.lineTo(px + 6, 0);
      ctx.lineTo(px, 8);
      ctx.fill();
    }
  }

  private drawSegment(s: Segment, top: number, gh: number): void {
    const { ctx } = this;
    const x0 = this.tToX(s.start);
    const x1 = this.tToX(s.end);
    if (x1 < 0 || x0 > this.w) return;
    const d = this.data.decisions[s.id] ?? 'pending';
    const c = COLORS[d];
    const width = Math.max(2, x1 - x0);
    ctx.fillStyle = rgba(c, d === 'rejected' ? 0.08 : 0.16);
    ctx.fillRect(x0, top, width, gh);
    ctx.fillStyle = rgba(c, d === 'rejected' ? 0.4 : 0.95);
    ctx.fillRect(x0, top - 4, width, 3);
    if (s.id === this.data.selectedId) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x0 + 0.75, top - 4, width - 1.5, gh + 4);
    }
  }

  private drawRuler(): void {
    const { ctx, w } = this;
    const span = this.viewEnd - this.viewStart;
    const steps = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
    const step = steps.find((s) => (s / span) * w > 90) ?? 7200;
    ctx.font = '11px "SF Mono", Menlo, monospace';
    ctx.textAlign = 'left';
    for (let t = Math.ceil(this.viewStart / step) * step; t <= this.viewEnd; t += step) {
      const x = Math.round(this.tToX(t)) + 0.5;
      ctx.fillStyle = COLORS.grid;
      ctx.fillRect(x, RULER_H, 1, this.h - RULER_H);
      ctx.fillStyle = COLORS.ruler;
      ctx.fillRect(x, RULER_H - 6, 1, 6);
      ctx.fillText(formatTime(t), x + 4, 14);
    }
  }
}

function rgba(c: readonly number[], a: number): string {
  return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}
