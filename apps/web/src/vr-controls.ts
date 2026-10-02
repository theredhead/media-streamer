import * as THREE from 'three';

/** A scene-rendered HUD: HTML controls are not visible in immersive WebXR. */
export class VRControls {
  private readonly canvas = document.createElement('canvas');
  private readonly context: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly panel: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly raycaster = new THREE.Raycaster();
  private readonly rotation = new THREE.Matrix4();
  private readonly controllers: { controller: THREE.Group; line: THREE.Line; held: boolean; scrubbing: boolean; start: () => void; end: () => void; connected: () => void; disconnected: () => void }[] = [];
  private lastDraw = 0;
  private lastState = '';
  private menuVisible = false;
  private aPressed = false;
  private wasActive = false;
  constructor(private readonly renderer: THREE.WebGLRenderer, private readonly scene: THREE.Scene,
    private readonly video: () => HTMLVideoElement | undefined, private readonly exit: () => void,
    private readonly toggle: () => void) {
    this.canvas.width = 1024; this.canvas.height = 320;
    this.context = this.canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
    this.panel = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 0.5625), new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false, depthWrite: false }));
    this.panel.layers.enable(1); this.panel.layers.enable(2);
    this.panel.renderOrder = 1000;
    this.panel.visible = false;
    scene.add(this.panel);
    for (let index = 0; index < 2; index++) {
      const controller = renderer.xr.getController(index);
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]), new THREE.LineBasicMaterial({ color: 0x72dfef, depthTest: false }));
      line.layers.enable(1); line.layers.enable(2); line.renderOrder = 1001;
      line.scale.z = 3; line.visible = false;
      controller.add(line); scene.add(controller);
      const state = { controller, line, held: false, scrubbing: false,
        start: () => { state.held = true; this.select(state); },
        end: () => { state.held = false; state.scrubbing = false; },
        connected: () => { line.visible = this.panel.visible; },
        disconnected: () => { line.visible = false; state.end(); } };
      controller.addEventListener('selectstart', state.start);
      controller.addEventListener('selectend', state.end);
      controller.addEventListener('connected', state.connected);
      controller.addEventListener('disconnected', state.disconnected);
      this.controllers.push(state);
    }
    this.draw();
  }
  private hit(controller: THREE.Group) {
    // WebXR changes local poses before render; raycasting needs their fresh world matrices.
    controller.updateWorldMatrix(true, false);
    this.rotation.extractRotation(controller.matrixWorld);
    this.raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
    this.raycaster.ray.direction.set(0, 0, -1).applyMatrix4(this.rotation);
    return this.raycaster.intersectObject(this.panel)[0];
  }
  private seek(fraction: number) {
    const video = this.video();
    if (video && Number.isFinite(video.duration) && video.duration > 0) video.currentTime = Math.max(0, Math.min(video.duration, fraction * video.duration));
  }
  private skip(seconds: number) {
    const video = this.video();
    if (video && Number.isFinite(video.duration) && video.duration > 0) video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime + seconds));
  }
  private select(state: typeof this.controllers[number]) {
    if (!this.panel.visible) return;
    const hit = this.hit(state.controller);
    if (!hit?.uv) return;
    const x = hit.uv.x * 1024, y = (1 - hit.uv.y) * 320;
    if (y >= 220 && y <= 305 && this.video()) {
      state.scrubbing = true; this.seek((x - 48) / 928);
    } else if (y >= 80 && y <= 180) {
      if (x >= 760 && x <= 976) this.exit();
      else if (this.video()) {
        if (x >= 48 && x <= 264) this.skip(-10);
        else if (x >= 280 && x <= 496) this.toggle();
        else if (x >= 512 && x <= 728) this.skip(10);
      }
    }
    this.draw();
  }
  update(camera: THREE.Camera, active: boolean) {
    const right = Array.from(this.renderer.xr.getSession()?.inputSources ?? []).find(source => source.handedness === 'right');
    // Oculus Touch xr-standard mapping: right-hand primary face button (A) is button 4.
    const pressed = right?.gamepad?.buttons[4]?.pressed ?? false;
    if (active && !this.wasActive) { this.menuVisible = false; this.aPressed = pressed; }
    if (active && pressed && !this.aPressed) this.menuVisible = !this.menuVisible;
    this.aPressed = pressed;
    this.wasActive = active;
    this.panel.visible = active && this.menuVisible;
    for (const state of this.controllers) state.line.visible = this.panel.visible && state.controller.visible;
    if (!this.panel.visible) { for (const state of this.controllers) state.end(); return; }
    // Follow head position and yaw only: the panel stays below the horizon and can be looked at.
    const position = new THREE.Vector3(); const quaternion = new THREE.Quaternion();
    camera.getWorldPosition(position); camera.getWorldQuaternion(quaternion);
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(quaternion);
    const yaw = Math.atan2(-forward.x, -forward.z);
    this.panel.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    this.panel.position.copy(position).add(new THREE.Vector3(0, -0.65, -2).applyQuaternion(this.panel.quaternion));
    this.panel.updateMatrixWorld(true);
    for (const state of this.controllers) {
      const hit = this.hit(state.controller);
      state.line.scale.z = hit?.distance ?? 3;
      (state.line.material as THREE.LineBasicMaterial).color.setHex(hit ? 0xffffff : 0x72dfef);
      if (state.held && state.scrubbing && hit?.uv) this.seek((hit.uv.x * 1024 - 48) / 928);
    }
    const video = this.video();
    const state = `${video?.paused}:${Math.floor(video?.currentTime ?? 0)}:${Math.floor(video?.duration ?? 0)}`;
    if (state !== this.lastState || (video && !video.paused && performance.now() - this.lastDraw > 250)) { this.lastState = state; this.draw(); }
  }
  private time(seconds: number) {
    if (!Number.isFinite(seconds)) return '--:--';
    const minutes = Math.floor(seconds / 60);
    return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
  }
  private draw() {
    const ctx = this.context, video = this.video();
    ctx.clearRect(0, 0, 1024, 320);
    ctx.fillStyle = 'rgba(12, 22, 29, 0.96)'; ctx.fillRect(0, 0, 1024, 320);
    ctx.font = '28px sans-serif'; ctx.fillStyle = '#fff'; ctx.textAlign = 'left';
    ctx.fillText(video ? `${this.time(video.currentTime)} / ${this.time(video.duration)}` : 'Image viewer', 48, 48);
    const labels = ['−10 seconds', video?.paused ? 'Play' : 'Pause', '+10 seconds', 'Exit VR'];
    for (let index = 0; index < 4; index++) {
      const x = 48 + index * 232;
      ctx.fillStyle = index === 3 ? '#8c3434' : video ? '#245968' : '#28333b'; ctx.fillRect(x, 80, 216, 100);
      ctx.fillStyle = index === 3 || video ? '#fff' : '#71808b'; ctx.textAlign = 'center'; ctx.fillText(labels[index], x + 108, 140);
    }
    if (video) {
      const fraction = Number.isFinite(video.duration) && video.duration > 0 ? video.currentTime / video.duration : 0;
      ctx.fillStyle = '#56616c'; ctx.fillRect(48, 240, 928, 14);
      ctx.fillStyle = '#72dfef'; ctx.fillRect(48, 240, 928 * fraction, 14);
      ctx.beginPath(); ctx.arc(48 + 928 * fraction, 247, 16, 0, Math.PI * 2); ctx.fill();
      ctx.font = '22px sans-serif'; ctx.fillStyle = '#fff'; ctx.fillText('Point and hold trigger to scrub', 512, 295);
    }
    this.texture.needsUpdate = true;
    this.lastDraw = performance.now();
  }
  dispose() {
    for (const state of this.controllers) {
      state.controller.removeEventListener('selectstart', state.start);
      state.controller.removeEventListener('selectend', state.end);
      state.controller.removeEventListener('connected', state.connected);
      state.controller.removeEventListener('disconnected', state.disconnected);
      state.controller.remove(state.line); this.scene.remove(state.controller);
      state.line.geometry.dispose(); (state.line.material as THREE.Material).dispose();
    }
    this.scene.remove(this.panel); this.panel.geometry.dispose(); this.panel.material.dispose(); this.texture.dispose();
  }
}
