import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rename, rm, stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { contained, type MediaLibrary } from './library';
import type { MediaItem } from '../../../packages/contracts/media';

const execute = promisify(execFile);
export const posterTimes = (duration: number) => Array.from({ length: 10 }, (_, index) => duration * (index + 0.5) / 10);
interface Manifest { version: 1; modified: string; size: number; duration: number; generation: string; times: number[] }
export class PosterWorker {
  private running?: Promise<void>;
  constructor(private library: MediaLibrary, private run = execute) {}
  private directory(id: string) { return path.join(this.library.metadataRoot, 'posters', id); }
  private async manifest(item: MediaItem): Promise<Manifest | undefined> {
    try {
      const data = JSON.parse(await readFile(path.join(this.directory(item.id), 'metadata.json'), 'utf8')) as Manifest;
      if (data.version !== 1 || data.modified !== item.modified || data.size !== item.size || !/^[a-f0-9-]{36}$/.test(data.generation) ||
        !Number.isFinite(data.duration) || data.duration <= 0 || !Array.isArray(data.times) || data.times.length !== 10 || !data.times.every(time => Number.isFinite(time) && time >= 0)) return;
      await Promise.all(data.times.map((_, index) => stat(path.join(this.directory(item.id), data.generation, `${index}.jpg`))));
      return data;
    } catch { return; }
  }
  async hydrate(item: MediaItem) {
    const data = await this.manifest(item);
    if (data) {
      item.duration = data.duration;
      item.posterFrames = data.times.map((time, index) => ({ time, url: `/api/media/${item.id}/posters/${data.generation}/${index}` }));
    }
    return !!data;
  }
  async resolve(id: string, generation: string, index: string) {
    const item = this.library.get(id);
    if (!item || !/^[0-9]$/.test(index)) return;
    const data = await this.manifest(item);
    if (!data || data.generation !== generation) return;
    const root = await realpath(this.library.metadataRoot);
    const file = await realpath(path.join(this.directory(id), generation, `${index}.jpg`));
    return contained(root, file) ? file : undefined;
  }
  refresh() {
    if (!this.running) this.running = this.process().finally(() => { this.running = undefined; });
    return this.running;
  }
  private async process() {
    for (const item of this.library.list().items) {
      if (item.mediaType !== 'video' || await this.hydrate(item)) continue;
      const generation = randomUUID();
      const directory = path.join(this.directory(item.id), generation);
      let created = false;
      try {
        const source = await this.library.resolveContent(item.id);
        if (!source) continue;
        const before = await stat(source);
        if (before.mtime.toISOString() !== item.modified || before.size !== item.size) continue;
        const probe = await this.run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', source], { timeout: 30000, maxBuffer: 1024 * 1024 });
        const duration = Number(JSON.parse(String(probe.stdout)).format?.duration);
        if (!Number.isFinite(duration) || duration <= 0) throw new Error('Video duration is unavailable');
        await mkdir(this.library.metadataRoot, { recursive: true });
        const root = await realpath(this.library.metadataRoot);
        let target = root;
        for (const segment of ['posters', item.id, generation]) {
          target = path.join(target, segment);
          await mkdir(target).catch(error => { if (error.code !== 'EEXIST') throw error; });
          target = await realpath(target);
          if (!contained(root, target)) throw new Error('Poster directory escapes metadata root');
        }
        created = true;
        const times = posterTimes(duration);
        for (const [index, time] of times.entries()) {
          await this.run('ffmpeg', ['-nostdin', '-v', 'error', '-ss', String(time), '-i', source, '-map', '0:v:0', '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '3', '-threads', '1', '-y', path.join(directory, `${index}.jpg`)], { timeout: 120000, maxBuffer: 1024 * 1024 });
          if (!(await stat(path.join(directory, `${index}.jpg`))).size) throw new Error('Empty poster frame');
        }
        const after = await stat(source);
        if (after.mtimeMs !== before.mtimeMs || after.size !== before.size) throw new Error('Video changed during extraction');
        const data: Manifest = { version: 1, modified: item.modified, size: item.size, duration, generation, times };
        const temporary = path.join(this.directory(item.id), `${generation}.json`);
        await writeFile(temporary, JSON.stringify(data));
        await rename(temporary, path.join(this.directory(item.id), 'metadata.json'));
        await this.hydrate(item);
        const current = this.library.get(item.id);
        if (current && current !== item) await this.hydrate(current);
      } catch (error) {
        if (created) await rm(directory, { recursive: true, force: true });
        console.warn(`Poster extraction failed for ${item.rootId}/${item.relativePath}: ${(error as Error).message}`);
      }
    }
  }
}
