import { AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, NgZone, OnDestroy, inject, input, signal, viewChild } from '@angular/core';
import { UIButton, UIMediaPlayer } from '@theredhead/lucid-kit';
import * as THREE from 'three';
import type { MediaItem } from '../../../packages/contracts/media';
import { VRControls } from './vr-controls';

@Component({ selector: 'app-vr-viewer', standalone: true, imports: [UIButton, UIMediaPlayer],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2>{{ item().title }}</h2>
    <p>{{ item().projection === 'flat' ? 'Flat' : item().projection + '°' }} · {{ item().stereoMode }} · {{ status() }}</p>
    <div class="vr-stage" #stage aria-label="VR preview" (pointerdown)="beginDrag($event)" (pointermove)="drag($event)" (pointerup)="endDrag()" (pointercancel)="endDrag()"></div>
    <div class="vr-actions">
      <ui-button [disabled]="!supported() || !ready() || entering()" (click)="enterVR()">{{ entering() ? 'Entering VR…' : 'Enter VR' }}</ui-button>
      <ui-button variant="outlined" (click)="resetView()">Reset view</ui-button>
      <label><input type="checkbox" [checked]="swapEyes()" (change)="setSwap($any($event.target).checked)"> Swap eyes</label>
    </div>
    <p>Drag the preview to look around. In VR, press A on the right controller to show or hide controls. Look slightly down, then point either controller and press its trigger to play/pause, skip or exit. Hold the trigger on the timeline to scrub.</p>
    @if (item().mediaType === 'video') {
      <div #playerHost><ui-media-player [source]="{url: item().contentUrl, type: item().mimeType}" [ariaLabel]="item().title" (mediaLoadedMetadata)="attachVideo()" (mediaError)="status.set('Video decoding failed. Try a compatible codec or lower resolution.')" /></div>
    }
    @if (error()) { <p role="alert">{{ error() }}</p> }
  `,
  styles: `:host { display:block; } .vr-stage { height: min(55vh, 480px); min-height: 260px; background: #000; touch-action: none; overflow:hidden; border-radius:12px; } .vr-actions {display:flex; align-items:center; flex-wrap:wrap; gap:12px; margin:16px 0;} label {display:flex; align-items:center; gap:8px;} `,
})
export class VRViewer implements AfterViewInit, OnDestroy {
  readonly item = input.required<MediaItem>();
  readonly status = signal('Checking WebXR…');
  readonly error = signal('');
  readonly supported = signal(false);
  readonly ready = signal(false);
  readonly entering = signal(false);
  readonly swapEyes = signal(false);
  private readonly zone = inject(NgZone);
  private readonly stage = viewChild.required<ElementRef<HTMLDivElement>>('stage');
  private readonly playerHost = viewChild<ElementRef<HTMLDivElement>>('playerHost');
  private renderer?: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(70, 1, 0.1, 100);
  private texture?: THREE.Texture;
  private meshes: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>[] = [];
  private video?: HTMLVideoElement;
  private resize?: ResizeObserver;
  private session?: XRSession;
  private controls?: VRControls;
  private destroyed = false;
  private dragging?: { x: number; y: number };
  private yaw = 0;
  private pitch = 0;

  ngAfterViewInit() {
    try {
      this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
      this.renderer.xr.enabled = true;
      this.renderer.xr.setReferenceSpaceType('local');
      this.renderer.xr.setFramebufferScaleFactor(1);
      this.camera.layers.set(1);
      this.stage().nativeElement.append(this.renderer.domElement);
      this.renderer.domElement.style.display = 'block';
      this.resize = new ResizeObserver(() => {
        if (!this.renderer || this.renderer.xr.isPresenting) return;
        const { clientWidth: width, clientHeight: height } = this.stage().nativeElement;
        this.renderer.setSize(width, height);
        this.camera.aspect = width / Math.max(height, 1);
        this.camera.updateProjectionMatrix();
      });
      this.resize.observe(this.stage().nativeElement);
      this.controls = new VRControls(this.renderer, this.scene, () => this.video, () => { void this.session?.end().catch(() => this.error.set('Could not exit VR. Use the headset menu.')); }, this.togglePlayback);
      this.zone.runOutsideAngular(() => this.renderer!.setAnimationLoop(() => {
        const active = this.renderer!.xr.isPresenting;
        this.controls!.update(active ? this.renderer!.xr.getCamera() : this.camera, active);
        this.renderer!.render(this.scene, this.camera);
      }));
      if (this.item().mediaType === 'image') {
        new THREE.TextureLoader().load(this.item().contentUrl, texture => {
          if (this.destroyed) { texture.dispose(); return; }
          this.texture = texture;
          this.buildScene(texture);
        }, undefined, () => this.status.set('Image could not be loaded.'));
      } else this.attachVideo();
      void this.checkXR();
    } catch { this.status.set('WebGL is unavailable in this browser.'); }
  }
  private async checkXR() {
    if (!window.isSecureContext) { this.status.set('Immersive VR needs trusted HTTPS or USB-forwarded localhost.'); return; }
    if (!navigator.xr) { this.status.set('This browser does not expose WebXR.'); return; }
    try {
      const supported = await navigator.xr.isSessionSupported('immersive-vr');
      if (this.destroyed) return;
      this.supported.set(supported);
      this.status.set(supported ? 'Ready for immersive VR' : 'Immersive VR is not supported here.');
    } catch { this.status.set('WebXR capability check failed.'); }
  }
  attachVideo() {
    if (!this.renderer || this.texture || this.destroyed) return;
    const video = this.playerHost()?.nativeElement.querySelector('video');
    if (!video || !video.videoWidth) return;
    this.video = video;
    this.texture = new THREE.VideoTexture(video);
    this.buildScene(this.texture);
  }
  private buildScene(texture: THREE.Texture) {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    const item = this.item();
    for (let eye = 0; eye < 2; eye++) {
      let geometry: THREE.BufferGeometry;
      if (item.projection === 'flat') {
        const image = texture.image as { width?: number; height?: number; videoWidth?: number; videoHeight?: number };
        let aspect = (image.videoWidth ?? image.width ?? 16) / (image.videoHeight ?? image.height ?? 9);
        if (item.stereoMode === 'sbs') aspect /= 2;
        if (item.stereoMode === 'ou') aspect *= 2;
        geometry = new THREE.PlaneGeometry(2.5 * aspect, 2.5);
      } else {
        geometry = new THREE.SphereGeometry(20, 64, 32, 0, item.projection === '180' ? Math.PI : Math.PI * 2);
        geometry.scale(-1, 1, 1);
      }
      const material = new THREE.MeshBasicMaterial({ map: texture });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.layers.set(eye + 1);
      if (item.projection === 'flat') mesh.position.z = -3;
      else mesh.rotation.y = item.projection === '180' ? Math.PI : -Math.PI / 2;
      this.meshes.push(mesh);
      this.scene.add(mesh);
    }
    this.applyEyeUVs();
    const maximum = this.renderer!.capabilities.maxTextureSize;
    const image = texture.image as { width?: number; height?: number; videoWidth?: number; videoHeight?: number };
    if ((image.videoWidth ?? image.width ?? 0) > maximum || (image.videoHeight ?? image.height ?? 0) > maximum) {
      this.error.set(`This media exceeds the browser's ${maximum}px texture limit. A smaller version may be needed.`);
    }
    this.ready.set(true);
  }
  private applyEyeUVs() {
    for (let index = 0; index < this.meshes.length; index++) {
      const mesh = this.meshes[index];
      const uv = mesh.geometry.getAttribute('uv');
      if (!mesh.geometry.userData['originalUV']) mesh.geometry.userData['originalUV'] = Float32Array.from(uv.array);
      const original = mesh.geometry.userData['originalUV'] as Float32Array;
      const eye = this.swapEyes() ? 1 - index : index;
      for (let vertex = 0; vertex < uv.count; vertex++) {
        let u = original[vertex * 2];
        let v = original[vertex * 2 + 1];
        if (this.item().stereoMode === 'sbs') u = u * 0.5 + eye * 0.5;
        if (this.item().stereoMode === 'ou') v = v * 0.5 + (eye === 0 ? 0.5 : 0);
        uv.setXY(vertex, u, v);
      }
      uv.needsUpdate = true;
    }
  }
  setSwap(value: boolean) { this.swapEyes.set(value); this.applyEyeUVs(); }
  async enterVR() {
    if (!navigator.xr || !this.renderer || this.entering()) return;
    this.entering.set(true); this.error.set('');
    // Request the session synchronously from the click to preserve user activation.
    const sessionRequest = navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor'] });
    if (this.video) void this.video.play().catch(() => this.error.set('Press Play before entering VR.'));
    try {
      const session = await sessionRequest;
      if (this.destroyed) { await session.end(); return; }
      this.session = session;
      session.addEventListener('end', () => {
        this.session = undefined;
        this.resetView();
        this.video?.pause();
      }, { once: true });
      this.resetView();
      await this.renderer.xr.setSession(session);
    } catch (error) {
      this.error.set(`Could not enter VR: ${error instanceof Error ? error.message : String(error)}`);
      if (this.session) await this.session.end().catch(() => {});
    } finally { this.entering.set(false); }
  }
  private readonly togglePlayback = () => {
    if (!this.video) return;
    if (this.video.paused) void this.video.play().catch(() => this.error.set('Video playback failed.'));
    else this.video.pause();
  };
  beginDrag(event: PointerEvent) {
    this.dragging = { x: event.clientX, y: event.clientY };
    this.stage().nativeElement.setPointerCapture(event.pointerId);
  }
  drag(event: PointerEvent) {
    if (!this.dragging || this.renderer?.xr.isPresenting) return;
    this.yaw -= (event.clientX - this.dragging.x) * 0.004;
    this.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, this.pitch - (event.clientY - this.dragging.y) * 0.004));
    this.dragging = { x: event.clientX, y: event.clientY };
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }
  endDrag() { this.dragging = undefined; }
  resetView() { this.yaw = 0; this.pitch = 0; this.camera.position.set(0, 0, 0); this.camera.rotation.set(0, 0, 0); }
  ngOnDestroy() {
    this.destroyed = true;
    this.resize?.disconnect();
    this.video?.pause();
    this.renderer?.setAnimationLoop(null);
    this.controls?.dispose();
    for (const mesh of this.meshes) { mesh.geometry.dispose(); mesh.material.dispose(); }
    this.texture?.dispose();
    const renderer = this.renderer;
    if (this.session) void this.session.end().catch(() => {}).finally(() => renderer?.dispose());
    else renderer?.dispose();
  }
}
