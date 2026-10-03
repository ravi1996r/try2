import * as THREE from 'three';

/**
 * The 3D scene: the one render-loop owner.
 *
 * WHY this module exists rather than more JSX: AGENTS.md requires exactly one render-loop owner, and
 * a loop started inside a React effect is restarted on every re-render. The scene owns its own
 * animation frame, exposes start/stop/dispose, and React only calls those.
 *
 * WHY dynamic import: the caller feature-detects WebGL first and only then imports this module, so a
 * device without WebGL never downloads ~690 kB of scene engine to be told it cannot render.
 *
 * WHY prefers-reduced-motion is honoured by not animating at all: a decorative rotating mesh is
 * exactly the kind of content that triggers vestibular discomfort, and "reduced motion" for a
 * continuous animation means stopping it, not making it slower.
 */
export interface SceneHandle {
  dispose(): void;
  /** Re-tint the scene when the page theme changes. */
  setAccent(hex: string): void;
  /**
   * WHY this is reported rather than assumed: 'reduced-motion' means the scene rendered ONE static
   * frame. A caller that wants to claim "3D is running" must not do so when this is returned.
   */
  readonly kind: 'running' | 'reduced-motion';
}

/**
 * Builds the scene on an existing canvas.
 *
 * @param canvas   the canvas to render into; the caller has already confirmed a WebGL context.
 * @param theme    current accent colour, so the scene re-tints with the page.
 */
export async function createScene(canvas: HTMLCanvasElement, accent = '#58a6ff'): Promise<SceneHandle> {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    // WHY explicit alpha: the canvas sits over the page's own background, and an opaque default
    // would paint a black box over the prerendered content on themes with a light background.
    alpha: true,
  });

  // WHY cap the pixel ratio at 2: an uncapped ratio on a 3x phone means 9x the fragments for a
  // decorative object. 2 is the point past which the visual gain stops being visible.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.z = 4;

  const geometry = new THREE.IcosahedronGeometry(1.35, 1);
  const material = new THREE.MeshBasicMaterial({
    color: new THREE.Color(accent),
    wireframe: true,
    transparent: true,
    opacity: 0.85,
  });
  const mesh = new THREE.Mesh(geometry, material);
  scene.add(mesh);

  // WHY a slow counter-rotating ring rather than lights: MeshBasicMaterial is unlit, so no light rig
  // is needed. A second object gives the scene depth without the cost of a shading model.
  const ringGeometry = new THREE.TorusGeometry(2.1, 0.012, 8, 96);
  const ring = new THREE.Mesh(ringGeometry, material);
  ring.rotation.x = Math.PI / 2.6;
  scene.add(ring);

  /** Resizes to the container. WHY a ResizeObserver: a scrollbar appearing changes the width. */
  const resize = () => {
    const parent = canvas.parentElement;
    const width = parent?.clientWidth || canvas.clientWidth || 1;
    const height = Math.min(width * 0.5, 320);
    renderer.setSize(width, height, false);
    camera.aspect = width / Math.max(1, height);
    camera.updateProjectionMatrix();
  };
  resize();
  const observer = new ResizeObserver(resize);
  if (canvas.parentElement) observer.observe(canvas.parentElement);

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let frame = 0;
  let running = false;

  const draw = () => {
    if (!running) return;
    mesh.rotation.y += 0.005;
    mesh.rotation.x += 0.0022;
    ring.rotation.z -= 0.0035;
    renderer.render(scene, camera);
    frame = requestAnimationFrame(draw);
  };

  if (reduced) {
    // WHY one static frame rather than none: the object is still meaningful as a still image, and a
    // blank canvas would be a worse outcome than a motionless one.
    renderer.render(scene, camera);
  } else {
    running = true;
    frame = requestAnimationFrame(draw);
  }

  /** Re-tints the scene when the theme changes. */
  const setAccent = (hex: string) => material.color.set(hex);

  return {
    kind: reduced ? 'reduced-motion' : 'running',
    setAccent,
    dispose() {
      running = false;
      cancelAnimationFrame(frame);
      observer.disconnect();
      // WHY dispose the geometries and material explicitly: three.js does not free GPU buffers when
      // an object is dropped, so a theme-driven remount would leak them on every switch.
      geometry.dispose();
      ringGeometry.dispose();
      material.dispose();
      renderer.dispose();
    },
  };
}

/**
 * Reads the accent colour the active theme defines.
 *
 * WHY read from CSS rather than duplicating the palette: `index.css` owns the tokens. Reading
 * `getComputedStyle` means the scene follows every theme without a second copy of the colours.
 */
export function readAccentColor(): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  return value || '#58a6ff';
}