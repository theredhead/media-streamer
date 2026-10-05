import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MediaLibrary, stableId, inferPresentation } from './library';

test('infers VR only from a complete projection/stereo suffix pair', () => {
  for (const filename of ['walk_180_sbs.mp4', 'walk 180 sbs.mp4', 'walk_180_SBS.MP4', 'walk_sbs_180.mp4', 'walk SBS 180.MP4']) {
    assert.deepEqual(inferPresentation(filename), { projection: '180', stereoMode: 'sbs' });
  }
  assert.deepEqual(inferPresentation('photo_360_ou.jpg'), { projection: '360', stereoMode: 'ou' });
  assert.deepEqual(inferPresentation('photo_ou_360.jpg'), { projection: '360', stereoMode: 'ou' });
  for (const filename of ['walk.mp4', 'walk_flat_mono.mp4', 'walk_180_mono.mp4', 'walk_flat_sbs.mp4', 'walk_180_sbs_.mp4', 'walk_180_.mp4', 'walk__sbs.mp4', 'walk_180_sbs_extra.mp4', 'walk_180_360.mp4', 'walk_sbs_ou.mp4']) {
    assert.deepEqual(inferPresentation(filename), { projection: 'flat', stereoMode: 'mono' }, filename);
  }
});

test('indexes albums, validates sidecars, retains identity and excludes escaping symlinks', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'media-streamer-'));
  try {
    const media = path.join(temporary, 'media');
    const metadata = path.join(temporary, 'metadata');
    await mkdir(path.join(media, 'holiday'), { recursive: true });
    await mkdir(path.join(metadata, 'test', 'holiday'), { recursive: true });
    await writeFile(path.join(media, 'holiday', 'photo.jpg'), 'image');
    await writeFile(path.join(media, 'holiday', 'clip.mp4'), 'video');
    await writeFile(path.join(metadata, 'test', 'holiday', 'photo.jpg.json'), JSON.stringify({ title: 'Beach', tags: ['summer'], projection: '180', id: 'untrusted' }));
    await writeFile(path.join(metadata, 'test', 'holiday', 'clip.mp4.json'), '{broken');
    await writeFile(path.join(temporary, 'outside.jpg'), 'outside');
    await symlink(path.join(temporary, 'outside.jpg'), path.join(media, 'escape.jpg'));
    const library = new MediaLibrary([{ id: 'test', path: media }], metadata);
    const first = await library.rescan();
    assert.equal(first.items.length, 2);
    const image = first.items.find(item => item.mediaType === 'image')!;
    assert.equal(image.title, 'Beach');
    assert.equal(image.id, stableId('test', 'holiday/photo.jpg'));
    assert.equal(image.directoryId, first.items[0].directoryId);
    assert.equal(first.warnings.length, 1);
    assert.equal(JSON.stringify(first).includes(temporary), false);
    assert.deepEqual((await library.rescan()).items.map(item => item.id), first.items.map(item => item.id));
    await rm(path.join(media, 'holiday', 'photo.jpg'));
    await symlink(path.join(temporary, 'outside.jpg'), path.join(media, 'holiday', 'photo.jpg'));
    assert.equal(await library.resolveContent(image.id), undefined);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('unavailable roots produce a warning without preventing other roots from scanning', async () => {
  const library = new MediaLibrary([{ id: 'missing', path: '/nonexistent/media-streamer-test-root' }], '/nonexistent/metadata');
  const snapshot = await library.rescan();
  assert.equal(snapshot.items.length, 0);
  assert.equal(snapshot.warnings.length, 1);
});

test('metadata edits persist overrides, preserve unrelated fields and serialize updates', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'media-edit-'));
  try {
    const media = path.join(temporary, 'media');
    const metadata = path.join(temporary, 'metadata');
    await mkdir(media);
    await mkdir(path.join(metadata, 'test'), { recursive: true });
    await writeFile(path.join(media, 'clip_360_sbs.mp4'), 'movie');
    const sidecar = path.join(metadata, 'test', 'clip_360_sbs.mp4.json');
    await writeFile(sidecar, JSON.stringify({ favorite: true, customField: 'preserved' }));
    const library = new MediaLibrary([{ id: 'test', path: media }], metadata);
    const id = (await library.rescan()).items[0].id;
    await Promise.all([library.updateMetadata(id, { title: ' Display name ', tags: ['holiday', 'holiday'] }), library.updateMetadata(id, { presentation: 'flat' })]);
    let item = (await library.rescan()).items[0];
    assert.equal(item.title, 'Display name');
    assert.deepEqual(item.tags, ['holiday']);
    assert.equal(item.projection, 'flat');
    assert.equal(item.stereoMode, 'mono');
    const { readFile } = await import('node:fs/promises');
    const saved = JSON.parse(await readFile(sidecar, 'utf8'));
    assert.equal(saved.favorite, true);
    assert.equal(saved.customField, 'preserved');
    item = await library.updateMetadata(id, { presentation: 'vr' });
    assert.equal(item.projection, '360');
    assert.equal(item.stereoMode, 'sbs');
    await writeFile(path.join(media, 'plain.mp4'), 'movie');
    const plain = (await library.rescan()).items.find(value => value.relativePath === 'plain.mp4')!;
    const vr = await library.updateMetadata(plain.id, { presentation: 'vr' });
    assert.equal(vr.projection, '180');
    assert.equal(vr.stereoMode, 'sbs');
    await assert.rejects(library.updateMetadata(id, { title: ' ' }));
    await assert.rejects(library.updateMetadata(id, { relativePath: '../outside' }));
    await writeFile(sidecar, '{broken');
    await assert.rejects(library.updateMetadata(id, { title: 'Do not overwrite' }));
    assert.equal(await readFile(sidecar, 'utf8'), '{broken');
    await rm(sidecar);
    const outside = path.join(temporary, 'outside.json');
    await writeFile(outside, '{}');
    await symlink(outside, sidecar);
    await assert.rejects(library.updateMetadata(id, { title: 'Unsafe' }));
    assert.equal(await readFile(outside, 'utf8'), '{}');
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
