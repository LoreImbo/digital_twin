"""
azure_connector.py – Bridge Azure IoT Hub / Azure Digital Twins → Digital Twin Web App
========================================================================================

Flusso dati supportato:

  [Sensore fisico]
       ↓
  [Azure IoT Hub]  ──(EventHub endpoint)──▶  _iothub_loop()
       ↓ (tramite IoT Hub routing / Function)
  [Azure Digital Twins]  ◀─────────────────  _adt_loop()
       ↓ (poll ogni ADT_POLL_INTERVAL secondi)
  [AzureConnector._state]
       ↓  (callback → server.py → SSE → browser)
  [Three.js dashboard]

Priorità rilevamento automatico:
  1. IOTHUB_EVENTHUB_CONNECTION_STRING  →  IoT Hub EventHub endpoint (real-time)
  2. ADT_INSTANCE_URL                  →  Azure Digital Twins      (polling)
  3. nessuno                           →  dati statici da kpi-data.json

Configurazione tramite file .env (vedi .env.example).
"""

import os
import json
import threading
import time
from pathlib import Path

# ── Import opzionali Azure SDK ────────────────────────────────────────────────
try:
    from azure.eventhub import EventHubConsumerClient
    _EVENTHUB_OK = True
except ImportError:
    _EVENTHUB_OK = False

try:
    from azure.digitaltwins.core import DigitalTwinsClient
    from azure.identity import DefaultAzureCredential, ClientSecretCredential
    _ADT_OK = True
except ImportError:
    _ADT_OK = False

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass  # python-dotenv non installato; usa variabili d'ambiente di sistema

# ── Costanti ──────────────────────────────────────────────────────────────────
_STATIC_PATH   = Path(__file__).parent / 'assets' / 'data' / 'kpi-data.json'
_SENSOR_MAP    = Path(__file__).parent / 'assets' / 'data' / 'sensor-map.json'
ADT_POLL_SEC   = float(os.getenv('ADT_POLL_INTERVAL', '10'))


