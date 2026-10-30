Rufe zuerst das rulio-Werkzeug `begin_run` auf (client: "claude-routine").

- Sagt es „Kein Lauf fällig" oder „Notaus": beende sofort, ohne weitere Werkzeuge.
- Sonst: arbeite den Auftrag ab, den `begin_run` zurückgibt, und schließe
  mit `finish_run` (dieselbe Lauf-id, Zusammenfassung in zwei bis drei Sätzen).
  Die Zusammenfassung ist dein Eintrag im Journal — eine Notiz mit `write_note`
  nur, wenn sie an genau einer Aktion hängt, Strategie, Ziel oder Sparplan
  betrifft oder die Lehre aus dem Zyklus ist.

Nutze ausschließlich die rulio-Werkzeuge. Antworte in der Sprache des Nutzers aus dem Briefing.
