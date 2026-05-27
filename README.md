# Digital Twin – 3D Room Dashboard

Visualizzazione interattiva di una stanza 3D con KPI e dashboard in tempo reale, costruita con [Three.js](https://threejs.org/).

## Struttura del progetto

```
digital_twin/
├── index.html                  # Pagina principale
├── css/
│   └── style.css               # Tema dark UI
├── js/
│   ├── main.js                 # Setup scena Three.js, caricamento GLB, loop di render
│   ├── kpi.js                  # Gestione marker 3D, labels CSS2D, pannello dettaglio
│   └── data.js                 # Caricamento e gestione dati KPI
└── assets/
    ├── data/
    │   └── kpi-data.json       # Dati KPI (modificabili / sostituibili con API)
    └── models/
        └── room.glb            # ← inserisci qui il tuo modello Blender
```

## Come aggiungere il modello Blender

1. In Blender: **File → Export → glTF 2.0 (.glb)**
2. Salva il file come `assets/models/room.glb`
3. Ricarica la pagina

> Se il file GLB non è presente viene mostrata automaticamente una stanza di default.

## Come avviare

Il progetto usa ES Modules con import map, quindi **non può essere aperto come file locale** (`file://`).  
Serve un server HTTP. Opzioni rapide:

```bash
# Python (built-in)
python -m http.server 3000

# Node.js (npx, nessuna installazione)
npx serve . -p 3000

# VS Code: installa l'estensione "Live Server" e clicca "Go Live"
```

Poi apri `http://localhost:3000` nel browser.

## Personalizzare i KPI

Modifica `assets/data/kpi-data.json`. Ogni KPI ha questi campi:

| Campo         | Tipo     | Descrizione                                         |
|---------------|----------|-----------------------------------------------------|
| `id`          | string   | Identificatore univoco                              |
| `label`       | string   | Nome visualizzato                                   |
| `value`       | number   | Valore attuale                                      |
| `unit`        | string   | Unità di misura                                     |
| `status`      | string   | `"ok"` · `"warning"` · `"error"`                   |
| `thresholds`  | object   | `{ min?, max? }` – soglie opzionali                 |
| `position3d`  | object   | `{ x, y, z }` – posizione del marker nella scena   |
| `history`     | number[] | Ultimi valori per il grafico sparkline              |

Per collegare un'API reale, modifica la costante `DATA_URL` in `js/data.js`.

## Interazione 3D

| Azione              | Comportamento         |
|---------------------|-----------------------|
| Trascina (sx)       | Ruota la camera       |
| Scroll              | Zoom                  |
| Trascina (dx)       | Trasla la camera      |
| Click su marker 🔵  | Apre il pannello KPI  |
| Click su card sidebar | Apre il pannello KPI |
| Pulsante ↻ Aggiorna | Ricarica i dati       |
| Pulsante ◉ Labels   | Mostra/nasconde label |
