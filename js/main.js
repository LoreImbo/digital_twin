/**
 * main.js – Digital Twin 3D Scene
 *
 * - Initialises Three.js WebGL renderer + CSS2D overlay renderer
 * - Loads the Blender GLB model (falls back to a built-in room if not found)
 * - Sets up lighting, OrbitControls and the render loop
 * - Wires DataManager and KPIManager together
 */

import * as THREE from 'three';
import { OrbitControls }  from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader }     from 'three/addons/loaders/GLTFLoader.js';
import { CSS2DRenderer }  from 'three/addons/renderers/CSS2DRenderer.js';
import { DataManager }    from './data.js';
import { KPIManager }     from './kpi.js';

const MODEL_PATH = './assets/models/room.glb';

// ── DOM ───────────────────────────────────────────────────────────────────────
const canvas   = document.getElementById('canvas');
const viewport = document.getElementById('viewport');

// ── Scene ─────────────────────────────────────────────────────────────────────
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d1117);
scene.fog = new THREE.FogExp2(0x0d1117, 0.03);

// ── Camera ────────────────────────────────────────────────────────────────────
const camera = new THREE.PerspectiveCamera(55, 1, 0.05, 200);
camera.position.set(6, 4, 6);

// ── WebGL Renderer ────────────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: 'high-performance',
});
renderer.shadowMap.enabled = true;
renderer.shadowMap.type    = THREE.PCFSoftShadowMap;
renderer.outputColorSpace  = THREE.SRGBColorSpace;
renderer.toneMapping       = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.2;

// ── CSS2D Renderer (for 3D-anchored KPI labels) ───────────────────────────────
const css2d = new CSS2DRenderer();
Object.assign(css2d.domElement.style, {
  position: 'absolute', top: '0', left: '0',
  width: '100%', height: '100%',
  pointerEvents: 'none',
});
viewport.appendChild(css2d.domElement);

// ── OrbitControls ─────────────────────────────────────────────────────────────
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping   = true;
controls.dampingFactor   = 0.07;
controls.minDistance     = 1.5;
controls.maxDistance     = 25;
controls.maxPolarAngle   = Math.PI / 2 + 0.1;
controls.target.set(0, 1, 0);

// ── Lighting ──────────────────────────────────────────────────────────────────
function setupLighting() {
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));

  const sun = new THREE.DirectionalLight(0xfff4e0, 2.0);
  sun.position.set(5, 8, 4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near   = 0.1;
  sun.shadow.camera.far    = 30;
  sun.shadow.camera.left   = sun.shadow.camera.bottom = -8;
  sun.shadow.camera.right  = sun.shadow.camera.top    =  8;
  sun.shadow.bias = -0.001;
  scene.add(sun);

  const fill = new THREE.DirectionalLight(0x4080ff, 0.4);
  fill.position.set(-4, 3, -4);
  scene.add(fill);

  const ceiling = new THREE.PointLight(0xffeedd, 1.5, 12);
  ceiling.position.set(0, 3.5, 0);
  ceiling.castShadow = true;
  scene.add(ceiling);
}

// ── Fallback room (shown when room.glb is not present) ────────────────────────
function buildFallbackRoom() {
  const W = 8, H = 4, D = 8;

  // Floor
  const floorMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.9 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // Walls
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x263347, roughness: 0.95 });
  [
    { size: [W, H], pos: [0,    H / 2, -D / 2], ry: 0 },
    { size: [W, H], pos: [0,    H / 2,  D / 2], ry: Math.PI },
    { size: [D, H], pos: [-W / 2, H / 2, 0],    ry:  Math.PI / 2 },
    { size: [D, H], pos: [ W / 2, H / 2, 0],    ry: -Math.PI / 2 },
  ].forEach(({ size, pos, ry }) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(...size), wallMat);
    m.position.set(...pos);
    m.rotation.y = ry;
    m.receiveShadow = true;
    scene.add(m);
  });

  // Ceiling
  const ceilMat = new THREE.MeshStandardMaterial({ color: 0x1a2435, roughness: 0.9 });
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(W, D), ceilMat);
  ceil.rotation.x = Math.PI / 2;
  ceil.position.y = H;
  scene.add(ceil);

  // Floor grid
  const grid = new THREE.GridHelper(W, 8, 0x334155, 0x263347);
  grid.position.y = 0.002;
  scene.add(grid);

  // Desk
  const woodMat = new THREE.MeshStandardMaterial({ color: 0x5a3e2b, roughness: 0.8 });
  const desk = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.05, 0.8), woodMat);
  desk.position.set(1.5, 0.75, -2.0);
  desk.castShadow = true;
  desk.receiveShadow = true;
  scene.add(desk);

  [[-0.8, 0.3], [0.8, 0.3], [-0.8, -0.3], [0.8, -0.3]].forEach(([dx, dz]) => {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.74, 0.06), woodMat);
    leg.position.set(1.5 + dx, 0.37, -2.0 + dz);
    leg.castShadow = true;
    scene.add(leg);
  });

  // Chair
  const chairMat = new THREE.MeshStandardMaterial({ color: 0x1e3a5f, roughness: 0.7 });
  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.05, 0.5), chairMat);
  seat.position.set(1.5, 0.45, -1.1);
  seat.castShadow = true;
  scene.add(seat);

  const back = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.04), chairMat);
  back.position.set(1.5, 0.70, -1.35);
  back.castShadow = true;
  scene.add(back);

  // Monitor
  const monMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.3, metalness: 0.8 });
  const monitor = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.4, 0.03), monMat);
  monitor.position.set(1.5, 1.15, -2.2);
  monitor.castShadow = true;
  scene.add(monitor);

  const screenMat = new THREE.MeshStandardMaterial({
    color: 0x1d4ed8, emissive: 0x1d4ed8, emissiveIntensity: 0.4,
  });
  const screenFace = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.35), screenMat);
  screenFace.position.set(1.5, 1.15, -2.185);
  scene.add(screenFace);
}

