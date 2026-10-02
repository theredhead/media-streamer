import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { FilterableArrayDatasource } from '@theredhead/lucid-foundation';
import { UIButton, UICard, UICardHeader, UICardBody, UICardFooter, UIMediaGallery, UIMediaPlayer, UIIcon, UIIcons, type MediaGalleryItem } from '@theredhead/lucid-kit';
import { ThemeService } from '@theredhead/lucid-theme';
import type { LibrarySnapshot, MediaItem } from '../../../packages/contracts/media';
import { VRViewer } from './vr-viewer';
type MediaFilter = 'photo' | 'video' | 'vr';

@Component({ selector: 'app-root', standalone: true, changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UIButton, UICard, UICardHeader, UICardBody, UICardFooter, UIMediaGallery, UIMediaPlayer, UIIcon, VRViewer], templateUrl: './app.html' })
export class AppComponent {
  private readonly http = inject(HttpClient);
  readonly theme = inject(ThemeService);
  readonly snapshot = signal<LibrarySnapshot>({ items: [], warnings: [], scannedAt: '' });
  readonly query = signal('');
  readonly selectedTypes = signal<MediaFilter[]>(['photo', 'video', 'vr']);
  readonly typeOptions: { id: MediaFilter; label: string; icon: string }[] = [
    { id: 'photo', label: 'Photos', icon: UIIcons.Lucide.Photography.Image },
    { id: 'video', label: 'Videos', icon: UIIcons.Lucide.Photography.Video },
    { id: 'vr', label: 'VR', icon: UIIcons.Lucide.Accessibility.Glasses },
  ];
  toggleType(type: MediaFilter) {
    this.selectedTypes.update(types => types.includes(type) ? types.filter(value => value !== type) : [...types, type]);
  }
  readonly busy = signal(false);
  readonly error = signal('');
  readonly selectedVideo = signal<MediaItem | null>(null);
  readonly selectedAlbum = signal<MediaItem[] | null>(null);
  readonly selectedVR = signal<MediaItem | null>(null);
  readonly diagnostics = signal('');
  async checkCapabilities() {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl');
    const video = document.createElement('video');
    let immersive = 'unavailable';
    try { if (navigator.xr) immersive = String(await navigator.xr.isSessionSupported('immersive-vr')); } catch { immersive = 'check failed'; }
    this.diagnostics.set(JSON.stringify({ browser: navigator.userAgent, secureContext: window.isSecureContext,
      webXR: !!navigator.xr, immersiveVR: immersive, webGL: !!gl, maxTextureSize: gl?.getParameter(gl.MAX_TEXTURE_SIZE),
      h264: video.canPlayType('video/mp4; codecs="avc1.42E01E"'), hevc: video.canPlayType('video/mp4; codecs="hvc1"'), vp9: video.canPlayType('video/webm; codecs="vp9"') }, null, 2));
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  }
  cardMedia(entry: { video?: MediaItem; album?: MediaItem[] }) {
    const items = entry.album ?? (entry.video ? [entry.video] : []);
    const vr = items.some(item => item.projection !== 'flat' || item.stereoMode !== 'mono');
    if (vr) return { type: 'vr' as const, icon: UIIcons.Lucide.Accessibility.Glasses, label: entry.album ? 'VR image album' : 'VR video' };
    if (entry.video) return { type: 'video' as const, icon: UIIcons.Lucide.Photography.Video, label: 'Video' };
    if (items.length > 1) return { type: 'photo' as const, icon: UIIcons.Lucide.Photography.Images, label: 'Gallery' };
    return { type: 'photo' as const, icon: UIIcons.Lucide.Photography.Image, label: 'Image' };
  }
  readonly entries = computed(() => {
    const ds = new FilterableArrayDatasource(this.snapshot().items);
    const query = this.query().trim().toLowerCase();
    ds.filterBy([{ predicate: (item: MediaItem) => [item.title, item.relativePath, ...item.tags].join(' ').toLowerCase().includes(query) }]);
    const images = new Map<string, MediaItem[]>();
    const entries: { id: string; title: string; detail: string; video?: MediaItem; album?: MediaItem[] }[] = [];
    for (let index = 0; index < ds.getNumberOfItems(); index++) {
      const item = ds.getObjectAtRowIndex(index);
      if (item.mediaType === 'video') entries.push({ id: item.id, title: item.title, detail: `${item.projection} · ${item.stereoMode} · ${(item.size / 1024 ** 3).toFixed(2)} GB`, video: item });
      else images.set(item.directoryId, [...(images.get(item.directoryId) ?? []), item]);
    }
    for (const [id] of images) {
      // Search selects albums; opening one always shows every image in its directory.
      const album = this.snapshot().items.filter(item => item.mediaType === 'image' && item.directoryId === id);
      const directory = album[0].relativePath.split('/').slice(0, -1).join('/');
      entries.push({ id, title: directory || album[0].rootId, detail: `${album.length} ${album.length === 1 ? 'image' : 'images'} · ${album[0].rootId}`, album });
    }
    return entries.filter(entry => this.selectedTypes().includes(this.cardMedia(entry).type)).sort((a, b) => a.title.localeCompare(b.title));
  });
  readonly galleryItems = computed<MediaGalleryItem[]>(() => (this.selectedAlbum() ?? []).map(item => ({ id: item.id, collection: item.directoryId, kind: 'image', src: item.contentUrl, alt: item.title, type: item.mimeType })));
  constructor() { void this.load(); }
  async load(rescan = false) {
    this.busy.set(true); this.error.set('');
    try {
      this.snapshot.set(await firstValueFrom(rescan ? this.http.post<LibrarySnapshot>('/api/library/rescan', {}) : this.http.get<LibrarySnapshot>('/api/media')));
    } catch { this.error.set('Could not load the library. Check that the server is running.'); }
    finally { this.busy.set(false); }
  }
  open(entry: { video?: MediaItem; album?: MediaItem[] }) { this.selectedVideo.set(entry.video ?? null); this.selectedAlbum.set(entry.album ?? null); }
  close() { this.selectedVR.set(null); this.selectedVideo.set(null); this.selectedAlbum.set(null); }
}
