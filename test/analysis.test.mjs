import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const a = require('../dist/main/shared/analysis.js');
const { parseChatFile, parseTextLine } = require('../dist/main/main/chatParser.js');

function flat(n, v = 2) {
  return Array.from({ length: n }, (_, i) => v + (i % 3 === 0 ? 1 : 0));
}

test('평소 수준에서는 후보를 만들지 않는다', () => {
  const r = a.analyze(flat(1200), 1200, a.DEFAULT_PARAMS);
  assert.equal(r.segments.length, 0);
});

test('급증 구간을 찾고, 반응 지연만큼 시작을 앞으로 당긴다', () => {
  const s = flat(1200);
  for (let t = 500; t < 520; t++) s[t] += 25;
  const r = a.analyze(s, 1200, a.DEFAULT_PARAMS);
  assert.equal(r.segments.length, 1);
  const seg = r.segments[0];
  assert.ok(seg.start <= 500 - a.DEFAULT_PARAMS.preRollSec + 5, `start ${seg.start}`);
  assert.ok(seg.end >= 520, `end ${seg.end}`);
  assert.ok(seg.peakTime >= 500 && seg.peakTime <= 520);
  assert.equal(seg.rank, 1);
});

test('짧은 간격으로 이어진 급증은 한 구간으로 합친다', () => {
  const s = flat(1200);
  for (let t = 300; t < 310; t++) s[t] += 30;
  for (let t = 318; t < 328; t++) s[t] += 30;
  const r = a.analyze(s, 1200, a.DEFAULT_PARAMS);
  assert.equal(r.segments.length, 1);
});

test('채팅이 전반적으로 많은 시간대에서도 상대적인 급증만 잡는다', () => {
  const s = flat(2400);
  for (let t = 1200; t < 2400; t++) s[t] += 20; // 후반에 시청자가 늘어남
  for (let t = 1800; t < 1815; t++) s[t] += 60;
  const r = a.analyze(s, 2400, a.DEFAULT_PARAMS);
  // 시청자가 늘어난 경계(1200초)는 이동 기준선이 따라가므로 후보가 아니어야 한다
  assert.ok(r.segments.every((x) => x.end < 1150 || x.start > 1250 || x.score < 6), JSON.stringify(r.segments));
  assert.ok(r.segments.some((x) => x.start <= 1800 && x.end >= 1810));
});

test('오프셋만큼 채팅 시계열을 민다', () => {
  assert.deepEqual(a.shiftSeries([0, 0, 5, 0], 2, 4), [5, 0, 0, 0]);
  assert.deepEqual(a.shiftSeries([1, 2], -1, 3), [0, 1, 2]);
});

test('민감도를 바꿔도 겹치는 구간의 판단은 유지한다', () => {
  const old = [{ id: 'o1', start: 100, end: 140 }, { id: 'o2', start: 300, end: 330 }];
  const next = [{ id: 'n1', start: 95, end: 142 }, { id: 'n2', start: 600, end: 620 }];
  const d = a.carryDecisions(old, { o1: 'accepted', o2: 'rejected' }, next);
  assert.deepEqual(d, { n1: 'accepted', n2: 'pending' });
});

test('반응 표현 가중치', () => {
  assert.equal(a.reactionWeight('안녕하세요'), 1);
  assert.equal(a.reactionWeight('ㅋㅋㅋㅋ'), 1.5);
  assert.equal(a.reactionWeight('ㅋㅋㅋ 미쳤다'), 2);
});

test('타임코드와 EDL', () => {
  assert.equal(a.toTimecode(3723.5, 30), '01:02:03:15');
  assert.equal(a.formatTime(3723.9), '1:02:03');
  const edl = a.buildEdl('T', 'a.mp4', [{ start: 10, end: 20 }, { start: 30, end: 35 }], 30);
  assert.match(edl, /001 {2}AX {7}AA\/V {2}C {8}00:00:10:00 00:00:20:00 00:00:00:00 00:00:10:00/);
  assert.match(edl, /002 .* 00:00:30:00 00:00:35:00 00:00:10:00 00:00:15:00/);
});

test('텍스트 채팅 줄 파싱', () => {
  assert.deepEqual(parseTextLine('[0:12:34] 감자: ㅋㅋㅋ'), { t: 754, hasDate: false, user: '감자', text: 'ㅋㅋㅋ' });
  assert.equal(parseTextLine('12:34 고양이: 안녕').t, 754);
  const d = parseTextLine('[2026-10-20 21:03:11] 별빛: 와');
  assert.equal(d.hasDate, true);
  assert.equal(d.user, '별빛');
  assert.equal(parseTextLine('그냥 문장'), null);
});

test('채팅 파일: 텍스트, 벽시계 시각, TwitchDownloader JSON', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chatcut-'));

  const txt = join(dir, 'a.txt');
  writeFileSync(txt, '[0:00:01] a: 안녕\n[0:00:01] b: ㅋㅋㅋ\n잘못된 줄\n[0:00:05] c: 와\n');
  const r1 = await parseChatFile(txt);
  assert.equal(r1.totalMessages, 3);
  assert.equal(r1.skippedLines, 1);
  assert.equal(r1.timeMode, 'elapsed');
  assert.equal(r1.perSecond[1], 2);
  assert.equal(r1.perSecondWeighted[1], 2.5);

  const clock = join(dir, 'b.log');
  writeFileSync(clock, '[23:59:58] a: 1\n[23:59:59] a: 2\n[00:00:03] a: 3\n');
  const r2 = await parseChatFile(clock);
  assert.equal(r2.timeMode, 'clock');
  assert.equal(r2.perSecond[0], 1);
  assert.equal(r2.perSecond[5], 1, '자정을 넘겨도 이어져야 한다');

  const tw = join(dir, 'c.json');
  writeFileSync(
    tw,
    JSON.stringify({
      comments: [
        { content_offset_seconds: 3.2, commenter: { display_name: 'x' }, message: { body: 'pog' } },
        { content_offset_seconds: 3.9, commenter: { display_name: 'y' }, message: { body: 'lol' } },
      ],
    }),
  );
  const r3 = await parseChatFile(tw);
  assert.equal(r3.format, 'twitch-json');
  assert.equal(r3.perSecond[3], 2);

  const nd = join(dir, 'd.ndjson');
  writeFileSync(nd, '{"time":"0:00:02","user":"a","message":"hi"}\n{"time":4,"user":"b","message":"ㅋㅋ"}\n');
  const r4 = await parseChatFile(nd);
  assert.equal(r4.format, 'ndjson');
  assert.equal(r4.totalMessages, 2);
});
