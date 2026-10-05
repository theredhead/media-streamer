# Media Streamer

A local filesystem media library for browser playback, built with NestJS, Angular 21 and LucidKit 0.2.0. Images directly inside each directory form an album; videos appear individually. Search uses LucidKit's in-memory datasource. Originals stream directly to the LucidKit player with HTTP byte ranges.

## Run locally

```sh
# Install ffmpeg (including ffprobe) and make both available on PATH.
npm ci
npm run dev
```

Open http://localhost:4200. Put images and videos under `~/Movies/MediaStreamer/Media`, optionally in subdirectories, then click **Rescan**. The API runs on port 3000; Angular proxies API requests to it. Production: `npm run build` followed by `npm start`, then browse port 3000.

## Configure roots and metadata

`MEDIA_ROOTS` is a JSON array with unique, stable root IDs and filesystem paths. The default root ID is `local`, serving `~/Movies/MediaStreamer/Media`. `METADATA_ROOT` defaults to `~/Movies/MediaStreamer/Data`; `PORT` defaults to `3000`. Local paths are resolved from the current user's home directory.

```sh
MEDIA_ROOTS='[{"id":"vr","path":"/Volumes/VR"}]' METADATA_ROOT='./data/metadata' npm run dev:server
```

With the default configuration, `~/Movies/MediaStreamer/Media/Paris/walk.mp4` uses metadata at `~/Movies/MediaStreamer/Data/local/Paris/walk.mp4.json`:

```json
{
  "schemaVersion": 1,
  "title": "Walking through Paris",
  "projection": "180",
  "stereoMode": "sbs",
  "tags": ["Paris", "walking"]
}
```

Projection accepts `flat`, `180`, or `360`; stereo accepts `mono`, `sbs`, or `ou`. Sidecars contain overrides, never server paths or IDs. Invalid sidecars are reported in library warnings and file defaults remain usable. Media symlinks are excluded. IDs are deterministic from root ID and relative path, so renames change identity. Rescans publish a complete snapshot atomically; overlapping rescans share one scan.

Filename inference removes the extension, treats spaces as underscores, and reads the final two tokens as projection and stereo mode in either order (case-insensitive). The pair must contain `180`/`360` and `sbs`/`ou`, such as `walk_180_sbs.mp4`, `walk_sbs_180.mp4` or `photo ou 360.jpg`. Missing, empty or unrecognized tokens default to flat/mono. Files are not renamed. Explicit sidecar values override filename inference.

## Movie poster frames

A background queue extracts 10 JPEG frames per movie at 5%, 15%, …, 95% of its duration. The library shows the first frame on the card and all 10 with timestamps in the movie view, updating automatically as extraction completes. FFmpeg and ffprobe must be on the server PATH; Docker includes them.

Startup, Rescan, and a background scan every minute check for new or modified videos. Generated metadata records the source modification time and size; unchanged movies with a complete frame set are skipped without probing or decoding. Missing frames are repaired. Frames and their generated metadata live under `METADATA_ROOT/posters/<id>/`, separately from editable JSON sidecars. Extraction runs one movie and one frame at a time in child processes, publishes only complete sets, and retries failures on the next scan. Originals modified during extraction are discarded and retried after reindexing. Failed extraction is logged without preventing playback.

## Docker

```sh
cp .env.example .env
# Edit MEDIA_PATH and METADATA_PATH in .env and create those directories.
docker compose up --build
```

Browse http://localhost:3000. Docker Compose reads host paths from the root `.env` file: `MEDIA_PATH` is mounted read-only at `/media/local`, and `METADATA_PATH` is mounted writable at `/metadata`. For a fresh checkout, copy `.env.example` to `.env` and set both variables to absolute paths on your host. The example uses `/Data/MediaStreamer/Media` and `/Data/MediaStreamer/Data`. `.env` is excluded from Git and the Docker build context. These Compose host-path variables do not change the local Node server's `MEDIA_ROOTS`/`METADATA_ROOT` configuration.

