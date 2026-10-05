import { ChangeDetectionStrategy, Component, computed, inject, signal, DestroyRef, HostListener } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { FilterableArrayDatasource } from '@theredhead/lucid-foundation';
import { UIButton, UICard, UICardHeader, UICardBody, UIMediaGallery, UIMediaPlayer, UIIcon, UIIcons, type MediaGalleryItem } from '@theredhead/lucid-kit';
import { ThemeService } from '@theredhead/lucid-theme';
import type { LibrarySnapshot, MediaItem, MediaMetadataUpdate } from '../../../packages/contracts/media';
import { VRViewer } from './vr-viewer';
type MediaFilter = 'photo' | 'video' | 'vr';
type SortField = 'size' | 'duration' | 'date';

@Component({ selector: 'app-root', standalone: true, changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UIButton, UICard, UICardHeader, UICardBody, UIMediaGallery, UIMediaPlayer, UIIcon, VRViewer], templateUrl: './app.html' })
export class AppComponent {
  private readonly http = inject(HttpClient);
  readonly theme = inject(ThemeService);
  readonly snapshot = signal<LibrarySnapshot>({ items: [], warnings: [], scannedAt: '' });
  readonly query = signal('');
  readonly sortField = signal<SortField>('size');
  readonly sortAscending = signal(false);
  readonly sortOptions: { id: SortField; label: string }[] = [
    { id: 'size', label: 'Size' }, { id: 'duration', label: 'Duration' }, { id: 'date', label: 'Date' },
  ];
  readonly sortDirectionIcon = computed(() => this.sortAscending() ? UIIcons.Lucide.Arrows.ArrowUp : UIIcons.Lucide.Arrows.ArrowDown);
  toggleSort(field: SortField) {
    if (this.sortField() === field) this.sortAscending.update(ascending => !ascending);
    else this.sortField.set(field);
  }
  readonly editMode = signal(false);
  readonly editing = signal<{ id: string; title: string; tags: string; projection: MediaItem['projection']; stereoMode: MediaItem['stereoMode'] } | null>(null);
  readonly savingIds = signal<string[]>([]);
  readonly editError = signal('');
  readonly formIcon = UIIcons.Lucide.Text.SquarePen;
  toggleEditMode() {
    this.editMode.update(value => !value);
    this.settingsOpen.set(false);
    this.cancelEdit();
  }
  startEdit(item: MediaItem) {
    this.editError.set('');
    this.editing.set({ id: item.id, title: item.title, tags: item.tags.join(', '), projection: item.projection, stereoMode: item.stereoMode });
  }
  cancelEdit() { this.editing.set(null); this.editError.set(''); }
  changeDraft(field: 'title' | 'tags' | 'projection' | 'stereoMode', value: string) {
    this.editing.update(draft => draft ? { ...draft, [field]: value } : null);
  }
  async saveMetadata(id: string, update: MediaMetadataUpdate): Promise<boolean> {
    if (this.savingIds().includes(id)) return false;
    this.savingIds.update(ids => [...ids, id]);
    this.editError.set('');
    try {
      const item = await firstValueFrom(this.http.patch<MediaItem>(`/api/media/${id}/metadata`, update));
      this.snapshot.update(snapshot => ({ ...snapshot, items: snapshot.items.map(value => value.id === id ? item : value) }));
      if (this.selectedVideo()?.id === id) this.selectedVideo.set(item);
      if (this.selectedVR()?.id === id) this.selectedVR.set(item);
      return true;
    } catch { this.editError.set('Could not save metadata. Check the sidecar and metadata folder permissions.'); return false; }
    finally { this.savingIds.update(ids => ids.filter(value => value !== id)); }
  }
  async saveDraft(event: Event) {
    event.preventDefault();
    const draft = this.editing();
    if (!draft || !draft.title.trim()) return;
    if (await this.saveMetadata(draft.id, { title: draft.title.trim(), tags: draft.tags.split(',').map(tag => tag.trim()).filter(Boolean), projection: draft.projection, stereoMode: draft.stereoMode })) this.cancelEdit();
  }
  setPresentation(item: MediaItem, presentation: 'flat' | 'vr') {
    if ((presentation === 'flat') === (item.projection === 'flat' && item.stereoMode === 'mono')) return;
    void this.saveMetadata(item.id, { presentation });
  }
  readonly settingsOpen = signal(false);
  readonly settingsIcon = UIIcons.Lucide.Account.Settings;
  readonly toggleSettings = (open: boolean) => !open;
  @HostListener('document:click', ['$event'])
  dismissSettings(event: MouseEvent) {
    if (!(event.target instanceof Element) || !event.target.closest('.settings')) this.settingsOpen.set(false);
  }
  @HostListener('document:keydown.escape')
  closeSettings() { this.settingsOpen.set(false); }
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
    const vr = items.some(item => this.isVR(item));
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
    const entries: { id: string; title: string; detail: string; size: number; duration?: number; date: number; video?: MediaItem; album?: MediaItem[] }[] = [];
    for (let index = 0; index < ds.getNumberOfItems(); index++) {
      const item = ds.getObjectAtRowIndex(index);
      if (item.mediaType === 'video') entries.push({ id: item.id, title: item.title, detail: `${(item.size / 1024 ** 3).toFixed(2)} GB · ${item.duration ? this.durationTime(item.duration) : 'Duration pending'}`, size: item.size, duration: item.duration, date: Date.parse(item.modified), video: item });
      else images.set(item.directoryId, [...(images.get(item.directoryId) ?? []), item]);
    }
    for (const [id] of images) {
      // Search selects albums; opening one always shows every image in its directory.
      const album = this.snapshot().items.filter(item => item.mediaType === 'image' && item.directoryId === id);
      const directory = album[0].relativePath.split('/').slice(0, -1).join('/');
      entries.push({ id, title: directory || album[0].rootId, detail: `${album.length} ${album.length === 1 ? 'image' : 'images'} · ${album[0].rootId}`, size: album.reduce((total, item) => total + item.size, 0), date: Math.max(...album.map(item => Date.parse(item.modified))), album });
    }
    const field = this.sortField();
    const ascending = this.sortAscending();
    return entries.filter(entry => this.selectedTypes().includes(this.cardMedia(entry).type)).sort((a, b) => {
      const titleOrder = a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
      const aValue = field === 'size' ? a.size : field === 'date' ? a.date : a.duration;
      const bValue = field === 'size' ? b.size : field === 'date' ? b.date : b.duration;
      // Albums and movies awaiting duration metadata stay after known durations in either direction.
      if (aValue === undefined) return bValue === undefined ? titleOrder : 1;
      if (bValue === undefined) return -1;
      return (ascending ? aValue - bValue : bValue - aValue) || titleOrder;
    });
  });
  readonly galleryItems = computed<MediaGalleryItem[]>(() => (this.selectedAlbum() ?? []).map(item => ({ id: item.id, collection: item.directoryId, kind: 'image', src: item.contentUrl, alt: item.title, type: item.mimeType })));
  constructor() {
    void this.load();
    const timer = setInterval(() => { if (!this.busy() && !this.savingIds().length) void this.refreshPosters(); }, 5000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }
  private async refreshPosters() {
    try {
      const snapshot = await firstValueFrom(this.http.get<LibrarySnapshot>('/api/media'));
      if (this.savingIds().length) return;
      this.snapshot.set(snapshot);
      const selected = this.selectedVideo();
      if (selected) this.selectedVideo.set(snapshot.items.find(item => item.id === selected.id) ?? selected);
    } catch { /* Keep the current library during temporary connection failures. */ }
  }
  durationTime(time: number) {
    const seconds = Math.floor(time);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds % 3600 / 60);
    const remainder = String(seconds % 60).padStart(2, '0');
    return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${remainder}` : `${minutes}:${remainder}`;
  }
  openCardWithKey(event: KeyboardEvent, entry: { video?: MediaItem; album?: MediaItem[] }) {
    if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    this.open(entry);
  }
  frameTime(time: number) {
    return `${Math.floor(time / 60)}:${String(Math.floor(time % 60)).padStart(2, '0')}`;
  }
  async load(rescan = false) {
    this.busy.set(true); this.error.set('');
    try {
      this.snapshot.set(await firstValueFrom(rescan ? this.http.post<LibrarySnapshot>('/api/library/rescan', {}) : this.http.get<LibrarySnapshot>('/api/media')));
    } catch { this.error.set('Could not load the library. Check that the server is running.'); }
    finally { this.busy.set(false); }
  }
  isVR(item: MediaItem) { return item.projection !== 'flat' || item.stereoMode !== 'mono'; }
  openVR(item: MediaItem) { if (this.isVR(item)) this.selectedVR.set(item); }
  open(entry: { video?: MediaItem; album?: MediaItem[] }) {
    if (this.editMode()) return;
    this.selectedVideo.set(entry.video ?? null);
    this.selectedAlbum.set(entry.album ?? null);
    this.selectedVR.set(entry.video && this.isVR(entry.video) ? entry.video : null);
  }
  close() { this.selectedVR.set(null); this.selectedVideo.set(null); this.selectedAlbum.set(null); }
}
