// All game text lives here so it can be edited without touching logic.

exports.PROMPTS = [
  "Was hast du zuletzt gegessen?",
  "Was ist dein Geheimtipp für einen guten Morgen?",
  "Beschreib dein Zimmer in einem Satz.",
  "Was würdest du mit 100 € spontan kaufen?",
  "Welches Geräusch magst du am liebsten?",
  "Was machst du, wenn dir langweilig ist?",
  "Was ist das Beste an Sonntagen?",
  "Was hast du immer in deiner Tasche?",
  "Welches Essen könntest du jeden Tag essen?",
  "Was war dein letzter Einkauf?",
  "Wie entspannst du nach einem langen Tag?",
  "Was würdest du deinem jüngeren Ich raten?",
  "Wofür gibst du zu viel Geld aus?",
  "Was ist dein bester Kochtipp?",
  "Was machst du als Erstes nach dem Aufwachen?",
  "Was nervt dich im Supermarkt?",
  "Beschreib deinen Kleidungsstil.",
  "Was ist dein Lieblingsgeruch?",
  "Was hast du zuletzt repariert?",
  "Wie sieht dein perfektes Frühstück aus?",
  "Was ist dein Trick, um einzuschlafen?",
  "Was hast du als Kind gesammelt?",
  "Welches Haustier hättest du gern?",
  "Was ist dein Lieblingsplatz in der Wohnung?",
  "Was würdest du nie wegwerfen?",
  "Was singst du unter der Dusche?",
  "Was kannst du richtig gut?",
  "Was machst du im Urlaub am liebsten?",
  "Was steht bei dir im Kühlschrank ganz hinten?",
  "Wie gehst du mit Spinnen um?",
  "Was war dein bestes Geschenk?",
  "Was ist der beste Snack für einen Filmabend?",
  "Was machst du mit deinen Händen, wenn du nervös bist?",
  "Wie würdest du deinen Gang beschreiben?",
  "Was sagst du, wenn du dich am Telefon verabschiedest?",
  "Welche Pflanze würdest du gern besitzen?",
  "Was ist dein Lieblingswort?",
  "Was hast du zuletzt verloren?",
  "Wie sieht dein Sonntagsoutfit aus?",
  "Was machst du, wenn du nicht schlafen kannst?",
];

// label/hint: placeholder of the slot the twister types into. fallback: used when they type nothing.
exports.FORMATS = [
  { id: "headline", name: "Schlagzeile", label: "Schlagzeile", hint: "z. B. Polizei ratlos: …", fallback: "Nachbarn alarmiert: Wer ist diese Person?" },
  { id: "video", name: "Videokommentar", label: "Videotitel", hint: "z. B. Opa reagiert auf …", fallback: "Meine Knie-OP komplett (ungeschnitten)" },
  { id: "review", name: "Bewertung", label: "Produkt", hint: "z. B. Feuchttücher für Hunde", fallback: "Notfall-Grabstein (Bausatz)" },
  { id: "dating", name: "Dating-Profil", label: "Profil-Überschrift", hint: "z. B. Suche jemanden, der …", fallback: "Suche Partner:in für die Steuererklärung" },
  { id: "search", name: "Suchergebnis", label: "Suchanfrage", hint: "z. B. ist es normal, dass …", fallback: "wie lange darf man im Baumarkt wohnen" },
  { id: "chat", name: "Gruppenchat", label: "Gruppenname", hint: "z. B. Familie (ohne Mama)", fallback: "Elternabend 3b" },
  { id: "classified", name: "Kleinanzeige", label: "Was wird verkauft?", hint: "z. B. gebrauchter Sarg", fallback: "Ehering, kaum benutzt" },
  { id: "poster", name: "Motivationsposter", label: "Großes Wort", hint: "z. B. DURCHHALTEN", fallback: "ERFOLG" },
];

exports.NO_ANSWER = ["Dazu sage ich nichts ohne meinen Anwalt.", "Frag nicht.", "Kein Kommentar.", "Das bleibt unter uns."];

exports.PLAYER_COLORS = ["#FF4F79", "#2B59C3", "#1F9E6E", "#F26419", "#6B4BD8", "#0B8A8A", "#C8372D", "#6E7F1D"];