Metadata remains persistent and can be edited externally or through Edit mode in the gear menu. Video cards expose Flat/VR and a form for display name, comma-separated tags, projection, and stereo layout. Edits are atomically saved to the per-file JSON sidecar, preserve unrelated fields, and never rename originals. VR uses filename hints when available, otherwise defaults to 180° side by side. The container runs as a non-root user; the media directory must be readable and the metadata directory writable by it.

## API

- `GET /api/media`: catalogue snapshot (`items`, `warnings`, `scannedAt`).
- `GET /api/media/:id`: public file metadata.
- `PATCH /api/media/:id/metadata`: save title, tags, presentation, projection, or stereo overrides.
- `GET|HEAD /api/media/:id/content`: original bytes, HTTP Range support and cache validators.
- `POST /api/library/rescan`: rebuild the catalogue and queue poster extraction.
- `GET /api/media/:id/posters/:generation/:index`: generated JPEG frame (index 0–9).

`npm test` verifies indexing, filesystem boundaries and the actual Nest HTTP endpoint's ranges, suffix requests, HEAD responses and cache validators. `npm run build` checks backend TypeScript and Angular templates.

## Scope

This version implements browsing, search, directory image albums, flat playback, byte streaming and an experimental WebXR viewer. It generates movie poster frames but does not yet generate image thumbnails, probe codecs, accept uploads or transcode. Large original images can still exceed headset texture or memory limits inside an album.

## Quest / VR testing

Open a video and click **VR viewer**, or use an album's **View … in VR** button. The preview supports drag-to-look, flat stereo planes, and equirectangular 180°/360° spheres. SBS assumes left eye first; over-under assumes left eye on top. **Swap eyes** reverses that convention. Fisheye VR180 layouts are not supported yet. **Enter VR** becomes available when a secure context and immersive WebXR support are detected. In immersion, controls start hidden. Press A on the right controller to show or hide the scene-rendered panel, then look slightly down. Point either controller and pull the trigger to play/pause, skip ±10 seconds or **Exit VR**. Point at the timeline and hold the trigger while moving to scrub. The panel follows head position and horizontal direction. The headset menu remains a fallback for exiting. Press **Device check** to inspect browser, secure context, WebXR, texture limits and codec hints; codec hints do not guarantee actual playback.

For a USB test, connect a headset with USB debugging enabled and authorize this Mac on the headset. Then:

```sh
adb devices -l
adb reverse tcp:3000 tcp:3000
```

With the server running on the Mac, open **http://localhost:3000** in the headset browser. Localhost is treated as a secure context without a certificate. Developer mode and debugging authorization must be completed on the device by its owner.

For Wi-Fi HTTPS testing:

```sh
npm run cert:local
npm run build
npm run start:https
```

The generator creates a private local CA and server certificate for this Mac's current IPv4 addresses and hostname under ignored `.certs/`; it does not install trust or change device settings. The server uses HTTPS on port 3443. Importing `.certs/ca-cert.pem` as a trusted CA on the headset is a separate, user-controlled step; browser/OS support varies. Check **Device check → secureContext** before testing immersion. A certificate warning alone does not prove WebXR will work. Keep private keys on the Mac. The server certificate expires after 90 days and applies only to the addresses present when generated.

For other certificates, set both `TLS_CERT` and `TLS_KEY` to PEM file paths when starting the server. Docker HTTPS requires mounting the certificates, setting these variables to container paths, and mapping the HTTPS port; the default Compose service remains HTTP for USB testing.

The actual Quest browser must be tested for Angular/runtime compatibility, codecs, seeking and gallery memory usage. WebXR requires a secure context: configure trusted HTTPS before adding immersive playback. Keep this unauthenticated service on a trusted local network; do not expose it publicly. The frontend and server share an origin.
