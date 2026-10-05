import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile, realpath, stat, mkdir, lstat, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { lookup } from 'mime-types';
import { z } from 'zod';
import type { LibrarySnapshot, MediaItem } from '../../../packages/contracts/media';

const rootsSchema = z.array(z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]+$/), path: z.string().min(1) })).min(1)
  .refine(roots => new Set(roots.map(root => root.id)).size === roots.length, 'Root IDs must be unique');
const metadataSchema = z.object({
  schemaVersion: z.literal(1).optional(), title: z.string().min(1).optional(),
  projection: z.enum(['flat', '180', '360']).optional(), stereoMode: z.enum(['mono', 'sbs', 'ou']).optional(),
  tags: z.array(z.string()).optional(), favorite: z.boolean().optional(), posterTime: z.number().nonnegative().optional(),
});
const updateSchema = z.object({
  title: z.string().trim().min(1).max(500).optional(),
  tags: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
  presentation: z.enum(['flat', 'vr']).optional(),
  projection: z.enum(['flat', '180', '360']).optional(),
  stereoMode: z.enum(['mono', 'sbs', 'ou']).optional(),
}).strict().refine(value => Object.keys(value).length > 0, 'No metadata changes');
export type Root = z.infer<typeof rootsSchema>[number];
export function inferPresentation(filename: string): Pick<MediaItem, 'projection' | 'stereoMode'> {
  const tokens = path.parse(filename).name.replace(/ /g, '_').toLowerCase().split('_');
  const suffix = tokens.slice(-2);
  const projection = suffix.find(token => token === '180' || token === '360');
  const stereoMode = suffix.find(token => token === 'sbs' || token === 'ou');
  if ((projection === '180' || projection === '360') && (stereoMode === 'sbs' || stereoMode === 'ou')) {
    return { projection, stereoMode };
  }
  return { projection: 'flat', stereoMode: 'mono' };
}
export const stableId = (rootId: string, relativePath: string) => createHash('sha256').update(JSON.stringify([rootId, relativePath])).digest('hex');
export const contained = (root: string, candidate: string) => {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

export class MediaLibrary {
  private files = new Map<string, { absolutePath: string; rootPath: string }>();
  private snapshot: LibrarySnapshot = { items: [], warnings: [], scannedAt: '' };
  private scanning?: Promise<LibrarySnapshot>;
  private writes = new Map<string, Promise<MediaItem>>();
  constructor(readonly roots: Root[], readonly metadataRoot: string) {}
  static fromEnvironment() {
    const storageRoot = path.join(homedir(), 'Movies', 'MediaStreamer');
    const roots = rootsSchema.parse(JSON.parse(process.env.MEDIA_ROOTS ?? JSON.stringify([{ id: 'local', path: path.join(storageRoot, 'Media') }])));
    return new MediaLibrary(roots, path.resolve(process.env.METADATA_ROOT ?? path.join(storageRoot, 'Data')));
  }
  list() { return this.snapshot; }
  get(id: string) { return this.snapshot.items.find(item => item.id === id); }
  async resolveContent(id: string) {
    const file = this.files.get(id);
    if (!file) return undefined;
    const resolved = await realpath(file.absolutePath);
    if (!contained(file.rootPath, resolved)) return undefined;
    return resolved;
  }
  async updateMetadata(id: string, input: unknown): Promise<MediaItem> {
    const update = updateSchema.parse(input);
    const previous = this.writes.get(id);
    const writing = (async () => {
      if (previous) await previous.catch(() => {});
      if (this.scanning) await this.scanning;
      const item = this.get(id);
      if (!item) throw new Error('Media not found');
      await mkdir(this.metadataRoot, { recursive: true });
      const root = await realpath(this.metadataRoot);
      let directory = root;
      for (const segment of [item.rootId, ...item.relativePath.split('/').slice(0, -1)]) {
        directory = path.join(directory, segment);
        await mkdir(directory).catch(error => { if (error.code !== 'EEXIST') throw error; });
        if ((await lstat(directory)).isSymbolicLink() || !contained(root, await realpath(directory))) throw new Error('Unsafe metadata directory');
      }
      const sidecar = path.join(directory, `${path.posix.basename(item.relativePath)}.json`);
      let existing: Record<string, unknown> = {};
      try {
        if (!(await lstat(sidecar)).isFile()) throw new Error('Unsafe metadata sidecar');
        existing = metadataSchema.passthrough().parse(JSON.parse(await readFile(sidecar, 'utf8')));
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const { presentation, ...fields } = update;
      const metadata = { ...existing, ...fields, schemaVersion: 1 };
      if (fields.tags) metadata.tags = [...new Set(fields.tags)];
      if (presentation === 'flat') { metadata.projection = 'flat'; metadata.stereoMode = 'mono'; }
      if (presentation === 'vr') {
        const inferred = inferPresentation(item.relativePath);
        metadata.projection = fields.projection && fields.projection !== 'flat' ? fields.projection : item.projection !== 'flat' ? item.projection : inferred.projection !== 'flat' ? inferred.projection : '180';
        metadata.stereoMode = fields.stereoMode ?? (item.projection !== 'flat' && item.stereoMode !== 'mono' ? item.stereoMode : inferred.stereoMode !== 'mono' ? inferred.stereoMode : 'sbs');
      }
      const parsed = metadataSchema.parse(metadata);
      const temporary = path.join(directory, `.${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx' });
        await rename(temporary, sidecar);
      } finally { await rm(temporary, { force: true }); }
      if (this.scanning) await this.scanning;
      const current = this.get(id);
      if (!current) throw new Error('Media no longer indexed');
      const updated = { ...current, title: parsed.title ?? current.title, tags: parsed.tags ?? current.tags,
        projection: parsed.projection ?? current.projection, stereoMode: parsed.stereoMode ?? current.stereoMode };
      this.snapshot = { ...this.snapshot, items: this.snapshot.items.map(value => value.id === id ? updated : value) };
      return updated;
    })();
    this.writes.set(id, writing);
    try { return await writing; } finally { if (this.writes.get(id) === writing) this.writes.delete(id); }
  }
  rescan(): Promise<LibrarySnapshot> {
    if (!this.scanning) this.scanning = this.scan().finally(() => { this.scanning = undefined; });
    return this.scanning;
  }
  private async scan() {
    const items: MediaItem[] = [];
    const warnings: string[] = [];
    const files = new Map<string, { absolutePath: string; rootPath: string }>();
    for (const root of this.roots) {
      let rootPath: string;
      try { rootPath = await realpath(root.path); }
      catch { warnings.push(`Root ${root.id} is unavailable`); continue; }
      const walk = async (directory: string): Promise<void> => {
        let entries;
        try { entries = await readdir(directory, { withFileTypes: true }); }
        catch { warnings.push(`Cannot read directory in ${root.id}: ${path.relative(rootPath, directory)}`); return; }
        for (const entry of entries) {
          const absolutePath = path.join(directory, entry.name);
          if (entry.isDirectory()) { await walk(absolutePath); continue; }
          if (!entry.isFile()) continue; // Symlinks are deliberately excluded.
          const mimeType = lookup(entry.name);
          if (!mimeType || !/^(image|video)\//.test(mimeType)) continue;
          const relativePath = path.relative(rootPath, absolutePath).split(path.sep).join('/');
          try {
            const file = await stat(absolutePath);
            const id = stableId(root.id, relativePath);
            const presentation = inferPresentation(entry.name);
            let metadata: z.infer<typeof metadataSchema> = {};
            try {
              const sidecar = path.join(this.metadataRoot, root.id, `${relativePath}.json`);
              const resolvedSidecar = await realpath(sidecar);
              const resolvedMetadataRoot = await realpath(this.metadataRoot);
              if (!contained(resolvedMetadataRoot, resolvedSidecar)) throw new Error('Sidecar escapes metadata root');
              metadata = metadataSchema.parse(JSON.parse(await readFile(resolvedSidecar, 'utf8')));
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push(`Invalid metadata: ${root.id}/${relativePath}`);
            }
            items.push({ id, rootId: root.id, relativePath, directoryId: stableId(root.id, path.posix.dirname(relativePath)),
              title: metadata.title ?? path.parse(entry.name).name, mediaType: mimeType.startsWith('image/') ? 'image' : 'video',
              mimeType, size: file.size, modified: file.mtime.toISOString(), projection: metadata.projection ?? presentation.projection,
              stereoMode: metadata.stereoMode ?? presentation.stereoMode, tags: metadata.tags ?? [], contentUrl: `/api/media/${id}/content` });
            files.set(id, { absolutePath, rootPath });
          } catch { warnings.push(`Cannot index ${root.id}/${relativePath}`); }
        }
      };
      await walk(rootPath);
    }
    items.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    this.files = files;
    this.snapshot = { items, warnings, scannedAt: new Date().toISOString() };
    return this.snapshot;
  }
}