// ── Load GLB model ────────────────────────────────────────────────────────────
async function loadScene() {
  const loadingText = document.getElementById('loading-text');
  const loader      = new GLTFLoader();

  try {
    const gltf = await loader.loadAsync(MODEL_PATH, (xhr) => {
      if (xhr.total) {
        const pct = Math.round((xhr.loaded / xhr.total) * 100);
        loadingText.textContent = `Caricamento modello… ${pct}%`;
      }
    });

    const model = gltf.scene;
    model.traverse((child) => {
      if (child.isMesh) {
        child.castShadow    = true;
        child.receiveShadow = true;
      }
    });
    scene.add(model);

    // Auto-fit camera to the loaded model
    const box    = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    const size   = box.getSize(new THREE.Vector3());
    const d      = Math.max(size.x, size.y, size.z);
    controls.target.copy(center);
    camera.position.set(
      center.x + d * 0.9,
      center.y + d * 0.7,
      center.z + d * 0.9,
    );
    controls.update();

    return 'glb';
  } catch (err) {
    console.warn('[DigitalTwin] room.glb not found – using built-in fallback room.');
    console.info('[DigitalTwin] To use your Blender model:');
    console.info('[DigitalTwin]   1. File → Export → glTF 2.0 (.glb)');
    console.info('[DigitalTwin]   2. Save as: assets/models/room.glb');
    console.info('[DigitalTwin]   3. Refresh the page');
    loadingText.textContent = 'Caricamento stanza di default…';
    buildFallbackRoom();
    return 'fallback';
  }
}

// ── Managers ──────────────────────────────────────────────────────────────────
const dataMgr = new DataManager();
const kpiMgr  = new KPIManager(scene);

// ── Resize ────────────────────────────────────────────────────────────────────
function onResize() {
  const w = viewport.clientWidth;
  const h = viewport.clientHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  css2d.setSize(w, h);
}

// ── Hover cursor ──────────────────────────────────────────────────────────────
const _raycaster = new THREE.Raycaster();
const _pointer   = new THREE.Vector2();

renderer.domElement.addEventListener('pointermove', (e) => {
  const rect = canvas.getBoundingClientRect();
  _pointer.set(
    ((e.clientX - rect.left) / rect.width)  *  2 - 1,
    -((e.clientY - rect.top)  / rect.height) * 2 + 1,
  );
  _raycaster.setFromCamera(_pointer, camera);
  const hit = _raycaster.intersectObjects(kpiMgr.getMarkerMeshes()).length > 0;
  canvas.style.cursor = hit ? 'pointer' : 'grab';
});

// ── Initialise ────────────────────────────────────────────────────────────────
async function init() {
  setupLighting();
  onResize();
  window.addEventListener('resize', onResize);

  const [, kpiData] = await Promise.all([
    loadScene(),
    dataMgr.load().catch((err) => {
      console.error('[DigitalTwin] KPI data load failed:', err);
      return null;
    }),
  ]);

  if (kpiData) {
    document.getElementById('room-name').textContent = dataMgr.getRoomName();
    kpiMgr.buildUI(dataMgr.getKPIs());
  }

  // Registra listener per aggiornamenti SSE / refresh manuale
  dataMgr.onUpdate((data) => {
    if (data?.kpis) kpiMgr.updateKPIs(data.kpis);
  });

  // Avvia Server-Sent Events se il Python server è disponibile
  dataMgr.startSSE();

  // Indica in console se i dati arrivano da Azure o dal file statico
  console.info(
    dataMgr.isLive()
      ? '[DigitalTwin] Modalità LIVE – aggiornamenti real-time via SSE.'
      : '[DigitalTwin] Modalità STATICA – avvia server.py per dati real-time.',
  );

  // Fade out loading overlay
  const overlay = document.getElementById('loading-overlay');
  overlay.style.transition = 'opacity .5s';
  overlay.style.opacity    = '0';
  setTimeout(() => { overlay.style.display = 'none'; }, 500);

  // Buttons
  document.getElementById('btn-refresh').addEventListener('click', async () => {
    const data = await dataMgr.refresh();
    kpiMgr.updateKPIs(data.kpis);
  });

  document.getElementById('btn-toggle-labels').addEventListener('click', () => {
    kpiMgr.toggleLabels();
  });

  document.getElementById('detail-close').addEventListener('click', () => {
    document.getElementById('detail-panel').classList.add('hidden');
  });

  // Click on 3D KPI markers
  renderer.domElement.addEventListener('click', (e) => {
    kpiMgr.onPointerClick(e, camera, canvas);
  });

  // Camera focus when user clicks a KPI (dispatched from KPIManager)
  document.addEventListener('kpi:focus', (e) => {
    if (!e.detail) return;
    const { x, y, z } = e.detail;
    controls.target.lerp(new THREE.Vector3(x, y, z), 0.6);
    controls.update();
  });

  animate();
}

// ── Render loop ───────────────────────────────────────────────────────────────
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const elapsed = clock.getElapsedTime();
  controls.update();
  kpiMgr.update(elapsed);
  renderer.render(scene, camera);
  css2d.render(scene, camera);
}

init();
