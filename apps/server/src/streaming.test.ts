import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import os from 'node:os';
import type { LibrarySnapshot } from '../../../packages/contracts/media';

test('real Nest HTTP endpoint streams ranges, suffixes, HEAD, validators and missing IDs', { timeout: 20000 }, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'media-streamer-http-'));
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  await writeFile(path.join(temporary, 'test.mp4'), '0123456789');
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/server/src/main.ts'], {
    env: { ...process.env, PORT: String(port), MEDIA_ROOTS: JSON.stringify([{ id: 'fixture', path: temporary }]), METADATA_ROOT: path.join(temporary, 'metadata') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
  const base = `http://127.0.0.1:${port}`;
  try {
    let catalogue: LibrarySnapshot | undefined;
    for (let attempt = 0; attempt < 60; attempt++) {
      try { catalogue = await (await fetch(`${base}/api/media`)).json() as LibrarySnapshot; break; }
      catch { if (child.exitCode !== null) throw new Error(logs); await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    assert.ok(catalogue, logs);
    const content = `${base}${catalogue.items[0].contentUrl}`;
    let response = await fetch(content, { headers: { Range: 'bytes=2-5' } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), 'bytes 2-5/10');
    assert.equal(await response.text(), '2345');
    response = await fetch(content, { headers: { Range: 'bytes=-3' } });
    assert.equal(response.status, 206);
    assert.equal(await response.text(), '789');
    response = await fetch(content, { headers: { Range: 'bytes=7-' } });
    assert.equal(response.status, 206);
    assert.equal(await response.text(), '789');
    response = await fetch(content, { headers: { Range: 'bytes=99-' } });
    assert.equal(response.status, 416);
    assert.equal(response.headers.get('content-range'), 'bytes */10');
    response = await fetch(content, { method: 'HEAD' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-length'), '10');
    assert.equal(response.headers.get('accept-ranges'), 'bytes');
    assert.equal(await response.text(), '');
    const etag = response.headers.get('etag')!;
    response = await fetch(content, { headers: { 'If-None-Match': etag, 'Cache-Control': 'max-age=0' } });
    assert.equal(response.status, 304);
    response = await fetch(content, { headers: { Range: 'bytes=0-1', 'If-Range': '"stale"' } });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '0123456789');
    assert.equal((await fetch(`${base}/api/media/unknown/content`)).status, 404);
    assert.equal((await fetch(`${base}/api/library/rescan`, { method: 'POST' })).status, 201);
  } finally {
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    if (child.exitCode === null) { child.kill('SIGTERM'); await exited; }
    await rm(temporary, { recursive: true, force: true });
  }
});
