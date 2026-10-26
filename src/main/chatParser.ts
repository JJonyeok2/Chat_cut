/**
 * 채팅 로그 파서.
 *
 * 몇 시간짜리 방송 채팅은 수십만 줄이 될 수 있어서, 텍스트 로그는 한 줄씩 스트리밍으로 읽고
 * 메시지 전체를 메모리에 들고 있지 않는다. 대신 1초 단위 카운트와 구간별 대표 메시지 몇 개만 남긴다.
 *
 * 지원 형식
 * - 텍스트: "[0:12:34] 닉네임: 메시지", "[2026-10-20 21:03:11] 닉네임: 메시지", "12:34 닉네임: 메시지"
 * - JSON 배열: [{ "time": 754, "user": "...", "message": "..." }] (time은 초 또는 "0:12:34")
 * - TwitchDownloader JSON: { "comments": [{ "content_offset_seconds", "commenter", "message": { "body" } }] }
 * - NDJSON: 한 줄에 JSON 객체 하나
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { reactionWeight } from '../shared/analysis.js';
import type { ChatLoadResult, ChatSample, TimeMode } from '../shared/types.js';

const SAMPLE_BUCKET_SEC = 5;
const SAMPLES_PER_BUCKET = 4;
const MAX_JSON_BYTES = 300 * 1024 * 1024;

const LINE_RE =
  /^\s*\[?\s*(?:(\d{4})[-./](\d{1,2})[-./](\d{1,2})[ T,]+)?(\d{1,2}):(\d{2})(?::(\d{2}))?(?:[.,]\d+)?\s*\]?\s*[-|,]?\s*(.*)$/;

interface Msg {
  t: number;
  user: string;
  text: string;
}

class Accumulator {
  perSecond: number[] = [];
  perSecondWeighted: number[] = [];
  samples: Record<number, ChatSample[]> = {};
  total = 0;
  skipped = 0;
  private base: number | null = null;
  private lastRaw = -Infinity;
  private dayCarry = 0;

  constructor(private mode: TimeMode) {}

  add(m: Msg): void {
    let raw = m.t;
    if (this.mode === 'clock') {
      // 자정을 넘기는 방송: 시각이 12시간 이상 뒤로 가면 하루를 더한다.
      if (raw + this.dayCarry < this.lastRaw - 43200) this.dayCarry += 86400;
      raw += this.dayCarry;
      this.lastRaw = raw;
      if (this.base === null) this.base = raw;
      raw -= this.base;
    }
    if (!Number.isFinite(raw) || raw < 0) {
      this.skipped++;
      return;
    }
    const sec = Math.floor(raw);
    while (this.perSecond.length <= sec) {
      this.perSecond.push(0);
      this.perSecondWeighted.push(0);
    }
    this.perSecond[sec] += 1;
    const w = reactionWeight(m.text);
    this.perSecondWeighted[sec] += w;
    this.total++;

    // 버킷마다 대표 메시지 몇 개만 남긴다. 자리가 차면 반응 표현이 더 강한 메시지로 바꿔 끼운다.
    const bucket = Math.floor(sec / SAMPLE_BUCKET_SEC);
    const list = (this.samples[bucket] ??= []);
    const sample: ChatSample = { t: raw, user: m.user, text: m.text.slice(0, 120), w };
    if (list.length < SAMPLES_PER_BUCKET) {
      list.push(sample);
    } else {
      let min = 0;
      for (let i = 1; i < list.length; i++) if ((list[i].w ?? 1) < (list[min].w ?? 1)) min = i;
      if (w > (list[min].w ?? 1)) list[min] = sample;
    }
  }
}

function hmsToSec(h: number, m: number, s: number): number {
  return h * 3600 + m * 60 + s;
}

/** "0:12:34", "12:34", "754", 754 → 초 */
function parseTimeValue(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const parts = s.split(':').map(Number);
  if (parts.some((p) => Number.isNaN(p))) {
    const d = Date.parse(s);
    return Number.isNaN(d) ? null : d / 1000;
  }
  if (parts.length === 3) return hmsToSec(parts[0], parts[1], parts[2]);
  if (parts.length === 2) return hmsToSec(0, parts[0], parts[1]);
  return null;
}

function pick(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) if (obj[k] !== undefined) return obj[k];
  return undefined;
}

function objToMsg(o: Record<string, unknown>): Msg | null {
  // TwitchDownloader 형식
  if (o.content_offset_seconds !== undefined) {
    const body = (o.message as { body?: string } | undefined)?.body ?? '';
    const user = (o.commenter as { display_name?: string } | undefined)?.display_name ?? '';
    return { t: Number(o.content_offset_seconds), user, text: body };
  }
  const t = parseTimeValue(pick(o, ['t', 'time', 'offset', 'seconds', 'sec', 'timestamp', 'ts']));
  if (t === null) return null;
  const textRaw = pick(o, ['message', 'text', 'msg', 'body', 'content', 'chat']);
  const text = typeof textRaw === 'string' ? textRaw : typeof textRaw === 'object' && textRaw ? String((textRaw as { body?: unknown }).body ?? '') : '';
  const userRaw = pick(o, ['user', 'nick', 'nickname', 'name', 'author', 'username']);
  const user = typeof userRaw === 'string' ? userRaw : '';
  return { t, user, text };
}

/** 벽시계 시각(Unix 초 등)으로 보이는지 */
function looksLikeClock(firstT: number): boolean {
  return firstT > 1e9;
}

