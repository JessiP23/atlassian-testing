# Medium-difficulty UI ticket (project KAN, type Story or Bug)

Chosen to exercise the whole evidence path properly: it needs real work (state,
persistence, a Tailwind strategy change), it is on a public page so no login is
involved, and every acceptance criterion maps to a Playwright assertion — one of
which is a CLICK, so the recorded video and GIF actually show behaviour rather
than a static page.

## Summary
Home page has no way to switch theme — dark mode only follows the OS

## Description
The app renders light or dark purely from `prefers-color-scheme`, so a visitor
cannot choose. On a light OS the dark palette is unreachable and vice versa,
which also makes the dark styling impossible to review.

Add a theme toggle to the home page.

**Where:** `/` — top-right of the page, above the Next.js logo.

**Current behaviour:** no control exists. `<html>` never carries a theme class;
the palette comes only from the media query in `app/globals.css`.

**Expected behaviour:** a single icon button, accessible name **"Toggle theme"**,
switches the page between light and dark immediately. The choice is remembered
across reloads. A visitor who has never chosen still gets their OS preference.

## Acceptance criteria
1. On `/`, a button whose accessible name is `Toggle theme` is visible.
2. Clicking it adds `class="dark"` to the `<html>` element; clicking it again
   removes it.
3. With `dark` present, the page background is `rgb(10, 10, 10)`; without it,
   `rgb(255, 255, 255)`.
4. The choice survives a reload — it is stored under the `localStorage` key
   `theme` with the value `dark` or `light`.
5. First visit with no stored value follows `prefers-color-scheme`.
6. No flash of the wrong theme on load.
7. Tailwind dark variants keep working — the existing `dark:` classes on the
   page must respond to the class, not only to the media query.

## Non-goals
- A settings page, a dropdown, or a third "system" option in the UI.
- Restyling anything beyond what the toggle needs.
- Any change to the two pill buttons, the logo or the links.

## Notes for the implementer
- Tailwind v4 defaults dark mode to the media query; a class strategy has to be
  declared explicitly (`@custom-variant dark (&:where(.dark, .dark *))` in
  `app/globals.css`).
- Setting the class from a `useEffect` alone causes criterion 6 to fail; the
  initial class has to be applied before paint.
