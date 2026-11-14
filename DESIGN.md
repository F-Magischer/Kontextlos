# KONTEXTLOS — Game Design

Party-Spiel für 3–8 Leute. Ein Bildschirm (Laptop/TV) zeigt das Spiel, alle spielen mit dem Handy im Browser. Inspiriert vom *Genre* von Jackbox' "Survive the Internet" (harmlose Antwort → wird von jemand anderem aus dem Kontext gerissen), aber mit eigenem Ablauf, Formaten, Look und Punkte-System.

## Kernschleife (pro Runde)

| Phase | Dauer | Handy | Bildschirm |
|---|---|---|---|
| 1. Ehrlich sein | 60 s | Jede:r beantwortet eine harmlose, persönliche Frage | Wer ist fertig? |
| 2. Verdrehen | 75 s | Du siehst den fertigen Post (z. B. Videokommentar) mit der fremden Antwort darin und tippst direkt in das leere Feld (Videotitel, Schlagzeile …). Die Original-Frage siehst du nicht. | Wer ist fertig? |
| 3. Enthüllung | ~9 s pro Post | (Handy-Modus: dasselbe) | Erst nur der Twist → dann fällt die Antwort rein. Die Original-Frage nur, wenn in der Lobby eingeschaltet. Wer verdreht hat, bleibt geheim. |
| 4. Abstimmen | 30 s | Welcher Post ist am schlimmsten? (Eigene Verdrehung nicht wählbar) | Countdown |
| 5. Auszählung & Punkte | — | (Handy-Modus: dasselbe) | Jetzt erst: wer welchen Post verdreht hat, dazu die Stimmen. Danach Rangliste. |

Zuordnung: Spieler werden gemischt und im Kreis verbunden (jede:r verdreht genau eine Antwort, niemand die eigene).

## Runden & Punkte

- **Runde 1** ×1, **Runde 2** ×2, **Finale** ×3.
- Pro Stimme: Verdreher:in +100 × Multiplikator, Opfer (Original-Antwort) +40 × Multiplikator ("Mitleidspunkte").
- Läuft der Timer ab, schickt jedes Handy automatisch ab, was gerade im Feld steht. Wer gar nichts geschrieben hat, bekommt einen peinlichen Platzhalter-Text.

## Formate (eigene Erfindungen, keine echten Marken)

Schlagzeile · Kommentar unter Video · Produktbewertung · Dating-Profil · Suchverlauf · Gruppenchat-Nachricht · Kleinanzeige · Motivationsposter.
Jedes Format hat ein eigenes Layout auf dem Bildschirm, damit jede Enthüllung wie ein neuer "Fund" wirkt.

## Art Direction: "Risograph-Zine"

Ziel: wie ein gedrucktes Fanzine/Siebdruck-Plakat, nicht wie ein generiertes UI.

- **Papier statt Bildschirm:** warmes Off-White (#EFE7D6) mit Halbton-Raster, Tinte fast-schwarz (#1B1A17).
- **Zwei Schmuckfarben wie beim Riso-Druck:** Fluo-Pink (#FF4F79) und Druck-Blau (#2B59C3), dazu Gelb (#FFD23F) nur als Akzent. Keine Verläufe.
- **Harte Kanten:** Rechteckige Karten, harter Versatz-Schatten (kein Blur), 3 px Tintenrand, leichte Schräglage (±2°) wie hingeklebt.
- **Typo mit Charakter:** Bricolage Grotesque (fett, eng) für Headlines, IBM Plex Mono für Labels/Timer. Keine Standard-UI-Font.
- **Bewegung:** Karten "klatschen" rein (Skalierung + Rotation), Timer als Balken, kein Glow, keine Partikel-Konfetti-Regen.

Bewusst vermieden (typische "KI-Game"-Fallen): Lila-Blau-Verläufe, Glassmorphism, Neon-Glow, abgerundete Pastell-Karten mit weichem Schatten, Emoji als Icons, generische Maskottchen.

## Technik

- `server/game.js` — die gesamte Spiellogik inkl. Timer. Läuft auf dem Server, damit nichts hängen bleibt, wenn ein Browser-Tab pausiert.
- `game/` — Godot 4.7 Projekt = großer Bildschirm. Reine Anzeige: bekommt nach jeder Änderung einen kompletten Spielstand ("view") und zeichnet ihn.
- `server/public/` — Handy-Seite. Bewusst eine schlanke Web-Seite statt Godot: lädt sofort, echte Handy-Tastatur, Autokorrektur.
- Zwei Modi: *Großer Bildschirm* (Auflösung vorne) oder *Alle am Handy* (jedes Handy zeigt Auflösung, Abstimmung als Posts, Punkte). Ein Raum, der auf dem Handy erstellt wird, ist automatisch im Handy-Modus.
