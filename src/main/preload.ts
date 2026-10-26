import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { ChatLoadResult, ClipJob, ClipProgress, VideoInfo } from '../shared/types.js';

function on<T>(channel: string, cb: (v: T) => void): () => void {
  const h = (_e: unknown, v: T) => cb(v);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
}

const api = {
  openVideo: (): Promise<VideoInfo | null> => ipcRenderer.invoke('video:open'),
  openChat: (): Promise<ChatLoadResult | null> => ipcRenderer.invoke('chat:open'),
  openPaths: (paths: string[]): Promise<{ video?: VideoInfo; chat?: ChatLoadResult; unknown: string[] }> =>
    ipcRenderer.invoke('file:openPaths', paths),
  pathForFile: (f: File): string => webUtils.getPathForFile(f),
  loadSample: (): Promise<{ video?: VideoInfo; chat?: ChatLoadResult; error?: string }> => ipcRenderer.invoke('sample:load'),
  saveEdl: (text: string, defaultName: string): Promise<string | null> => ipcRenderer.invoke('edl:save', text, defaultName),
  exportClips: (videoPath: string, jobs: ClipJob[]): Promise<{ dir: string; files: string[]; canceled: boolean } | null> =>
    ipcRenderer.invoke('clips:export', videoPath, jobs),
  cancelClips: (): Promise<void> => ipcRenderer.invoke('clips:cancel'),
  reveal: (p: string): Promise<void> => ipcRenderer.invoke('shell:reveal', p),
  onChatProgress: (cb: (ratio: number) => void) => on<number>('chat:progress', cb),
  onClipProgress: (cb: (p: ClipProgress) => void) => on<ClipProgress>('clips:progress', cb),
};

export type ChatcutApi = typeof api;
contextBridge.exposeInMainWorld('chatcut', api);
