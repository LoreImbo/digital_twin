/**
 * data.js – KPI Data Manager
 *
 * Loads kpi-data.json and exposes reactive helpers.
 * To plug in a real backend, replace DATA_URL with your API endpoint.
 */

const DATA_URL = './assets/data/kpi-data.json';

export class DataManager {
  constructor() {
    this._data     = null;
    this._listeners = [];
  }

  /**
   * Fetch and store KPI data. Returns the parsed object.
   * @throws on network / parse errors
   */
  async load() {
    const res = await fetch(DATA_URL);
    if (!res.ok) throw new Error(`[DataManager] HTTP ${res.status} fetching ${DATA_URL}`);
    this._data = await res.json();
    return this._data;
  }

  /**
   * Re-fetch and notify all registered listeners.
   */
  async refresh() {
    await this.load();
    this._listeners.forEach((fn) => fn(this._data));
    return this._data;
  }

  /**
   * Register a callback to be called after each refresh().
   * @param {(data: object) => void} fn
   */
  onUpdate(fn) {
    this._listeners.push(fn);
  }

  /** Returns the full list of KPI objects. */
  getKPIs() {
    return this._data?.kpis ?? [];
  }

  /** Returns a single KPI by id, or undefined. */
  getKPI(id) {
    return this._data?.kpis?.find((k) => k.id === id);
  }

  /** Returns the room display name. */
  getRoomName() {
    return this._data?.room ?? 'Room';
  }

  /** Returns the ISO timestamp of the last data update (if present). */
  getLastUpdated() {
    return this._data?.lastUpdated ?? null;
  }
}
