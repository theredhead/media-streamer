export interface MediaItem {
  id: string;
  rootId: string;
  relativePath: string;
  directoryId: string;
  title: string;
  mediaType: 'image' | 'video';
  mimeType: string;
  size: number;
  modified: string;
  projection: 'flat' | '180' | '360';
  stereoMode: 'mono' | 'sbs' | 'ou';
  tags: string[];
  contentUrl: string;
}
export interface LibrarySnapshot {
  items: MediaItem[];
  warnings: string[];
  scannedAt: string;
}
