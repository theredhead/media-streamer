import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { VRControls } from './vr-controls';

test('controller rays activate playback, bounded skips, drag scrubbing and exit; listeners are cleaned up', () => {
  const originalDocument = globalThis.document;
  const context = { clearRect() {}, fillRect() {}, fillText() {}, beginPath() {}, arc() {}, fill() {} };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => ({ getContext: () => context }) } });
  try {
    const scene = new THREE.Scene();
    const controllers = [new THREE.Group(), new THREE.Group()];
    const buttons = Array.from({ length: 6 }, () => ({ pressed: false }));
    const renderer = { xr: { getController: (index: number) => controllers[index], getSession: () => ({ inputSources: [{ handedness: 'right', gamepad: { buttons } }] }) } } as unknown as THREE.WebGLRenderer;
    const video = { duration: 120, currentTime: 40, paused: true } as HTMLVideoElement;
    let toggles = 0, exits = 0;
    const controls = new VRControls(renderer, scene, () => video, () => exits++, () => toggles++);
    const camera = new THREE.PerspectiveCamera();
    function aim(x: number, y: number, index = 0) {
      controllers[index].position.set((x / 1024 - 0.5) * 1.8, -0.65 + (0.5 - y / 320) * 0.5625, 0);
      controls.update(camera, true);
    }
    function press(x: number, y: number, index = 0) {
      aim(x, y, index);
      controllers[index].dispatchEvent({ type: 'selectstart' });
      controllers[index].dispatchEvent({ type: 'selectend' });
    }
    press(388, 130); assert.equal(toggles, 0, 'controls start hidden');
    buttons[4].pressed = true; controls.update(camera, true);
    press(388, 130); assert.equal(toggles, 1, 'holding A does not repeatedly toggle visibility');
    buttons[4].pressed = false; controls.update(camera, true);
    press(156, 130); assert.equal(video.currentTime, 30);
    video.currentTime = 2; press(156, 130); assert.equal(video.currentTime, 0);
    video.currentTime = 119; press(620, 130, 1); assert.equal(video.currentTime, 120);
    aim(512, 247); controllers[0].dispatchEvent({ type: 'selectstart' });
    assert.ok(Math.abs(video.currentTime - 60) < 0.01);
    aim(976, 247); assert.equal(video.currentTime, 120);
    controllers[0].dispatchEvent({ type: 'selectend' });
    aim(48, 247); assert.equal(video.currentTime, 120, 'releasing the trigger stops scrubbing');
    press(868, 130, 1); assert.equal(exits, 1);
    press(5, 5); assert.equal(toggles, 1, 'clicking unused panel space does not toggle playback');
    buttons[4].pressed = true; controls.update(camera, true);
    press(388, 130); assert.equal(toggles, 1, 'second A press hides controls');
    buttons[4].pressed = false; controls.update(camera, false);
    controls.update(camera, true);
    press(388, 130); assert.equal(toggles, 1, 'reentering VR starts hidden');
    controls.dispose();
    controllers[0].dispatchEvent({ type: 'selectstart' });
    assert.equal(toggles, 1);
    assert.equal(scene.children.length, 0);
  } finally { Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument }); }
});
