# KONTEXTLOS

Party-Spiel für 3–8 Leute im Browser. Sag was Harmloses — die anderen machen's schlimm.
Design & Art Direction: siehe [DESIGN.md](DESIGN.md).

```
game/     Godot 4.7 – der große Bildschirm (Host, gesamte Spiellogik)
server/   Node – Raumcodes, Nachrichten-Relay, Handy-Controller (public/index.html)
```

## Lokal spielen (alle im selben WLAN)

1. Server starten:
   ```
   cd server
   npm install
   npm start
   ```
   Er zeigt die Adresse an, z. B. `http://192.168.0.12:8080`.
2. Bildschirm: `game/` in Godot öffnen und F5 drücken (oder den Web-Export unter `/host/` öffnen, siehe unten).
3. Handys öffnen die Adresse vom Bildschirm, geben den Raumcode ein — los.

## Im Browser (Web-Export)

1. In Godot einmal *Editor → Export-Vorlagen verwalten → Herunterladen* (4.7.2).
2. *Projekt → Exportieren → Web → Projekt exportieren*. Ziel ist schon eingestellt: `server/public/host/`.
3. `npm start`, dann den Bildschirm über `http://<adresse>:8080/host/` öffnen.

Für Online-Partys den `server/`-Ordner auf einen Node-Host (z. B. Render, Fly.io, Railway) deployen und `PUBLIC_URL` auf die öffentliche Adresse setzen.

## Test

```
cd server
GODOT=pfad/zu/Godot_v4.7.2-stable_win64_console.exe npm test
```
Startet Server + Godot headless + 4 Bots und spielt ein komplettes Spiel durch (inkl. Zeitüberschreitung und doppeltem Namen).
`SHOTS=<ordner>` dazu: Godot läuft sichtbar und speichert alle 2 s einen Screenshot.
