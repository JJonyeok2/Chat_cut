import { api } from './api.js';
import { createStore, initialState, visibleSegments, type Filter, type State } from './store.js';
import { Timeline } from './timeline.js';
import { buildEdl, formatTime } from '../shared/analysis.js';
import type { ChatLoadResult, ChatSample, Decision, Segment, VideoInfo } from '../shared/types.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { className?: string; dataset?: Record<string, string> } = {},
  ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  const { dataset, ...rest } = props;
  Object.assign(node, rest);
  if (dataset) Object.assign(node.dataset, dataset);
  for (const c of children) if (c !== null && c !== undefined) node.append(c);
  return node;
}

const store = createStore(initialState);
const player = $<HTMLVideoElement>('player');
const timeline = new Timeline($<HTMLCanvasElement>('timeline'), {
  onSeek: (t) => seek(t),
  onSelect: (id) => store.dispatch({ type: 'select', id }),
});

/** 구간 미리보기: 이 시각에 도달하면 멈춘다 */
let previewEnd: number | null = null;
/** 영상이 없을 때 쓰는 가상 재생 위치 */
let virtualTime = 0;

// ---------------------------------------------------------------- 불러오기

function onVideo(v: VideoInfo | null | undefined): void {
  if (!v) return;
  player.src = v.url;
  store.dispatch({ type: 'videoLoaded', video: v });
}

function onChat(c: ChatLoadResult | null | undefined): void {
  if (!c) return;
  store.dispatch({ type: 'chatLoaded', chat: c });
  const n = store.getState().analysis?.segments.length ?? 0;
  toast(`메시지 ${c.totalMessages.toLocaleString()}개를 읽었습니다. 편집점 후보 ${n}개를 찾았습니다.`);
  if (c.timeMode === 'clock') {
    toast('채팅 로그가 시각(시:분:초) 기준이라 첫 메시지를 0초로 맞췄습니다. 영상과 어긋나면 채팅 싱크 값을 조정해 주세요.', 7000);
  }
}

async function withBusy<T>(text: string, fn: () => Promise<T>): Promise<T | undefined> {
  store.dispatch({ type: 'status', status: { kind: 'busy', text } });
  try {
    return await fn();
  } catch (e) {
    toast(`문제가 생겼습니다: ${(e as Error).message}`, 6000, true);
    return undefined;
  } finally {
    store.dispatch({ type: 'status', status: null });
  }
}

$('btnVideo').addEventListener('click', async () => onVideo(await withBusy('영상 정보를 읽는 중', () => api().openVideo())));
$('btnChat').addEventListener('click', async () => onChat(await withBusy('채팅 로그를 읽는 중', () => api().openChat())));
for (const id of ['btnSample', 'emptySample']) {
  $(id).addEventListener('click', async () => {
    const r = await withBusy('샘플을 불러오는 중', () => api().loadSample());
    if (!r) return;
    if (r.error) return toast(r.error, 6000, true);
    onVideo(r.video);
    onChat(r.chat);
  });
}
$('emptyVideo').addEventListener('click', () => $('btnVideo').click());
$('emptyChat').addEventListener('click', () => $('btnChat').click());

api().onChatProgress((ratio) => {
  const s = store.getState().status;
  if (s?.kind === 'busy') store.dispatch({ type: 'status', status: { kind: 'busy', text: `채팅 로그를 읽는 중 ${Math.round(ratio * 100)}%` } });
});

// 끌어다 놓기
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  document.body.classList.add('dragging');
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) document.body.classList.remove('dragging');
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  const paths = [...(e.dataTransfer?.files ?? [])].map((f) => api().pathForFile(f)).filter(Boolean);
  if (!paths.length) return;
  const r = await withBusy('파일을 읽는 중', () => api().openPaths(paths));
  if (!r) return;
  onVideo(r.video);
  onChat(r.chat);
  if (r.unknown.length) toast(`형식을 알 수 없는 파일: ${r.unknown.join(', ')}`, 5000, true);
});

player.addEventListener('loadedmetadata', () => {
  if (Number.isFinite(player.duration)) store.dispatch({ type: 'videoDuration', durationSec: player.duration });
});
player.addEventListener('error', () => toast('이 영상은 미리보기로 재생할 수 없는 코덱입니다. 분석과 내보내기는 그대로 쓸 수 있습니다.', 6000, true));

// ---------------------------------------------------------------- 재생

function hasVideo(): boolean {
  return Boolean(store.getState().video);
}

function currentTime(): number {
  return hasVideo() ? player.currentTime : virtualTime;
}

function seek(t: number): void {
  const d = store.getState().duration;
  const v = Math.max(0, Math.min(d || t, t));
  previewEnd = null;
  if (hasVideo()) player.currentTime = v;
  else virtualTime = v;
  timeline.setTime(v);
}