class AzureConnector:
    """
    Mantiene lo stato in memoria dei KPI e lo aggiorna in real-time
    da Azure IoT Hub o Azure Digital Twins.
    """

    def __init__(self):
        self._state: dict    = {}   # { kpi_id: kpi_dict }
        self._room_name: str = 'Room'
        self._lock           = threading.Lock()
        self._subscribers    = []   # callback(kpis: list) registrati da server.py
        self._sensor_map_cache: dict | None = None

        # Stato iniziale dal file statico (rimpiazzato quando arrivano dati Azure)
        self._load_static()

    # ── API pubblica ──────────────────────────────────────────────────────────

    def start(self):
        """Rileva le credenziali disponibili e avvia il worker appropriato."""
        mode = self._detect_mode()
        labels = {
            'iothub': 'Azure IoT Hub  (real-time EventHub)',
            'adt':    f'Azure Digital Twins  (poll ogni {ADT_POLL_SEC}s)',
            'static': 'dati statici kpi-data.json  (nessuna credenziale Azure)',
        }
        print(f"  [Azure] Sorgente dati: {labels[mode]}")

        if mode == 'iothub':
            threading.Thread(target=self._iothub_loop, daemon=True).start()
        elif mode == 'adt':
            threading.Thread(target=self._adt_loop, daemon=True).start()

    def get_kpis(self) -> list:
        with self._lock:
            return list(self._state.values())

    def get_room_name(self) -> str:
        with self._lock:
            return self._room_name

    def on_update(self, callback):
        """Registra un callback chiamato ogni volta che i dati cambiano."""
        self._subscribers.append(callback)

    # ── Caricamento statico ───────────────────────────────────────────────────

    def _load_static(self):
        try:
            data = json.loads(_STATIC_PATH.read_text(encoding='utf-8'))
            with self._lock:
                self._room_name = data.get('room', 'Room')
                self._state     = {k['id']: k for k in data.get('kpis', [])}
        except Exception as exc:
            print(f"  [Azure] Fallback statico non disponibile: {exc}")

    # ── Notifica subscriber ───────────────────────────────────────────────────

    def _notify(self):
        kpis = self.get_kpis()
        for cb in list(self._subscribers):
            try:
                cb(kpis)
            except Exception:
                pass

    # ── Rilevamento modalità ──────────────────────────────────────────────────

    def _detect_mode(self) -> str:
        if _EVENTHUB_OK and os.getenv('IOTHUB_EVENTHUB_CONNECTION_STRING'):
            return 'iothub'
        if _ADT_OK and os.getenv('ADT_INSTANCE_URL'):
            return 'adt'
        return 'static'

    # ── IoT Hub (EventHub-compatible endpoint) ────────────────────────────────

    def _iothub_loop(self):
        conn_str       = os.getenv('IOTHUB_EVENTHUB_CONNECTION_STRING')
        consumer_group = os.getenv('IOTHUB_CONSUMER_GROUP', '$Default')

        while True:
            try:
                print('  [IoT Hub] Connessione in corso…')
                client = EventHubConsumerClient.from_connection_string(
                    conn_str, consumer_group=consumer_group,
                )
                with client:
                    print('  [IoT Hub] Connesso ✓  In ascolto telemetria…')
                    client.receive(
                        on_event=self._on_iothub_event,
                        starting_position='-1',   # leggi solo eventi nuovi
                    )
            except Exception as exc:
                print(f'  [IoT Hub] Connessione persa: {exc}  – riprovo in 10s')
                time.sleep(10)

    def _on_iothub_event(self, partition_ctx, event):
        try:
            payload   = json.loads(event.body_as_str())
            props     = event.system_properties or {}
            device_id = props.get(b'iothub-connection-device-id', b'').decode()
            self._apply_telemetry(device_id, payload)
            partition_ctx.update_checkpoint(event)
        except Exception as exc:
            print(f'  [IoT Hub] Parse error: {exc}')

    def _apply_telemetry(self, device_id: str, payload: dict):
        """
        Mappa le proprietà del payload IoT Hub ai KPI tramite sensor-map.json.
        Esempio payload: {"temperature": 22.5, "humidity": 60, "co2": 410}
        """
        mapping = self._load_sensor_map()
        updated = False

        for prop, raw_value in payload.items():
            # Cerca prima "deviceId.property", poi solo "property"
            kpi_id = mapping.get(f'{device_id}.{prop}') or mapping.get(prop)
            if not kpi_id:
                continue
            try:
                value = round(float(raw_value), 2)
            except (TypeError, ValueError):
                continue

            with self._lock:
                if kpi_id in self._state:
                    kpi            = dict(self._state[kpi_id])
                    kpi['value']   = value
                    kpi['status']  = self._compute_status(kpi)
                    hist           = list(kpi.get('history', []))
                    hist.append(value)
                    kpi['history'] = hist[-7:]
                    self._state[kpi_id] = kpi
                    updated = True

        if updated:
            self._notify()

    # ── Azure Digital Twins ───────────────────────────────────────────────────

    def _adt_loop(self):
        url = os.getenv('ADT_INSTANCE_URL')
        while True:
            try:
                print(f'  [ADT] Connessione a {url} …')
                cred   = self._build_adt_credential()
                client = DigitalTwinsClient(url, cred)
                print(f'  [ADT] Connesso ✓  Poll ogni {ADT_POLL_SEC}s')
                while True:
                    self._poll_adt(client)
                    time.sleep(ADT_POLL_SEC)
            except Exception as exc:
                print(f'  [ADT] Errore: {exc}  – riprovo in 15s')
                time.sleep(15)

    def _poll_adt(self, client: 'DigitalTwinsClient'):
        """
        Esegue la query ADT configurata e aggiorna lo stato.
        La query è configurabile tramite ADT_QUERY nel .env.
        Default: legge tutti i twin che hanno la proprietà "value".
        """
        query = os.getenv(
            'ADT_QUERY',
            "SELECT * FROM DIGITALTWINS WHERE IS_DEFINED(value)",
        )
        try:
            updated = False
            for twin in client.query_twins(query):
                # Il $dtId del twin viene usato come kpi_id (case-insensitive)
                kpi_id = twin.get('$dtId', '').lower().replace('-', '_')
                if kpi_id not in self._state:
                    continue
                # Cerca il valore in campi comuni – adatta al tuo modello ADT
                for field in ('value', 'Value', 'currentValue', 'telemetry'):
                    if field in twin:
                        try:
                            value = round(float(twin[field]), 2)
                        except (TypeError, ValueError):
                            break
                        with self._lock:
                            kpi           = dict(self._state[kpi_id])
                            kpi['value']  = value
                            kpi['status'] = self._compute_status(kpi)
                            hist          = list(kpi.get('history', []))
                            hist.append(value)
                            kpi['history'] = hist[-7:]
                            self._state[kpi_id] = kpi
                        updated = True
                        break
            if updated:
                self._notify()
        except Exception as exc:
            print(f'  [ADT] Query error: {exc}')

    def _build_adt_credential(self):
        cid = os.getenv('AZURE_CLIENT_ID')
        cs  = os.getenv('AZURE_CLIENT_SECRET')
        tid = os.getenv('AZURE_TENANT_ID')
        if cid and cs and tid:
            return ClientSecretCredential(tid, cid, cs)
        return DefaultAzureCredential()

    # ── Helper: calcola status da soglie ──────────────────────────────────────

    def _compute_status(self, kpi: dict) -> str:
        t = kpi.get('thresholds', {})
        v = kpi.get('value')
        if v is None:
            return kpi.get('status', 'ok')
        if t.get('max') is not None and v > t['max']:
            return 'error' if v > t['max'] * 1.15 else 'warning'
        if t.get('min') is not None and v < t['min']:
            return 'warning'
        return 'ok'

    # ── Helper: carica sensor-map ─────────────────────────────────────────────

    def _load_sensor_map(self) -> dict:
        if self._sensor_map_cache is not None:
            return self._sensor_map_cache

        # Priorità 1: variabile d'ambiente (JSON inline)
        raw = os.getenv('SENSOR_MAP_JSON')
        if raw:
            try:
                self._sensor_map_cache = json.loads(raw)
                return self._sensor_map_cache
            except Exception:
                pass

        # Priorità 2: file assets/data/sensor-map.json
        if _SENSOR_MAP.exists():
            try:
                self._sensor_map_cache = json.loads(_SENSOR_MAP.read_text())
                return self._sensor_map_cache
            except Exception:
                pass

        self._sensor_map_cache = {}
        return self._sensor_map_cache
