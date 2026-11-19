# Web style guide: passbook and cheque

One page. Every visual choice comes from an Indian banking artifact: the passbook,
the cheque's security print, the bank's rubber stamp.

## Palette

The page is the person's cheque paper. In light mode each person's pages have their
own very lightly tinted paper, so switching person changes the whole page; in dark
mode every page is deep ink blue-black, the feel of paper under a UV lamp.

| role | light (no person) | dark | used for |
|---|---|---|---|
| Paper | `#F1F3F6` | `#0B1120` | every background, the demo strip; one surface, no cards |
| Surface | `#FAFBFC` | `#111A2E` | form fields, slips |
| Ink | `#15203A` | `#E6EAF4` | headings, the balance (14.5:1 / 15.6:1) |
| Printer ink | `#2E3A52` | `#C9D1E4` | passbook entries (10.3:1 / 12.3:1) |
| Ink soft | `#4B566B` | `#A7B1C8` | secondary text (6.7:1 / 8.8:1) |
| Rule | `#CDD3DD` | `#26324D` | ruled lines, the preprinted form |
| Stamp violet | `#5B3DA6` | `#A894F0` | the stamp only (and focus where no person is chosen) |

**Each person**: their paper (light only), and their tint, after a banknote's colour.

| person | note | paper / surface / rule (light) | tint (light) | tint (dark) | print strength (dark) |
|---|---|---|---|---|---|
| Meera Iyer | ₹50 blue | `#EAF1F6` `#F5F9FB` `#C3D3DF` | `#2F7FA6` (3.9:1) | `#63C6F0` | 0.30 |
| Arjun Rao | ₹10 brown | `#F4EEEB` `#FBF8F6` `#DCCDC5` | `#8A5A35` (5.1:1) | `#E0A574` | 0.32 |
| Kavya Nair | ₹20 green | `#EDF3E7` `#F7FAF3` `#CDDBC0` | `#5F7D17` (4.2:1) | `#C2E05A` | 0.30 |

Arjun's paper is rose-taupe (hue 20), deliberately not cream (hue 42).

The tint appears quietly, never as text: the security print, the active nav marker, the
chart line, the passbook ruling, the balance column's strip and focus rings (all 3:1 or
more as lines). In dark mode it is toned 30% towards soft ink and never glows: a bright
tint alone on blue-black reads as an acid accent. One source: `web/lib/personas.ts`.
Violet is deliberately absent from the tints: it belongs to the stamp.

Signals (never colour alone): money in `#17694D` / `#4CC38A`; money out, only in the
phone's single signed column, brick `#A14A3A` / `#F2A48F`, with a minus sign; pending
`#8A5708` / `#E0A23A`, always hatched; failed `#B42318` / `#F0705F`, always struck
through. All 5.1:1 or more on every paper.

## Type

- **Hind** (Indian Type Foundry), 400/500/600: all text and passbook amounts. Real ₹ glyph.
- **Rajdhani** 600: the balance and the account strips (squared digits, like a cheque's amount box). Real ₹ glyph.
- Amounts: Indian grouping (₹1,24,560.50), never rounded, never "lakh", and **tabular
  figures, emulated**: neither face has a `tnum` feature (a "1" is 0.33 em, a "0" 0.54
  em; `tabular-nums` changes nothing), so every digit sits in a slot as wide as the
  face's widest digit (0.555 em Hind, 0.535 em Rajdhani; `web/components/money.tsx`).
  Screen readers get the plain amount. A test checks the column lines up and both
  faces draw their own ₹.
- Scale 14 / 16 / 18 / 24 / 36 / 60 px. Sentence case everywhere. No monospace.

## The one bold element

The **balance header is a cheque's security print**: a flat guilloche, three families
of interlaced sine curves a third of a cycle apart, constant 0.6 px line weight, one
160 x 40 px tile repeated (`web/scripts/make-security-print.mjs`). No modulation,
perspective or density change. Tinted with the person's colour at 20% in light; in
dark it shows in the toned tint at the strength above, with no glow, so each person is
recognisable under the "UV lamp" too. The amount sits in a cleared amount box; a line of microprint (the person's
name, a background image, not text) runs along the bottom edge.

Where it appears: wherever a balance is the subject: the Overview header, the
account strips on Send and Top up, and the person slips on the landing page (a
counterfoil, a perforation, the leaf). Nowhere else.

## Rules

1. One surface (paper). Structure comes from rules and type, not boxes. No cards, no shadows
   on content, no decorative gradients, no glows other than the UV print in dark mode.
2. The passbook looks printed: entries in printer ink on a page with faint horizontal
   ruling and preprinted column rules (both in the person's tint); the running balance
   is the strongest text, on a slightly darker strip that runs unbroken down the page.
3. Violet appears only when something is proven: Verified, Replayed, 0 problems.
4. Pending is separate from posted, always (its own strip, hatched, never in the balance).
5. Motion only answers the user: the theme toggle's circular reveal from the button
   (View Transitions; instant where unsupported), the balance counting to its new
   value after the person's OWN send or posted top-up (never on a page load, never
   because of a change elsewhere), the stamp landing. No entrance animations.
   `prefers-reduced-motion`: all of it instant.
6. Floor: 4.5:1 for all text, visible focus (the person's tint, 3:1 or more), keyboard
   everywhere, both themes equally finished, no horizontal scroll at 360 px (tested on
   every screen).
7. Banned (they read as generated): cream + serif + terracotta; near-black with one acid
   accent; identical rounded cards with one grey shadow; decorative gradients; ALL-CAPS
   eyebrow labels; "A · B · C" meta strings; "→" on buttons; fade-up entrances.
