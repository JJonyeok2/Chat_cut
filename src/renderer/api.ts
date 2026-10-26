import type { ChatLoadResult, ClipJob, ClipProgress, VideoInfo } from '../shared/types.js';

/** preload.ts 가 노출하는 API (renderer 쪽 타입 선언) */
export interface ChatcutApi {
  openVideo(): Promise<VideoInfo | null>;
  openChat(): Promise<ChatLoadResult | null>;
  openPaths(paths: string[]): Promise<{ video?: VideoInfo; chat?: ChatLoadResult; unknown: string[] }>;
  pathForFile(f: File): string;
  loadSample(): Promise<{ video?: VideoInfo; chat?: ChatLoadResult; error?: string }>;
  saveEdl(text: string, defaultName: string): Promise<string | null>;
  exportClips(videoPath: string, jobs: ClipJob[]): Promise<{ dir: string; files: string[]; canceled: boolean } | null>;
  cancelClips(): Promise<void>;
  reveal(p: string): Promise<void>;
  onChatProgress(cb: (ratio: number) => void): () => void;
  onClipProgress(cb: (p: ClipProgress) => void): () => void;
}

declare global {
  interface Window {
    chatcut: ChatcutApi;
  }
}

export const api = (): ChatcutApi => window.chatcut;