function togglePlay(): void {
  if (!hasVideo()) return;
  previewEnd = null;
  if (player.paused) void player.play();
  else player.pause();
}

function preview(seg: Segment): void {
  if (!hasVideo()) return seek(seg.start);
  player.currentTime = seg.start;
  previewEnd = seg.end;
  void player.play();
}

$('btnPlay').addEventListener('click', togglePlay);
player.addEventListener('play', () => ($('btnPlay').textContent = '❚❚'));
player.addEventListener('pause', () => ($('btnPlay').textContent = '▶'));

function tick(): void {
  const t = currentTime();
  if (previewEnd !== null && t >= previewEnd) {
    player.pause();
    previewEnd = null;
  }
  timeline.setTime(t);
  $('clock').textContent = `${formatTime(t)} / ${formatTime(store.getState().duration)}`;
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ---------------------------------------------------------------- 후보 선택과 판단

function selectSegment(seg: Segment | undefined, play = false): void {
  if (!seg) return;
  store.dispatch({ type: 'select', id: seg.id });
  timeline.reveal(seg);
  if (play) preview(seg);
  else seek(seg.start);
  document.querySelector(`[data-id="${seg.id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function decide(id: string, decision: Decision): void {
  const cur = store.getState().decisions[id];
  store.dispatch({ type: 'decide', id, decision: cur === decision ? 'pending' : decision });
}

function moveSelection(dir: 1 | -1): void {
  const s = store.getState();
  const segs = visibleSegments(s);
  if (!segs.length) return;
  const idx = segs.findIndex((x) => x.id === s.selectedId);
  let next: Segment | undefined;
  if (idx === -1) {
    const t = currentTime();
    next = dir === 1 ? segs.find((x) => x.start > t + 0.5) ?? segs[0] : [...segs].reverse().find((x) => x.start < t - 0.5) ?? segs[segs.length - 1];
  } else {
    next = segs[Math.max(0, Math.min(segs.length - 1, idx + dir))];
  }
  selectSegment(next);
}

function selected(): Segment | undefined {
  const s = store.getState();
  return s.analysis?.segments.find((x) => x.id === s.selectedId);
}

window.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement;
  if (target.tagName === 'INPUT' && (target as HTMLInputElement).type !== 'range' && (target as HTMLInputElement).type !== 'checkbox') return;
  if (e.metaKey || e.ctrlKey) return;
  const seg = selected();
  switch (e.key) {
    case ' ':
      e.preventDefault();
      togglePlay();
      break;
    case 'ArrowLeft':
      e.preventDefault();
      seek(currentTime() - (e.shiftKey ? 1 : 5));
      break;
    case 'ArrowRight':
      e.preventDefault();
      seek(currentTime() + (e.shiftKey ? 1 : 5));
      break;
    case 'ArrowDown':
    case 'j':
      e.preventDefault();
      moveSelection(1);
      break;
    case 'ArrowUp':
    case 'k':
      e.preventDefault();
      moveSelection(-1);
      break;
    case 'a':
      if (seg) {
        decide(seg.id, 'accepted');
        moveSelection(1);
      }
      break;
    case 'x':
      if (seg) {
        decide(seg.id, 'rejected');
        moveSelection(1);
      }
      break;
    case 'u':
      if (seg) store.dispatch({ type: 'decide', id: seg.id, decision: 'pending' });
      break;
    case 'p':
      if (seg) preview(seg);
      break;
  }
});

// ---------------------------------------------------------------- 분석 조절

const sens = $<HTMLInputElement>('sens');
const preroll = $<HTMLInputElement>('preroll');
const offset = $<HTMLInputElement>('offset');
const weighted = $<HTMLInputElement>('weighted');

// 민감도 슬라이더는 높을수록 후보가 많아지게: threshold = 13 - 값
sens.addEventListener('input', () => store.dispatch({ type: 'setParams', params: { threshold: 13 - Number(sens.value) } }));
preroll.addEventListener('input', () => store.dispatch({ type: 'setParams', params: { preRollSec: Number(preroll.value) } }));
weighted.addEventListener('change', () => store.dispatch({ type: 'setParams', params: { useWeighted: weighted.checked } }));
offset.addEventListener('change', () => store.dispatch({ type: 'setOffset', offsetSec: Number(offset.value) || 0 }));
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-nudge]')) {
  b.addEventListener('click', () => store.dispatch({ type: 'setOffset', offsetSec: store.getState().offsetSec + Number(b.dataset.nudge) }));
}
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-filter]')) {
  b.addEventListener('click', () => store.dispatch({ type: 'setFilter', filter: b.dataset.filter as Filter }));
}

// ---------------------------------------------------------------- 내보내기

function acceptedSegments(): Segment[] {
  const s = store.getState();
  return (s.analysis?.segments ?? []).filter((x) => s.decisions[x.id] === 'accepted');
}

$('btnEdl').addEventListener('click', async () => {
  const s = store.getState();
  const segs = acceptedSegments();
  if (!segs.length) return toast('채택한 후보가 없습니다. 후보를 확인하고 A 키로 채택해 주세요.', 4000, true);
  const clipName = s.video?.name ?? s.chat?.name ?? 'source';
  const edl = buildEdl(
    'Chatcut selects',
    clipName,
    segs.map((x) => ({ start: x.start, end: x.end, note: `chatcut #${x.rank} reaction z=${x.score}` })),
    s.video?.fps ?? 30,
  );
  const base = clipName.replace(/\.[^.]+$/, '');
  const saved = await api().saveEdl(edl, `${base}_chatcut.edl`);
  if (saved) toast(`EDL을 저장했습니다. Premiere Pro나 DaVinci Resolve에서 불러오면 채택한 ${segs.length}개 구간이 타임라인에 놓입니다.`, 6000);
});

