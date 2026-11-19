# Web style guide: passbook and cheque

One page. Every visual choice comes from an Indian banking artifact: the passbook,
the cheque's security print, the bank's rubber stamp.

## Palette

| role | light | dark | used for |
|---|---|---|---|
| Paper | `#F5F7F6` | `#0F1D21` | every background; one surface, no cards |
| Ink | `#102A30` | `#E3ECE9` | headings, the balance, the running-balance column |
| Printer ink | `#2E4448` | `#C3D1CE` | passbook entries (9.6:1 / 11.0:1), as printed by a passbook printer |
| Ink soft | `#46595D` | `#A3B5B3` | secondary text (6.9:1 / 8.1:1) |
| Rule | `#CBD5D2` | `#2A3B3F` | ruled lines, the preprinted form |
| Stamp violet | `#5B3DA6` | `#A894F0` | the stamp, focus rings; nothing else |

Signals (never colour alone): money in `#17694D` / `#4CC38A`; money out, only in the
phone's single signed column, brick `#A14A3A` / `#F2A48F` (5.5:1 / 8.6:1), with a minus
sign; pending `#8A5708` / `#E0A23A`, always hatched; failed `#B42318` / `#F0705F`,
always struck through.

**Persona tints**, from the banknote each person's colour echoes. They tint the
security print ONLY and never carry text (two are under 4.5:1 on paper in light):

| person | note | light | dark (UV) | dark strength |
|---|---|---|---|---|
| Meera Iyer | ₹50, fluorescent blue | `#2F7FA6` | `#63C6F0` | 0.11 |
| Arjun Rao | ₹10, chocolate brown | `#8A5A35` | `#E0A574` | 0.12 |
| Kavya Nair | ₹20, greenish yellow | `#6B8A1E` | `#C2E05A` | 0.08 (a bright tint reads heavier) |

One source: `web/lib/personas.ts`.

Violet is deliberately absent from the tints: it belongs to the stamp.

## Type

- **Hind** (Indian Type Foundry), 400/500/600: all text. Real ₹ glyph, Indian figures.
- **Rajdhani** 600: the balance only (squared digits, like a cheque's amount box).
- Amounts: tabular lining figures, Indian grouping (₹1,24,560.50), never rounded, never "lakh".
- Scale 14 / 16 / 18 / 24 / 36 / 60 px. Sentence case everywhere. No monospace.

## The one bold element

The **balance header is a cheque's security print**: a flat guilloche, three families
of interlaced sine curves a third of a cycle apart, constant 0.6 px line weight, one
160 x 40 px tile repeated (`web/scripts/make-security-print.mjs`). No modulation,
perspective or density change. Tinted with the person's colour at 20% in light; in
dark it shows at the strength above with a 0.5 px glow, like security ink under a UV
lamp. The amount sits in a cleared amount box; a line of microprint (the person's
name, a background image, not text) runs along the bottom edge.

Where it appears: wherever a balance is the subject: the Overview header, the
account strips on Send and Top up, and the person slips on the landing page (a
counterfoil, a perforation, the leaf). Nowhere else.

## Rules

1. One surface (paper). Structure comes from rules and type, not boxes. No cards, no shadows
   on content, no decorative gradients, no glows other than the UV print in dark mode.
2. The passbook looks printed: entries in printer ink on a ruled form; the running
   balance column is the strongest text in the table.
3. Violet appears only when something is proven: Verified, Replayed, 0 problems.
4. Pending is separate from posted, always (its own strip, hatched, never in the balance).
5. Motion only answers the user: the theme toggle's circular reveal from the button
   (View Transitions; instant where unsupported), the balance counting to its new
   value after the person's OWN send or posted top-up (never on a page load, never
   because of a change elsewhere), the stamp landing. No entrance animations.
   `prefers-reduced-motion`: all of it instant.
6. Floor: 4.5:1 for all text, visible focus (violet ring), keyboard everywhere, both
   themes equally finished, no horizontal scroll at 360 px.
7. Banned (they read as generated): cream + serif + terracotta; near-black with one acid
   accent; identical rounded cards with one grey shadow; decorative gradients; ALL-CAPS
   eyebrow labels; "A · B · C" meta strings; "→" on buttons; fade-up entrances.
