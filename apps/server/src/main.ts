import 'reflect-metadata';
import { ZodError } from 'zod';
import { Controller, Get, Head, Patch, Body, BadRequestException, ConflictException, Module, Param, Post, Res, NotFoundException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import express, { type Response } from 'express';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { MediaLibrary } from './library';
import { PosterWorker } from './posters';

const library = MediaLibrary.fromEnvironment();
const posters = new PosterWorker(library);
@Controller('api')
class MediaController {
  @Get('media') list() { return library.list(); }
  @Post('library/rescan') async rescan() {
    const snapshot = await library.rescan();
    await Promise.all(snapshot.items.filter(item => item.mediaType === 'video').map(item => posters.hydrate(item)));
    void posters.refresh();
    return snapshot;
  }
  @Get('media/:id/posters/:generation/:index') async poster(@Param('id') id: string, @Param('generation') generation: string, @Param('index') index: string, @Res() response: Response) {
    let file: string | undefined;
    try { file = await posters.resolve(id, generation, index); } catch {}
    if (!file) throw new NotFoundException();
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.sendFile(file, { dotfiles: 'allow' });
  }
  @Patch('media/:id/metadata') async update(@Param('id') id: string, @Body() body: unknown) {
    if (!library.get(id)) throw new NotFoundException();
    try { return await library.updateMetadata(id, body); }
    catch (error) {
      if (error instanceof ZodError) throw new BadRequestException('Invalid metadata fields');
      throw new ConflictException('Could not save metadata. Check the sidecar and metadata folder permissions.');
    }
  }
  @Get('media/:id') item(@Param('id') id: string) {
    const item = library.get(id);
    if (!item) throw new NotFoundException();
    return item;
  }
  @Head('media/:id/content') head(@Param('id') id: string, @Res() response: Response) { return this.content(id, response); }
  @Get('media/:id/content') async content(@Param('id') id: string, @Res() response: Response) {
    let file: string | undefined;
    try { file = await library.resolveContent(id); } catch { throw new NotFoundException(); }
    if (!file) throw new NotFoundException();
    response.setHeader('Content-Type', library.get(id)!.mimeType);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    // Express delegates to send: range, suffix ranges, HEAD, validators and disconnect handling.
    response.sendFile(file, { dotfiles: 'allow', acceptRanges: true }, error => {
      if (error && !response.headersSent && !response.destroyed) response.status((error as any).statusCode ?? 500).end();
    });
  }
}
@Module({ controllers: [MediaController] })
class AppModule {}
async function bootstrap() {
  await library.rescan();
  await Promise.all(library.list().items.filter(item => item.mediaType === 'video').map(item => posters.hydrate(item)));
  const certPath = process.env.TLS_CERT;
  const keyPath = process.env.TLS_KEY;
  if (!!certPath !== !!keyPath) throw new Error('TLS_CERT and TLS_KEY must be configured together');
  const httpsOptions = certPath && keyPath ? { cert: await readFile(certPath), key: await readFile(keyPath) } : undefined;
  const app = await NestFactory.create(AppModule, { httpsOptions });
  const webRoot = path.resolve('dist/web/browser');
  app.use(express.static(webRoot));
  await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
  void posters.refresh();
  setInterval(() => {
    void library.rescan().then(async snapshot => {
      await Promise.all(snapshot.items.filter(item => item.mediaType === 'video').map(item => posters.hydrate(item)));
      await posters.refresh();
    }).catch(error => console.warn('Background library scan failed', error));
  }, 60000).unref();
}
void bootstrap();
