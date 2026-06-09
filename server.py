#!/usr/bin/env python3
"""
server.py – Digital Twin Dev Server
====================================
Avvia un server HTTP locale, apre automaticamente il browser
e stampa un log colorato di tutte le richieste.

Utilizzo:
    python server.py            # porta 3000 (default)
    python server.py 8080       # porta personalizzata
    python server.py --watch    # abilita file-watcher (ricarica automatica)
"""

import http.server
import socketserver
import webbrowser
import sys
import os
import threading
import time
import hashlib
import json
import queue
from datetime import datetime, timezone
from pathlib import Path

# ── Azure connector (opzionale – graceful fallback se non configurato) ─────────
try:
    from azure_connector import AzureConnector
    connector = AzureConnector()
except ImportError:
    connector = None

# Lista delle code SSE attive (una per ogni client connesso a /api/events)
_sse_clients: list[queue.Queue] = []

# ── Configurazione ────────────────────────────────────────────────────────────

DEFAULT_PORT  = 3000
WATCH_EXTS    = {'.html', '.css', '.js', '.json', '.glb'}
WATCH_INTERVAL = 1.0   # secondi tra un check e l'altro

# ── ANSI colours (funzionano su Windows 10+ e tutti i terminali Unix) ─────────

def _ansi(code): return f'\033[{code}m'

class C:
    RESET  = _ansi(0)
    BOLD   = _ansi(1)
    DIM    = _ansi(2)
    CYAN   = _ansi(96)
    GREEN  = _ansi(92)
    YELLOW = _ansi(93)
    RED    = _ansi(91)
    BLUE   = _ansi(94)
    MAGENTA = _ansi(95)

def _enable_windows_ansi():
    """Abilita i codici ANSI su Windows (solo se necessario)."""
    if sys.platform == 'win32':
        try:
            import ctypes
            kernel32 = ctypes.windll.kernel32
            kernel32.SetConsoleMode(kernel32.GetStdHandle(-11), 7)
        except Exception:
            pass

# ── Handler HTTP ──────────────────────────────────────────────────────────────

class ThreadedHTTPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    """Server multi-thread: necessario per tenere aperte le connessioni SSE."""
    allow_reuse_address = True
    daemon_threads      = True


class DigitalTwinHandler(http.server.SimpleHTTPRequestHandler):

    # ── Routing ──────────────────────────────────────────────────────────────

    def do_GET(self):
        if self.path == '/api/kpis':
            self._handle_kpis()
        elif self.path == '/api/events':
            self._handle_sse()
        else:
            super().do_GET()

    # ── /api/kpis  → snapshot JSON attuale ───────────────────────────────────

    def _handle_kpis(self):
        kpis = connector.get_kpis() if connector else []
        body = json.dumps({
            'room':        connector.get_room_name() if connector else 'Room',
            'lastUpdated': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
            'kpis':        kpis,
        }).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # ── /api/events → Server-Sent Events (stream real-time) ──────────────────

    def _handle_sse(self):
        self.send_response(200)
        self.send_header('Content-Type',  'text/event-stream')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Connection',    'keep-alive')
        self.end_headers()

        q = queue.Queue(maxsize=20)
        _sse_clients.append(q)

        # Invia subito lo stato corrente al client appena connesso
        if connector:
            self._sse_write(q, json.dumps(connector.get_kpis()))

        try:
            while True:
                try:
                    data = q.get(timeout=25)          # attendi aggiornamento
                    self.wfile.write(f'data: {data}\n\n'.encode())
                    self.wfile.flush()
                except queue.Empty:
                    self.wfile.write(b': heartbeat\n\n')  # mantieni viva la conn.
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            _sse_clients.remove(q)

    @staticmethod
    def _sse_write(q: queue.Queue, data: str):
        try:
            q.put_nowait(data)
        except queue.Full:
            pass

    def log_message(self, fmt, *args):
        code   = str(args[1]) if len(args) > 1 else '-'
        path   = str(args[0]).split('"')[1] if '"' in str(args[0]) else str(args[0])
        ts     = datetime.now().strftime('%H:%M:%S')

        if code.startswith('2'):
            col = C.GREEN
        elif code.startswith('3'):
            col = C.CYAN
        elif code.startswith('4'):
            col = C.YELLOW
        else:
            col = C.RED

        # Evidenzia le risorse principali del progetto
        highlight = ''
        for token in ('.glb', 'kpi-data.json', 'main.js', 'kpi.js', 'data.js'):
            if token in path:
                highlight = f' {C.MAGENTA}◀ {token}{C.RESET}'
                break

        print(f"  {C.DIM}[{ts}]{C.RESET}  {col}{C.BOLD}{code}{C.RESET}  {C.DIM}{path}{C.RESET}{highlight}")

    def end_headers(self):
        # CORS + no-cache: utile per lo sviluppo
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        super().end_headers()

    def log_error(self, fmt, *args):
        ts = datetime.now().strftime('%H:%M:%S')
        print(f"  {C.DIM}[{ts}]{C.RESET}  {C.RED}ERR{C.RESET}  {fmt % args}")

