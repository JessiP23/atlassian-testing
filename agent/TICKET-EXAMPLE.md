# Example ticket for the first end-to-end run (project KAN or ATL, type Bug)

Chosen so the whole pipeline can prove itself with no login, no data, no backend:
the symptom is on the home page, it is visible, and it is exactly assertable with
`toHaveCSS`.

## Summary
Home page: the "Deploy Now" button is black instead of the brand blue

## Description
On the home page (`/`), the primary "Deploy Now" button renders with the
near-black `--foreground` colour (`#171717`). It should be the brand blue
`#2563EB` so the primary action is distinguishable from the secondary
"Read our docs" button next to it.

**Where:** `/` — the first of the two pill buttons at the bottom of the page,
labelled "Deploy Now".

**Current behaviour:** the button's background is `#171717`
(`bg-foreground`), which reads as the same weight as the outlined button.

**Expected behaviour:** the button's background is `#2563EB`, its label stays
white/legible, and the hover state darkens to `#1D4ED8`. Size, radius, icon and
layout are unchanged, and the secondary "Read our docs" button is untouched.

## Acceptance criteria
1. On `/`, the "Deploy Now" button's computed `background-color` is
   `rgb(37, 99, 235)`.
2. Its label and icon stay legible against the new background.
3. Hovering darkens the button rather than leaving it unchanged.
4. The "Read our docs" button, the headings and the links are unchanged.
5. The colour is defined once (a CSS custom property in `app/globals.css` or a
   Tailwind class) — not repeated as a raw hex in several places.

## Non-goals
- Dark mode restyling beyond keeping the button legible.
- The secondary button, the logo, the headings or the footer links.
- Any layout, spacing or typography change.
