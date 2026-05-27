/**
 * kpi.js – KPI Overlay Manager
 *
 * Responsibilities:
 *  - Create pulsing 3D sphere markers at each KPI's world-space position
 *  - Attach CSS2D labels (rendered on top of the 3D scene)
 *  - Build and refresh the sidebar cards with sparklines
 *  - Show a detail panel with a chart when a KPI is selected
 *  - Expose helpers used by main.js (raycasting, update loop, toggleLabels)
 */

import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

export class KPIManager {
  /**
   * @param {THREE.Scene} scene
   */
  constructor(scene) {
    this.scene       = scene;
    this.markers     = []; // { kpi, mesh, css2dObj, labelDiv }
    this.labelsVisible = true;
    this._raycaster  = new THREE.Raycaster();
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Full (re-)build: markers + sidebar. */
  buildUI(kpis) {
    this.clear();
    kpis.forEach((kpi) => this._addMarker(kpi));
    this._buildSidebar(kpis);
  }

  /** Live-update values without full rebuild (preserves marker positions). */
  updateKPIs(kpis) {
    kpis.forEach((kpi) => {
      const m = this.markers.find((x) => x.kpi.id === kpi.id);
      if (m) {
        m.kpi = kpi;
        const c = this._statusHex3(kpi.status);
        m.mesh.material.color.setHex(c);
        m.mesh.material.emissive.setHex(c);
        m.labelDiv.querySelector('.kl-value').textContent = `${kpi.value} ${kpi.unit}`;
        m.labelDiv.setAttribute('data-status', kpi.status);
      }
    });
    this._buildSidebar(kpis);
  }

  /** Show / hide all 3D labels. */
  toggleLabels() {
    this.labelsVisible = !this.labelsVisible;
    this.markers.forEach(({ css2dObj }) => { css2dObj.visible = this.labelsVisible; });
  }

  /** Returns the marker meshes for raycasting in main.js. */
  getMarkerMeshes() {
    return this.markers.map((m) => m.mesh);
  }

  /**
   * Called from the renderer's click event.
   * @returns {boolean} true if a marker was hit
   */
  onPointerClick(event, camera, canvas) {
    const rect  = canvas.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width)  *  2 - 1,
      -((event.clientY - rect.top)  / rect.height) * 2 + 1,
    );
    this._raycaster.setFromCamera(mouse, camera);
    const hits = this._raycaster.intersectObjects(this.getMarkerMeshes());
    if (hits.length > 0) {
      const id = hits[0].object.userData.kpiId;
      const m  = this.markers.find((x) => x.kpi.id === id);
      if (m) { this._showDetail(m.kpi); return true; }
    }
    return false;
  }

  /** Called each frame. Animates the pulsing markers. */
  update(elapsed) {
    this.markers.forEach(({ mesh }, i) => {
      const scale = 1.0 + Math.sin(elapsed * 2.5 + i * 1.5) * 0.14;
      mesh.scale.setScalar(scale);
    });
  }

  /** Remove all markers from the scene. */
  clear() {
    this.markers.forEach(({ mesh }) => this.scene.remove(mesh));
    this.markers = [];
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  _addMarker(kpi) {
    if (!kpi.position3d) return;

    const color = this._statusHex3(kpi.status);

    // Glowing sphere
    const geo  = new THREE.SphereGeometry(0.08, 16, 16);
    const mat  = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.7,
      roughness: 0.3,
      metalness: 0.1,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(kpi.position3d.x, kpi.position3d.y, kpi.position3d.z);
    mesh.userData.kpiId = kpi.id;
    mesh.castShadow = false;
    this.scene.add(mesh);

    // CSS2D label floating above the sphere
    const div = document.createElement('div');
    div.className = 'kpi-label';
    div.setAttribute('data-status', kpi.status);
    div.innerHTML =
      `<span class="kl-name">${kpi.label}</span>` +
      `<span class="kl-value">${kpi.value} ${kpi.unit}</span>`;

    const obj = new CSS2DObject(div);
    obj.position.set(0, 0.20, 0);
    mesh.add(obj);

    this.markers.push({ kpi, mesh, css2dObj: obj, labelDiv: div });
  }

  _buildSidebar(kpis) {
    const list = document.getElementById('kpi-list');
    list.innerHTML = '';

    kpis.forEach((kpi) => {
      const card = document.createElement('div');
      card.className = 'kpi-card';
      card.setAttribute('data-status', kpi.status);
      card.innerHTML = `
        <div class="kc-header">
          <span class="kc-label">${kpi.label}</span>
          <span class="status-dot s-${kpi.status}"></span>
        </div>
        <div class="kc-value">${kpi.value} <span class="kc-unit">${kpi.unit}</span></div>
        <div class="kc-sparkline" id="sp-${kpi.id}"></div>
      `;
      card.addEventListener('click', () => this._showDetail(kpi));
      list.appendChild(card);

      if (kpi.history?.length > 1) {
        this._drawSparkline(`sp-${kpi.id}`, kpi.history, kpi.status);
      }
    });
  }

  _drawSparkline(id, data, status) {
    const el = document.getElementById(id);
    if (!el || data.length < 2) return;

    const W = 160, H = 28, P = 2;
    const lo = Math.min(...data), hi = Math.max(...data);
    const range  = hi - lo || 1;
    const scaleX = (W - P * 2) / (data.length - 1);

    const pts = data
      .map((v, i) => `${P + i * scaleX},${H - P - ((v - lo) / range) * (H - P * 2)}`)
      .join(' ');

    const c = this._statusCss(status);
    el.innerHTML =
      `<svg viewBox="0 0 ${W} ${H}">` +
      `<polyline points="${pts}" fill="none" stroke="${c}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>` +
      `</svg>`;
  }

  _showDetail(kpi) {
    const panel   = document.getElementById('detail-panel');
    const content = document.getElementById('detail-content');
    const labels  = { ok: 'Normale', warning: 'Attenzione', error: 'Critico' };

    const threshHtml = kpi.thresholds
      ? `<div class="dt-thresholds">
           ${kpi.thresholds.min !== undefined ? `<span>Min: ${kpi.thresholds.min}</span>` : ''}
           ${kpi.thresholds.max !== undefined ? `<span>Max: ${kpi.thresholds.max}</span>` : ''}
           <span>${kpi.unit}</span>
         </div>`
      : '';

    content.innerHTML = `
      <div class="dt-label">${kpi.label}</div>
      <div class="dt-value">${kpi.value}<span class="dt-unit"> ${kpi.unit}</span></div>
      <div class="dt-badge s-bg-${kpi.status}">${labels[kpi.status] ?? kpi.status}</div>
      ${threshHtml}
      <div class="dt-chart-label">Storico (ultime misurazioni)</div>
      <div id="dt-chart"></div>
    `;

    panel.classList.remove('hidden');

    if (kpi.history?.length > 1) {
      this._drawDetailChart('dt-chart', kpi.history, kpi.status);
    }

    // Ask main.js to shift the camera towards this KPI
    document.dispatchEvent(
      new CustomEvent('kpi:focus', { detail: kpi.position3d ?? null }),
    );
  }

  _drawDetailChart(id, data, status) {
    const el = document.getElementById(id);
    if (!el || data.length < 2) return;

    const W = 240, H = 80, P = 20;
    const lo = Math.min(...data), hi = Math.max(...data);
    const range  = hi - lo || 1;
    const scaleX = (W - P * 2) / (data.length - 1);

    const pts = data.map((v, i) => ({
      x: P + i * scaleX,
      y: H - P - ((v - lo) / range) * (H - P * 2),
    }));

    const line = pts.map((p) => `${p.x},${p.y}`).join(' ');
    const area = [
      `${pts[0].x},${H - P}`,
      ...pts.map((p) => `${p.x},${p.y}`),
      `${pts[pts.length - 1].x},${H - P}`,
    ].join(' ');

    const c       = this._statusCss(status);
    const dots    = pts.map((p) => `<circle cx="${p.x}" cy="${p.y}" r="3" fill="${c}"/>`).join('');
    const txtLabels = data
      .map((v, i) =>
        `<text x="${pts[i].x}" y="${H - 4}" text-anchor="middle" font-size="9" fill="#484f58">${v}</text>`,
      )
      .join('');

    el.innerHTML =
      `<svg viewBox="0 0 ${W} ${H}" width="100%">` +
      `<polygon points="${area}" fill="${c}" opacity="0.12"/>` +
      `<polyline points="${line}" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>` +
      dots + txtLabels +
      `</svg>`;
  }

  // ── Colour helpers ──────────────────────────────────────────────────────────

  /** Three.js hex number for a status string. */
  _statusHex3(status) {
    return { ok: 0x22c55e, warning: 0xf59e0b, error: 0xef4444 }[status] ?? 0x6366f1;
  }

  /** CSS colour string for SVG / DOM elements. */
  _statusCss(status) {
    return { ok: '#22c55e', warning: '#f59e0b', error: '#ef4444' }[status] ?? '#6366f1';
  }
}
