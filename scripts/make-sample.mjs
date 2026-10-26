// 체험용 샘플 생성: 20분짜리 가상 게임 방송 영상 + 채팅 로그
//   npm run sample              영상 + 채팅
//   npm run sample -- --no-video 채팅만
//
// 샘플에는 일부러 "채팅은 많지만 편집점은 아닌" 구간(입장 인사 러시)도 넣었다.
// 반응 표현 가중치를 켜고 끌 때 순위가 어떻게 바뀌는지, 편집자가 왜 최종 판단을 해야 하는지 보여주기 위해서다.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'sample');
mkdirSync(outDir, { recursive: true });

const DURATION = 20 * 60;
const noVideo = process.argv.includes('--no-video');

// 재현 가능한 난수
let seed = 20261026;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const poisson = (lambda) => {
  let k = 0;
  let p = Math.exp(-lambda);
  let s = p;
  const u = rand();
  while (u > s && k < 200) {
    k++;
    p *= lambda / k;
    s += p;
  }
  return k;
};

const users = Array.from({ length: 140 }, (_, i) => pick(['감자', '고양이', '새벽', '라면', '치즈', '도토리', '구름', '마루', '호떡', '별빛']) + pick(['맨', '러', '왕', '덕후', '짱', '']) + (i % 97));

const normal = [
  '오늘 몇 시까지 하세요?', '이 맵 처음 봄', '총 뭐 쓰는 거예요', '배고프다', '방금 왔어요', '세팅 뭐예요?', '소리 좀 작아요',
  '오 좋아', '천천히 해요', '다음 판 랭크?', '그 아이템 뭐임', '오늘 컨디션 좋아 보이네', '음악 제목 뭐예요', '안녕하세요',
  '저번 방송 봤어요', '그쪽 아니에요', '뒤에 있어요', '힐 먼저', '오늘 몇 판째예요', '물 마셔요',
];

const events = [
  { t: 142, kind: 'laugh', label: '어이없는 낙사', dur: 22, power: 9 },
  { t: 395, kind: 'hype', label: '1대4 클러치', dur: 30, power: 11 },
  { t: 611, kind: 'scare', label: '갑툭튀 깜짝 놀람', dur: 18, power: 8 },
  { t: 705, kind: 'greet', label: '레이드 입장 인사 (편집점 아님)', dur: 35, power: 10 },
  { t: 822, kind: 'laugh', label: '후원 읽다 빵 터짐', dur: 26, power: 7 },
  { t: 1012, kind: 'hype', label: '역전승', dur: 34, power: 12 },
  { t: 1133, kind: 'small', label: '작은 실수', dur: 10, power: 3.5 },
];

const reaction = {
  laugh: ['ㅋㅋㅋㅋㅋㅋ', 'ㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋ', '아 ㅋㅋㅋㅋㅋ 미쳤다', 'ㅋㅋㅋㅋ 클립 각', '레전드 ㅋㅋㅋㅋ', '이걸 떨어지네 ㅋㅋㅋ', 'ㅋㅋㅋㅋㅋㅋㅋㅋ'],
  hype: ['와아아아아', '미쳤다!!', 'ㄷㄷㄷㄷ', '이게 되네 ㄷㄷ', '클립!!', '와 레전드', '대박 ㄷㄷㄷ', 'ㄹㅇ 미쳤네', 'GG!!'],
  scare: ['??????', 'ㄷㄷㄷㄷㄷ', '깜짝아', '헉', '와 소리 ㅋㅋㅋ', '심장 떨어질 뻔', '??'],
  greet: ['ㅎㅇ', 'ㅎㅇㅎㅇ', '안녕하세요', '레이드 왔어요', '하이', '반가워요', '처음 왔어요'],
  small: ['ㅋㅋ', '아깝다', 'ㅋㅋㅋ', '괜찮아요'],
};

const lines = [];
const fmt = (s) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = Math.floor(s % 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
};

for (let s = 0; s < DURATION; s++) {
  // 평소 채팅량은 방송 흐름에 따라 천천히 오르내린다
  const base = 1.1 + 0.6 * Math.sin(s / 170) + 0.4 * Math.sin(s / 53) + (s > 600 ? 0.4 : 0);
  let n = poisson(Math.max(0.3, base));
  const msgs = [];
  for (let i = 0; i < n; i++) msgs.push(pick(normal));

  for (const ev of events) {
    // 채팅은 장면보다 4~8초 늦게 반응한다
    const lag = 6;
    const x = s - ev.t - lag;
    if (x < 0 || x > ev.dur) continue;
    const shape = Math.exp(-x / (ev.dur / 3)) * ev.power;
    const k = poisson(shape);
    for (let i = 0; i < k; i++) msgs.push(pick(reaction[ev.kind]));
  }

  for (const text of msgs) lines.push(`[${fmt(s)}] ${pick(users)}: ${text}`);
}

writeFileSync(join(outDir, 'sample-chat.txt'), lines.join('\n') + '\n', 'utf8');
writeFileSync(
  join(outDir, 'events.json'),
  JSON.stringify(events.map(({ t, label }) => ({ t, time: fmt(t), label })), null, 2),
);
console.log(`채팅 ${lines.length.toLocaleString()}줄 → sample/sample-chat.txt`);

if (noVideo) process.exit(0);

let ffmpeg = null;
try {
  ffmpeg = require('ffmpeg-static');
} catch {}
if (!ffmpeg || !existsSync(ffmpeg)) ffmpeg = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'].find(existsSync) ?? 'ffmpeg';

// 장면 표시: 이벤트 순간에 화면에 색 박스를 띄워 미리보기에서 눈으로 확인할 수 있게 한다 (폰트가 필요 없는 drawbox만 사용)
const colors = { laugh: 'yellow', hype: 'lime', scare: 'red', greet: 'gray', small: 'orange' };
const boxes = events
  .map((e) => `drawbox=x=0:y=0:w=iw:h=ih:color=${colors[e.kind]}@0.55:t=fill:enable='between(t,${e.t},${e.t + 4})'`)
  .join(',');

const args = [
  '-y', '-hide_banner', '-loglevel', 'error',
  '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=24:duration=${DURATION}`,
  '-f', 'lavfi', '-i', `sine=frequency=220:sample_rate=44100:duration=${DURATION}`,
  '-vf', boxes,
  '-af', 'volume=0.08',
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '38', '-g', '48', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '64k',
  '-shortest', join(outDir, 'sample-stream.mp4'),
];
console.log('20분짜리 샘플 영상을 만드는 중 (1분 정도 걸립니다)…');
const r = spawnSync(ffmpeg, args, { stdio: 'inherit' });
if (r.status !== 0) {
  console.error('영상 생성에 실패했습니다. 채팅 로그만으로도 체험할 수 있습니다.');
  process.exit(0);
}
console.log('영상 → sample/sample-stream.mp4');