function finish(acc: Accumulator, file: string, format: string, mode: TimeMode): ChatLoadResult {
  return {
    path: file,
    name: path.basename(file),
    format,
    timeMode: mode,
    totalMessages: acc.total,
    skippedLines: acc.skipped,
    durationSec: acc.perSecond.length,
    perSecond: acc.perSecond,
    perSecondWeighted: acc.perSecondWeighted,
    samples: acc.samples,
    sampleBucketSec: SAMPLE_BUCKET_SEC,
  };
}

function parseJsonDocument(file: string, raw: string): ChatLoadResult {
  const doc = JSON.parse(raw) as unknown;
  const list: unknown[] = Array.isArray(doc)
    ? doc
    : Array.isArray((doc as { comments?: unknown[] }).comments)
      ? (doc as { comments: unknown[] }).comments
      : Array.isArray((doc as { messages?: unknown[] }).messages)
        ? (doc as { messages: unknown[] }).messages
        : [];
  const isTwitch = !Array.isArray(doc) && Array.isArray((doc as { comments?: unknown[] }).comments);
  const msgs: Msg[] = [];
  let skipped = 0;
  for (const item of list) {
    const m = item && typeof item === 'object' ? objToMsg(item as Record<string, unknown>) : null;
    if (m) msgs.push(m);
    else skipped++;
  }
  msgs.sort((a, b) => a.t - b.t);
  const mode: TimeMode = msgs.length && looksLikeClock(msgs[0].t) ? 'clock' : 'elapsed';
  const acc = new Accumulator(mode);
  acc.skipped = skipped;
  for (const m of msgs) acc.add(m);
  return finish(acc, file, isTwitch ? 'twitch-json' : 'json-array', mode);
}

export function parseTextLine(line: string): { t: number; hasDate: boolean; user: string; text: string } | null {
  const m = LINE_RE.exec(line);
  if (!m) return null;
  const [, y, mo, d, a, b, c, rest] = m;
  let t: number;
  const hasDate = Boolean(y);
  if (hasDate) {
    t = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(a), Number(b), Number(c ?? 0)) / 1000;
  } else if (c !== undefined) {
    t = hmsToSec(Number(a), Number(b), Number(c));
  } else {
    t = hmsToSec(0, Number(a), Number(b)); // 두 자리면 분:초로 본다
  }
  const sep = rest.search(/:\s|\t/);
  const user = sep > 0 && sep < 40 ? rest.slice(0, sep).trim() : '';
  const text = sep > 0 && sep < 40 ? rest.slice(sep + 1).trim() : rest.trim();
  return { t, hasDate, user, text };
}

export async function parseChatFile(file: string, onProgress?: (ratio: number) => void): Promise<ChatLoadResult> {
  const stat = await fs.promises.stat(file);
  const fd = await fs.promises.open(file, 'r');
  const head = Buffer.alloc(Math.min(4096, stat.size));
  await fd.read(head, 0, head.length, 0);
  await fd.close();
  const headStr = head.toString('utf8').replace(/^﻿/, '').trimStart();

  // JSON 문서 (배열 또는 객체). "[0:12:34]" 같은 텍스트 줄과 헷갈리지 않게 "[{" / "{" 만 본다.
  const firstLine = headStr.split(/\r?\n/, 1)[0] ?? '';
  const isNdjson = firstLine.startsWith('{') && firstLine.trimEnd().endsWith('}') && /\n\s*\{/.test(headStr);
  if (!isNdjson && (/^\[\s*\{/.test(headStr) || headStr.startsWith('{'))) {
    if (stat.size > MAX_JSON_BYTES) throw new Error('JSON 로그가 너무 큽니다. NDJSON(한 줄에 한 메시지)으로 변환해 주세요.');
    const raw = (await fs.promises.readFile(file, 'utf8')).replace(/^﻿/, '');
    onProgress?.(1);
    return parseJsonDocument(file, raw);
  }

  // 한 줄씩 스트리밍 (텍스트 / NDJSON)
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let acc: Accumulator | null = null;
  let mode: TimeMode = 'elapsed';
  let skipped = 0;
  let lastReport = 0;

  for await (const rawLine of rl) {
    const line = rawLine.replace(/^﻿/, '');
    if (!line.trim()) continue;
    let msg: Msg | null = null;
    let hasDate = false;
    if (isNdjson) {
      try {
        msg = objToMsg(JSON.parse(line) as Record<string, unknown>);
      } catch {
        msg = null;
      }
    } else {
      const p = parseTextLine(line);
      if (p) {
        msg = { t: p.t, user: p.user, text: p.text };
        hasDate = p.hasDate;
      }
    }
    if (!msg) {
      skipped++;
      continue;
    }
    if (!acc) {
      // 날짜가 붙었거나 첫 메시지가 10분 이후면 벽시계 시각으로 본다.
      mode = hasDate || looksLikeClock(msg.t) || msg.t > 600 ? 'clock' : 'elapsed';
      acc = new Accumulator(mode);
    }
    acc.add(msg);

    if (onProgress && stream.bytesRead - lastReport > 2 * 1024 * 1024) {
      lastReport = stream.bytesRead;
      onProgress(stream.bytesRead / stat.size);
    }
  }
  onProgress?.(1);
  const result = acc ?? new Accumulator('elapsed');
  result.skipped += skipped;
  return finish(result, file, isNdjson ? 'ndjson' : 'text', mode);
}