$('btnClips').addEventListener('click', async () => {
  const s = store.getState();
  const segs = acceptedSegments();
  if (!s.video) return toast('클립을 자르려면 원본 영상이 필요합니다.', 4000, true);
  if (!segs.length) return toast('채택한 후보가 없습니다. 후보를 확인하고 A 키로 채택해 주세요.', 4000, true);
  const overlay = $('overlay');
  const off = api().onClipProgress((p) => {
    $('overlayText').textContent = p.file ? `${p.index + 1} / ${p.total}  ${p.file}` : '마무리하는 중';
    $<HTMLProgressElement>('overlayBar').value = p.index / p.total;
  });
  overlay.hidden = false;
  try {
    const r = await api().exportClips(
      s.video.path,
      segs.map((x) => ({ start: x.start, end: x.end, label: `rank${x.rank}_${formatTime(x.start).replace(/:/g, '-')}` })),
    );
    if (r && r.files.length) {
      toast(`${r.canceled ? '중단 전까지 ' : ''}클립 ${r.files.length}개를 저장했습니다.`, 5000);
      void api().reveal(r.files[0]);
    }
  } catch (e) {
    toast((e as Error).message, 7000, true);
  } finally {
    off();
    overlay.hidden = true;
  }
});
$('overlayCancel').addEventListener('click', () => void api().cancelClips());

// ---------------------------------------------------------------- 그리기

function samplesFor(s: State, seg: Segment): ChatSample[] {
  const chat = s.chat;
  if (!chat) return [];
  const bucket = chat.sampleBucketSec;
  const peak = Math.floor((seg.peakTime + s.offsetSec) / bucket);
  const lo = Math.floor((seg.start + s.offsetSec) / bucket);
  const hi = Math.floor((seg.end + s.offsetSec) / bucket);
  // 반응이 가장 몰린 지점에 가깝고, 반응 표현이 강한 메시지를 고른다
  const pool: { m: ChatSample; rank: number }[] = [];
  for (let b = lo; b <= hi; b++) {
    for (const m of chat.samples[b] ?? []) {
      if (m.text) pool.push({ m, rank: (m.w ?? 1) * 10 - Math.abs(b - peak) });
    }
  }
  const seen = new Set<string>();
  return pool
    .sort((x, y) => y.rank - x.rank)
    .filter((x) => !seen.has(x.m.text) && Boolean(seen.add(x.m.text)))
    .slice(0, 3)
    .map((x) => x.m)
    .sort((x, y) => x.t - y.t);
}

function meterBar(ratio: number): HTMLElement {
  const bar = el('i');
  bar.style.width = `${Math.min(100, Math.max(4, ratio * 100))}%`;
  return bar;
}

const DECISION_LABEL: Record<Decision, string> = { pending: '검토 전', accepted: '채택', rejected: '제외' };

