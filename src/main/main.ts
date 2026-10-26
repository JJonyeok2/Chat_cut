import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseChatFile } from './chatParser.js';
import { exportClips, probeVideo } from './media.js';
import type { ChatLoadResult, ClipJob, VideoInfo } from '../shared/types.js';

const VIDEO_EXT = ['mp4', 'mov', 'mkv', 'webm', 'm4v', 'ts', 'flv'];
const CHAT_EXT = ['txt', 'log', 'json', 'ndjson', 'jsonl', 'csv'];

let win: BrowserWindow | null = null;
let clipAbort: AbortController | null = null;

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    title: 'Chatcut',
    backgroundColor: '#0f1115',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', '..', 'renderer', 'renderer', 'index.html'));
  win.on('closed', () => (win = null));
}

async function loadVideo(file: string): Promise<VideoInfo> {
  const info = await probeVideo(file);
  return {
    path: file,
    url: pathToFileURL(file).href,
    name: path.basename(file),
    durationSec: info?.durationSec ?? 0,
    fps: info?.fps ?? 30,
  };
}

async function loadChat(file: string): Promise<ChatLoadResult> {
  return parseChatFile(file, (ratio) => win?.webContents.send('chat:progress', ratio));
}

function kindOf(file: string): 'video' | 'chat' | null {
  const ext = path.extname(file).slice(1).toLowerCase();
  if (VIDEO_EXT.includes(ext)) return 'video';
  if (CHAT_EXT.includes(ext)) return 'chat';
  return null;
}

ipcMain.handle('video:open', async () => {
  const r = await dialog.showOpenDialog(win!, { title: '원본 영상 열기', properties: ['openFile'], filters: [{ name: '영상', extensions: VIDEO_EXT }] });
  return r.canceled || !r.filePaths[0] ? null : loadVideo(r.filePaths[0]);
});

ipcMain.handle('chat:open', async () => {
  const r = await dialog.showOpenDialog(win!, {
    title: '채팅 로그 열기',
    properties: ['openFile'],
    filters: [{ name: '채팅 로그', extensions: CHAT_EXT }, { name: '모든 파일', extensions: ['*'] }],
  });
  return r.canceled || !r.filePaths[0] ? null : loadChat(r.filePaths[0]);
});

ipcMain.handle('file:openPaths', async (_e, paths: string[]) => {
  const out: { video?: VideoInfo; chat?: ChatLoadResult; unknown: string[] } = { unknown: [] };
  for (const p of paths) {
    const k = kindOf(p);
    if (k === 'video') out.video = await loadVideo(p);
    else if (k === 'chat') out.chat = await loadChat(p);
    else out.unknown.push(path.basename(p));
  }
  return out;
});

ipcMain.handle('sample:load', async () => {
  const dir = path.join(app.getAppPath(), 'sample');
  const video = path.join(dir, 'sample-stream.mp4');
  const chat = path.join(dir, 'sample-chat.txt');
  if (!fs.existsSync(chat)) return { error: '샘플이 없습니다. 터미널에서 npm run sample 을 먼저 실행해 주세요.' };
  return {
    chat: await loadChat(chat),
    video: fs.existsSync(video) ? await loadVideo(video) : undefined,
  };
});

ipcMain.handle('edl:save', async (_e, text: string, defaultName: string) => {
  const r = await dialog.showSaveDialog(win!, { title: 'EDL 저장', defaultPath: defaultName, filters: [{ name: 'EDL', extensions: ['edl'] }] });
  if (r.canceled || !r.filePath) return null;
  await fs.promises.writeFile(r.filePath, text, 'utf8');
  return r.filePath;
});

ipcMain.handle('clips:export', async (_e, videoPath: string, jobs: ClipJob[]) => {
  const r = await dialog.showOpenDialog(win!, { title: '클립을 저장할 폴더', properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  const dir = path.join(r.filePaths[0], `chatcut_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`);
  clipAbort = new AbortController();
  try {
    const files = await exportClips(videoPath, dir, jobs, (p) => win?.webContents.send('clips:progress', p), clipAbort.signal);
    return { dir, files, canceled: clipAbort.signal.aborted };
  } finally {
    clipAbort = null;
  }
});

ipcMain.handle('clips:cancel', () => clipAbort?.abort());
ipcMain.handle('shell:reveal', (_e, p: string) => shell.showItemInFolder(p));

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