# ── File watcher ──────────────────────────────────────────────────────────────

def _file_hash(path: Path) -> str:
    """Restituisce l'MD5 del contenuto di un file."""
    try:
        return hashlib.md5(path.read_bytes()).hexdigest()
    except OSError:
        return ''

def _scan(root: Path) -> dict:
    """Scansiona tutti i file con estensioni monitorate."""
    state = {}
    for ext in WATCH_EXTS:
        for p in root.rglob(f'*{ext}'):
            state[str(p)] = _file_hash(p)
    return state

def watch_files(root: Path):
    """Loop che stampa un avviso ogni volta che un file cambia."""
    print(f"\n  {C.CYAN}👁  File-watcher attivo{C.RESET} – monitorando: {', '.join(WATCH_EXTS)}\n")
    prev = _scan(root)

    while True:
        time.sleep(WATCH_INTERVAL)
        curr = _scan(root)
        ts = datetime.now().strftime('%H:%M:%S')

        for path, h in curr.items():
            name = Path(path).name
            if path not in prev:
                print(f"  {C.DIM}[{ts}]{C.RESET}  {C.GREEN}+  Nuovo file:{C.RESET}  {name}")
            elif prev[path] != h:
                print(f"  {C.DIM}[{ts}]{C.RESET}  {C.YELLOW}~  Modificato:{C.RESET}  {name}  →  ricarica il browser")

        for path in prev:
            if path not in curr:
                name = Path(path).name
                print(f"  {C.DIM}[{ts}]{C.RESET}  {C.RED}−  Rimosso:  {C.RESET}  {name}")

        prev = curr

# ── SSE broadcast ───────────────────────────────────────────────────────────────

def _broadcast_kpis(kpis: list):
    """Invia i dati aggiornati a tutti i client SSE connessi."""
    data = json.dumps(kpis)
    for q in list(_sse_clients):
        try:
            q.put_nowait(data)
        except queue.Full:
            pass

# ── Banner ────────────────────────────────────────────────────────────────────

def print_banner(port: int, watch: bool):
    line = '─' * 44
    print()
    print(f"  {C.BOLD}{C.CYAN}◈  Digital Twin – Dev Server{C.RESET}")
    print(f"  {line}")
    print(f"  {C.GREEN}▶  {C.BOLD}http://localhost:{port}{C.RESET}")
    print(f"  {C.DIM}Directory : {os.getcwd()}{C.RESET}")
    print(f"  {C.DIM}File watch: {'attivo' if watch else 'disattivo  (usa --watch per abilitarlo)'}{C.RESET}")
    print(f"  {C.DIM}Stop      : Ctrl+C{C.RESET}")
    print(f"  {line}")
    print()
    print(f"  {'Ora':8}  {'Codice':6}  Richiesta")
    print(f"  {'─'*8}  {'─'*6}  {'─'*30}")

# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    _enable_windows_ansi()

    args  = sys.argv[1:]
    watch = '--watch' in args
    ports = [a for a in args if a.isdigit()]
    port  = int(ports[0]) if ports else DEFAULT_PORT

    # Lavora sempre dalla cartella del progetto
    root = Path(__file__).parent.resolve()
    os.chdir(root)

    print_banner(port, watch)

    # Apri il browser dopo un breve ritardo
    def _open_browser():
        time.sleep(0.8)
        webbrowser.open(f'http://localhost:{port}')
    threading.Thread(target=_open_browser, daemon=True).start()

    # Avvia il file-watcher in background (opzionale)
    if watch:
        threading.Thread(target=watch_files, args=(root,), daemon=True).start()

    # Avvia Azure connector in background
    if connector:
        connector.on_update(_broadcast_kpis)
        connector.start()

    try:
        with ThreadedHTTPServer(('', port), DigitalTwinHandler) as httpd:
            httpd.serve_forever()
    except OSError as e:
        if 'address already in use' in str(e).lower() or e.errno in (98, 10048):
            print(f"\n  {C.RED}✗  Porta {port} già in uso.{C.RESET}")
            print(f"  {C.DIM}Prova: python server.py {port + 1}{C.RESET}\n")
            sys.exit(1)
        raise
    except KeyboardInterrupt:
        print(f"\n\n  {C.YELLOW}Server fermato.{C.RESET}\n")

if __name__ == '__main__':
    main()
