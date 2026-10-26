/**
 * ffprobe / ffmpeg 호출.
 * npm 패키지(ffmpeg-static, ffprobe-static)가 설치한 바이너리를 먼저 쓰고,
 * 없으면 Homebrew 경로와 PATH를 순서대로 찾는다. (macOS GUI 앱은 셸의 PATH를 물려받지 않는다.)
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ClipJob, ClipProgress } from '../shared/types.js';

function fromPackage(name: 'ffmpeg-static' | 'ffprobe-static'): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(name) as string | { path?: string } | null;
    const p = typeof mod === 'string' ? mod : mod?.path;
    return p && fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

function findBinary(name: 'ffmpeg' | 'ffprobe'): string | null {
  const pkg = fromPackage(name === 'ffmpeg' ? 'ffmpeg-static' : 'ffprobe-static');
  if (pkg) return pkg;
  for (const dir of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', ...(process.env.PATH ?? '').split(path.delimiter)]) {
    const p = path.join(dir, name);
    if (dir && fs.existsSync(p)) return p;
  }
  return null;
}

function run(bin: string, args: string[], signal?: AbortSignal): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 64_000) stderr = stderr.slice(-32_000);
    });
    const onAbort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', reject);
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

export async function probeVideo(file: string): Promise<{ durationSec: number; fps: number } | null> {
  const bin = findBinary('ffprobe');
  if (!bin) return null;
  const { code, stdout } = await run(bin, [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'format=duration:stream=r_frame_rate,avg_frame_rate',
    '-of', 'json',
    file,
  ]);
  if (code !== 0) return null;
  try {
    const j = JSON.parse(stdout) as { format?: { duration?: string }; streams?: { r_frame_rate?: string; avg_frame_rate?: string }[] };
    const rate = j.streams?.[0]?.avg_frame_rate && j.streams[0].avg_frame_rate !== '0/0' ? j.streams[0].avg_frame_rate : j.streams?.[0]?.r_frame_rate;
    const [n, d] = (rate ?? '30/1').split('/').map(Number);
    const fps = d ? n / d : n;
    return { durationSec: Number(j.format?.duration ?? 0), fps: Number.isFinite(fps) && fps > 0 ? fps : 30 };
  } catch {
    return null;
  }
}

export function hasFfmpeg(): boolean {
  return findBinary('ffmpeg') !== null;
}

function safeName(s: string): string {
  return s.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60);
}

/**
 * 채택한 구간을 원본에서 잘라 파일로 저장한다.
 * 재인코딩 없이 스트림 복사(-c copy)로 자르기 때문에 몇 시간짜리 원본도 몇 초면 끝난다.
 * 대신 키프레임 단위로 잘려 앞쪽이 1~2초 더 붙을 수 있다. 편집자가 다시 다듬을 소스라 속도를 택했다.
 */
export async function exportClips(
  videoPath: string,
  outDir: string,
  jobs: ClipJob[],
  onProgress: (p: ClipProgress) => void,
  signal?: AbortSignal,
): Promise<string[]> {
  const bin = findBinary('ffmpeg');
  if (!bin) throw new Error('ffmpeg를 찾지 못했습니다. npm install을 다시 실행하거나 brew install ffmpeg 후 다시 시도해 주세요.');
  await fs.promises.mkdir(outDir, { recursive: true });
  const ext = path.extname(videoPath) || '.mp4';
  const base = safeName(path.basename(videoPath, ext));
  const files: string[] = [];

  for (let i = 0; i < jobs.length; i++) {
    if (signal?.aborted) break;
    const j = jobs[i];
    const out = path.join(outDir, `${base}_${String(i + 1).padStart(2, '0')}_${safeName(j.label)}${ext}`);
    onProgress({ index: i, total: jobs.length, file: path.basename(out) });
    const { code, stderr } = await run(
      bin,
      ['-y', '-hide_banner', '-loglevel', 'error', '-ss', j.start.toFixed(3), '-i', videoPath, '-t', (j.end - j.start).toFixed(3), '-map', '0', '-c', 'copy', '-avoid_negative_ts', 'make_zero', out],
      signal,
    );
    if (signal?.aborted) break;
    if (code !== 0) throw new Error(`클립 ${i + 1} 자르기 실패: ${stderr.trim().split('\n').pop() ?? code}`);
    files.push(out);
  }
  onProgress({ index: jobs.length, total: jobs.length, file: '' });
  return files;
}
