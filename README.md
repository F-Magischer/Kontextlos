# KONTEXTLOS

Party-Spiel für 2–20 Leute im Browser. Sag was Harmloses — die anderen machen's schlimm.
Design & Art Direction: siehe [DESIGN.md](DESIGN.md).

**Live:** https://kontextlos.onrender.com — eine Startseite für alle: mitspielen, Raum erstellen oder das Gerät als großen Bildschirm (TV/Beamer) öffnen.
Gehostet auf Render (free, Frankfurt), deployt automatisch bei jedem Push auf `main`.

```
game/     Godot 4.7 – der große Bildschirm (zeigt nur an, was der Server schickt)
server/   Node – Spiellogik (game.js), Räume, Texte (content.js), Handy-Seite (public/index.html), QR-Codes
```

## Lokal spielen (alle im selben WLAN)

1. Server starten (PowerShell):
   ```
   cd server; npm install; npm start
   ```
   Er zeigt die Adresse an, z. B. `http://192.168.0.12:8080`.
2. Bildschirm: `http://<adresse>:8080/host/` im Browser öffnen (oder `game/` in Godot öffnen und F5).
3. Handys scannen den QR-Code oder öffnen den Link vom Bildschirm — los.

Die Spiellogik läuft auf dem Server. Ein versteckter oder neu geladener Bildschirm hält das Spiel nicht an,
nach dem Neuladen ist derselbe Raum wieder da.

**Ohne großen Bildschirm:** Auf dem Handy „Neuen Raum erstellen“ tippen, den Link teilen — alles läuft dann auf den Handys.

### Modi (in der Lobby umschaltbar)
- **Großer Bildschirm:** Auflösung, Abstimmungs-Übersicht und Punkte laufen auf dem Host (Beamer/TV). Handys zeigen nur das Nötigste.
- **Alle am Handy:** Jedes Handy zeigt zusätzlich die Auflösung, die Posts zum Abstimmen und den Punktestand.

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
Ohne `GODOT`: ein Handy-Bot erstellt den Raum, 4 Bots spielen ein komplettes Spiel im Handy-Modus.
Mit `GODOT`: der Godot-Bildschirm erstellt den Raum (Headless-Test, schlägt bei Skriptfehlern fehl).
In beiden Fällen inkl. Zeitüberschreitung, Platzhalter-Texten und doppeltem Namen.
`SHOTS=<ordner>` dazu: Godot läuft sichtbar und speichert alle 2 s einen Screenshot.
