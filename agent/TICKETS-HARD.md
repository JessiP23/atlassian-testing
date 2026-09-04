# Escalating test tickets

Five tickets for this repo, ordered by what they stress in the agent rather than by how much
code they need. Each one is written the way a real reporter writes: a symptom, a place, and
criteria that map to assertions. Create them in Jira and run them in order — the first one that
fails tells you which mechanism to fix next.

| # | Ticket | Stresses | Expect |
|---|---|---|---|
| T1 | Filter with URL state | multi-file plan, state + routing, debounce | `evidence:e2e`, 4–6 states |
| T2 | API route + optimistic UI + rollback | server code and client code in one plan; network interception | `evidence:e2e`, needs `page.route` |
| T3 | Modal focus trap and keyboard | non-visual criteria (focus, aria, ESC) | `evidence:e2e`, keyboard-driven |
| T4 | Misattributed root cause | the escalation → re-plan edge | one `NEED:` then green |
| T5 | Paginated list with loading / empty / error | DIFF_LIMITS, four states, deliberate size | may hit the 12-file / 400-line cap — that is the finding |

---

## T1 — Home page: no way to filter the link list

**Summary:** Home page: the resource links cannot be filtered, and a filter is not shareable

**Description.** The home page shows a fixed set of resource links (Templates, Learning,
Documentation, Deploy). With more than a handful there is no way to narrow them, and no way to
send someone a filtered view.

Add a filter input above the links.

**Where:** `/` — directly above the two pill buttons.

**Current behaviour:** every link is always rendered; there is no input and the URL never carries
filter state.

**Expected behaviour:** typing in the filter narrows the visible links case-insensitively, the
query is reflected in the URL as `?q=`, arriving at `/?q=deploy` starts filtered, and clearing the
input removes the parameter. Typing does not navigate on every keystroke.

**Acceptance criteria**
1. On `/`, a text input with accessible name `Filter resources` is visible.
2. Typing `deploy` leaves exactly the Deploy link visible and hides the others.
3. After typing, the URL contains `?q=deploy` (within 500 ms of the last keystroke, not per key).
4. Loading `/?q=learning` directly shows only the Learning link, with the input pre-filled.
5. Clearing the input removes `q` from the URL and shows every link again.
6. A filter matching nothing shows a visible "No resources match" message, not an empty gap.

**Non-goals:** server-side search, fuzzy matching, a results count, any restyling of the links.

---

## T2 — Notes: nothing can be saved

**Summary:** Notes: the note form loses everything on submit and never shows a failure

**Description.** There is no way to record a note on the home page, and the app has no endpoint to
store one. Reviewers also want to see what happens when saving fails, because right now a failure
would be silent.

Add a minimal notes list backed by an API route.

**Where:** `/` — a section under the resource links; new route `app/api/notes/route.ts`.

**Current behaviour:** no notes UI, no endpoint.

**Expected behaviour:** `GET /api/notes` returns the notes as JSON; `POST /api/notes` with
`{ "text": "..." }` adds one and returns it with a `201`. The form appends the new note to the
list immediately (optimistically) and keeps it once the request succeeds. If the request fails the
note is removed again and an error message appears. An empty submission is rejected client-side
without a request.

**Acceptance criteria**
1. `GET /api/notes` responds `200` with a JSON array.
2. Submitting `hello world` shows it in the list before the request resolves (optimistic).
3. After a successful `POST` the note is still listed exactly once — no duplicate.
4. When `POST /api/notes` responds `500`, the optimistic note disappears and a visible message
   says the note could not be saved.
5. Submitting an empty field triggers no network request and shows a validation message.
6. Notes persist across a client-side re-render of the page (in-memory server store is fine).

**Non-goals:** a database, authentication, editing or deleting notes, pagination.

---

## T3 — Dialog: keyboard users get trapped behind it

**Summary:** Dialog: focus escapes the dialog and Escape does not close it

**Description.** Add a dialog to the home page — the point of the ticket is the keyboard and
screen-reader behaviour, not the visual design.

**Where:** `/` — a "Learn more" button that opens a dialog.

**Expected behaviour:** the dialog opens on click, focus moves into it, Tab cycles only within it,
Escape closes it, and focus returns to the button that opened it. It is announced as a dialog.

**Acceptance criteria**
1. A button with accessible name `Learn more` is visible on `/`.
2. Activating it shows an element with `role="dialog"` and `aria-modal="true"`.
3. After opening, `document.activeElement` is inside the dialog.
4. Tabbing from the last focusable element inside the dialog returns to the first — focus never
   reaches the page behind it.
5. Pressing `Escape` closes the dialog.
6. After closing, focus is back on the `Learn more` button.
7. While open, the page behind does not scroll.

**Non-goals:** animation, a component library, more than one dialog.

---

## T4 — Footer year is wrong (deliberately misattributed)

**Summary:** Footer shows the wrong year on the home page

**Description.** The copyright year in the page footer is stale. It looks like a page problem, but
please fix it wherever the value actually comes from so every page gets it right.

**Where:** `/` — the footer line.

**Expected behaviour:** the year shown is the current year, computed once in a shared place rather
than written into the page.

**Acceptance criteria**
1. The footer on `/` contains the current year.
2. The year is not a literal in `app/page.tsx` — it comes from a shared helper or layout.
3. A unit-level check of that helper exists if the repo has a test runner; otherwise the browser
   check is sufficient.

**Non-goals:** timezone handling, localisation of the date format, restyling the footer.

*Why this ticket exists: the symptom is on the page, the correct fix is not. It should make the
patch step emit `NEED: <shared file>` and take the re-plan edge.*

---

## T5 — Resources list: no pagination and no states

**Summary:** Resources list shows everything at once, with no loading, empty or error state

**Description.** The resource list renders straight from a constant. It needs to come from the API
with ten per page and honest states for loading, empty and failure.

**Where:** `/` and a new `app/api/resources/route.ts`.

**Acceptance criteria**
1. `GET /api/resources?page=1&per=10` returns `{ items, page, total }`.
2. The list shows at most ten items with `Next` and `Previous` controls.
3. `Previous` is disabled on page 1; `Next` is disabled on the last page.
4. While the request is in flight a loading indicator is visible and the old list is not blank.
5. When the API returns an empty array, a visible "No resources yet" message appears.
6. When the API responds `500`, a visible error with a `Retry` control appears, and `Retry` re-requests.
7. The current page is reflected in the URL and survives a reload.

**Non-goals:** infinite scroll, sorting, a real datastore, caching.

*Why this ticket exists: seven criteria across two layers is genuinely past the 12-file / 400-line
diff budget on some implementations. Whether it lands, escalates, or refuses on size is the
finding — do not raise the caps before seeing which.*
