/**
 * data.js – KPI Data Manager
 *
 * Strategia di caricamento (priorità):
 *   1. GET /api/kpis          – Python server con Azure connector (real-time)
 *   2. ./assets/data/kpi-data.json – file statico (GitHub Pages / offline)
 *
 * Aggiornamenti in tempo reale:
 *   - Quando /api/kpis risponde, attiva automaticamente Server-Sent Events
 *     su /api/events → i KPI si aggiornano senza ricaricare la pagina.
 */

const API_URL    = '/api/kpis';
const STATIC_URL = './assets/data/kpi-data.json';
const SSE_URL    = '/api/events';

export class DataManager {
  constructor() {
    this._data      = null;
    this._listeners = [];
    this._sse       = null;   // EventSource attivo
    this._useApi    = false;  // true quando il Python server è disponibile
  }

  // ── Caricamento iniziale ───────────────────────────────────────────────────

  async load() {
    // Prova l'endpoint Python; se non risponde usa il JSON statico
    try {
      const res = await fetch(API_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this._data   = await res.json();
      this._useApi = true;
    } catch {
      const res = await fetch(STATIC_URL);
      if (!res.ok) throw new Error(`[DataManager] HTTP ${res.status} – ${STATIC_URL}`);
      this._data   = await res.json();
      this._useApi = false;
    }
    return this._data;
  }

  // ── Polling manuale (pulsante "Aggiorna") ──────────────────────────────────

  async refresh() {
    await this.load();
    this._notify();
    return this._data;
  }

  // ── Server-Sent Events (aggiornamenti real-time da Azure) ─────────────────

  /** Avvia la ricezione SSE. Chiamato da main.js dopo load(). */
  startSSE() {
    if (!this._useApi || !window.EventSource || this._sse) return;

    this._sse = new EventSource(SSE_URL);

    this._sse.onopen = () => {
      console.info('[DataManager] SSE connesso – aggiornamenti real-time attivi.');
    };

    this._sse.onmessage = (e) => {
      try {
        const kpis = JSON.parse(e.data);
        if (this._data) this._data.kpis = kpis;
        this._notify();
      } catch (err) {
        console.warn('[DataManager] SSE parse error:', err);
      }
    };

    this._sse.onerror = () => {
      // Il browser riprova automaticamente; nessuna azione necessaria
    };
  }

  /** Chiude la connessione SSE (opzionale – chiamato in cleanup). */
  stopSSE() {
    this._sse?.close();
    this._sse = null;
  }

  // ── Listener ──────────────────────────────────────────────────────────────

  onUpdate(fn) {
    this._listeners.push(fn);
  }

  // ── Getter ────────────────────────────────────────────────────────────────

  getKPIs()        { return this._data?.kpis         ?? []; }
  getKPI(id)       { return this._data?.kpis?.find((k) => k.id === id); }
  getRoomName()    { return this._data?.room          ?? 'Room'; }
  getLastUpdated() { return this._data?.lastUpdated   ?? null; }
  isLive()         { return this._useApi; }   // true = connesso al Python server

  // ── Privato ───────────────────────────────────────────────────────────────

  _notify() {
    this._listeners.forEach((fn) => fn(this._data));
  }
}
