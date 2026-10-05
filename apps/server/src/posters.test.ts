import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MediaLibrary } from './library';
import { PosterWorker, posterTimes } from './posters';

test('posters publish ten frames, cache across restart, refresh modified videos and repair missing frames', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'posters-'));
  try {
    const media = path.join(temporary, 'media');
    await mkdir(media);
    const movie = path.join(media, 'movie.mp4');
    await writeFile(movie, 'movie');
    const library = new MediaLibrary([{ id: 'test', path: media }], path.join(temporary, 'metadata'));
    await library.rescan();
    let probes = 0, frames = 0;
    const run = (async (command: string, args: string[]) => {
      if (command === 'ffprobe') { probes++; return { stdout: '{"format":{"duration":"100"}}', stderr: '' }; }
      frames++;
      await writeFile(args.at(-1)!, 'jpeg');
      if (frames <= 10) assert.equal(library.list().items[0].posterFrames, undefined);
      return { stdout: '', stderr: '' };
    }) as any;
    const worker = new PosterWorker(library, run);
    await Promise.all([worker.refresh(), worker.refresh()]);
    let item = library.list().items[0];
    assert.deepEqual(item.posterFrames?.map(frame => frame.time), posterTimes(100));
    assert.equal(frames, 10);
    await library.rescan();
    await new PosterWorker(library, run).refresh();
    assert.equal(probes, 1);
    item = library.list().items[0];
    const generation = item.posterFrames![0].url.split('/').at(-2)!;
    assert.ok(await worker.resolve(item.id, generation, '0'));
    assert.equal(await worker.resolve(item.id, '../escape', '0'), undefined);
    assert.equal(await worker.resolve(item.id, generation, '10'), undefined);
    await rm(path.join(library.metadataRoot, 'posters', item.id, generation, '0.jpg'));
    await worker.refresh();
    assert.equal(frames, 20);
    await utimes(movie, new Date(), new Date(Date.now() + 5000));
    await library.rescan();
    await worker.refresh();
    assert.equal(frames, 30);
    assert.equal(probes, 3);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('failed extraction never publishes a partial set', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'posters-failure-'));
  try {
    await writeFile(path.join(temporary, 'movie.mp4'), 'movie');
    const library = new MediaLibrary([{ id: 'test', path: temporary }], path.join(temporary, 'metadata'));
    await library.rescan();
    const worker = new PosterWorker(library, (async (command: string) => {
      if (command === 'ffprobe') return { stdout: '{"format":{"duration":100}}', stderr: '' };
      throw new Error('decoder failed');
    }) as any);
    await worker.refresh();
    assert.equal(library.list().items[0].posterFrames, undefined);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