function renderList(s: State): void {
  const list = $('segList');
  list.replaceChildren();
  const segs = visibleSegments(s);
  const maxScore = Math.max(1, ...(s.analysis?.segments.map((x) => x.score) ?? [1]));

  if (!s.analysis) {
    list.append(el('li', { className: 'seg-empty' }, '채팅 로그를 불러오면 반응이 몰린 구간이 여기에 나열됩니다.'));
    return;
  }
  if (!segs.length) {
    list.append(
      el('li', { className: 'seg-empty' }, s.analysis.segments.length ? '이 필터에 해당하는 후보가 없습니다.' : '후보가 없습니다. 민감도를 올려 보세요.'),
    );
    return;
  }

  for (const seg of segs) {
    const d = s.decisions[seg.id] ?? 'pending';
    const quotes = samplesFor(s, seg).map((m) => el('li', {}, el('b', {}, m.user || '익명'), ' ', m.text));
    const btn = (label: string, key: string, cls: string, fn: () => void) => {
      const b = el('button', { className: `seg-btn ${cls}`, title: `${label} (${key})` }, label, el('kbd', {}, key));
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        fn();
      });
      return b;
    };
    const item = el(
      'li',
      { className: `seg ${d} ${seg.id === s.selectedId ? 'selected' : ''}`, dataset: { id: seg.id } },
      el(
        'div',
        { className: 'seg-top' },
        el('span', { className: 'rank' }, `#${seg.rank}`),
        el('span', { className: 'range mono' }, `${formatTime(seg.start)} – ${formatTime(seg.end)}`),
        el('span', { className: 'dur' }, `${Math.round(seg.end - seg.start)}초`),
        el('span', { className: `badge ${d}` }, DECISION_LABEL[d]),
      ),
      el(
        'div',
        { className: 'meter', title: `평소 대비 반응 점수 ${seg.score}` },
        meterBar(seg.score / maxScore),
        el('span', { className: 'mono' }, `z ${seg.score.toFixed(1)}`),
      ),
      quotes.length ? el('ul', { className: 'quotes' }, ...quotes) : null,
      el(
        'div',
        { className: 'seg-actions' },
        btn('미리보기', 'P', '', () => {
          selectSegment(seg, true);
        }),
        btn(d === 'accepted' ? '채택 취소' : '채택', 'A', 'ok', () => decide(seg.id, 'accepted')),
        btn(d === 'rejected' ? '제외 취소' : '제외', 'X', 'no', () => decide(seg.id, 'rejected')),
      ),
    );
    item.addEventListener('click', () => selectSegment(seg));
    list.append(item);
  }
}

function render(s: State, prev: State): void {
  // 상단 파일 정보
  $('videoName').textContent = s.video ? s.video.name : '열기';
  $('chatName').textContent = s.chat ? `${s.chat.name} · ${s.chat.totalMessages.toLocaleString()}개` : '열기';
  $('btnVideo').classList.toggle('loaded', Boolean(s.video));
  $('btnChat').classList.toggle('loaded', Boolean(s.chat));
  $('empty').hidden = Boolean(s.video);
  $('emptyVideo').classList.toggle('done', Boolean(s.video));
  $('emptyChat').classList.toggle('done', Boolean(s.chat));
  $('noVideoNote').hidden = !(s.chat && !s.video);

  // 분석 조절 값
  sens.value = String(13 - s.params.threshold);
  $('sensVal').textContent = `z ≥ ${s.params.threshold.toFixed(1)}`;
  preroll.value = String(s.params.preRollSec);
  $('prerollVal').textContent = `${s.params.preRollSec}초`;
  if (document.activeElement !== offset) offset.value = String(s.offsetSec);
  weighted.checked = s.params.useWeighted;

  // 개수
  const segs = s.analysis?.segments ?? [];
  const count = (d: Decision) => segs.filter((x) => (s.decisions[x.id] ?? 'pending') === d).length;
  $('counts').textContent = segs.length ? `후보 ${segs.length} · 채택 ${count('accepted')} · 제외 ${count('rejected')}` : '';
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-filter]')) b.classList.toggle('active', b.dataset.filter === s.filter);
  const acc = segs.filter((x) => s.decisions[x.id] === 'accepted');
  const total = acc.reduce((sum, x) => sum + (x.end - x.start), 0);
  $('acceptSummary').textContent = acc.length ? `채택 ${acc.length}개 · 합계 ${formatTime(total)}` : '채택한 구간이 아직 없습니다';
  $<HTMLButtonElement>('btnEdl').disabled = !acc.length;
  $<HTMLButtonElement>('btnClips').disabled = !acc.length || !s.video;

  // 상태
  const status = $('status');
  status.hidden = !s.status;
  status.textContent = s.status?.text ?? '';

  if (
    s.analysis !== prev.analysis ||
    s.decisions !== prev.decisions ||
    s.selectedId !== prev.selectedId ||
    s.filter !== prev.filter ||
    s.chat !== prev.chat
  ) {
    renderList(s);
  }
  timeline.setData({ duration: s.duration, analysis: s.analysis, decisions: s.decisions, selectedId: s.selectedId });
}

store.subscribe(render);
render(store.getState(), { ...store.getState(), analysis: undefined as never });

// ---------------------------------------------------------------- 알림

function toast(text: string, ms = 3500, error = false): void {
  const box = $('toasts');
  const t = el('div', { className: `toast ${error ? 'error' : ''}` }, text);
  box.append(t);
  setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 300);
  }, ms);
}
