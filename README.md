# TVM Precision Machining — PO Calendar

Purchase-order and material scheduling board for the machine shop floor. Each PO renders as a
job card (PO #, part #, qty, dims, mat dim, material, finish, inspection, hardware, status) laid
out on a calendar by due date.

```
backend/    FastAPI + SQLAlchemy (Postgres in Docker, SQLite fallback for local dev)
frontend/   Next.js 15 (App Router) + FullCalendar + PWA manifest / service worker
```

## Run locally (no Docker)

Backend — SQLite fallback, seeds ~28 demo POs and 11 users on first boot:

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8000
```

Frontend:

```powershell
cd frontend
npm install
npm run dev      # http://localhost:3000
```

On a fresh database the seed creates the administrator
`tri@supermicro.com` / `demo1234`. Sign in with it, then create other accounts from **Users**.
Public self-registration is not exposed.

## Run with Docker (Postgres)

```bash
docker compose up --build
# web  http://localhost:3000
# api  http://localhost:8000/docs
```

## Features

- **Dashboard** — the landing page (`/` redirects here, and it is first in the rail). One dense,
  sortable table with a row per purchase order: job no over part no as a two-line identifier, then
  PO #, customer, priority, stage, status, owner, material, finish, due date, who last modified it,
  a narrow comments column (chat-bubble icon with a count badge), and a right-aligned qty. A locked
  order wears the lock glyph beside its job number, and an empty cell reads as an em dash rather than
  as blank space. **Last modified** is derived rather than
  stored: there is no modifier field on the order, so the list route reads it off the activity trail
  with one `row_number()` window query over every row scoped to `entity_type="purchase_order"` —
  which is what keeps a sign-in or an avatar change from making somebody the last modifier of an
  order they never opened. Creation counts as the first modification, so a job nobody has touched
  since it was entered names whoever entered it and the timestamp says when; the em dash is reserved
  for an order with no attributable change at all. Opening an order and pressing Save cannot take
  the cell over, because a save that changes nothing writes no trail row — see **Detail drawer**.
  The cell reads like the owner cell, avatar and
  name, with the time beneath and the action in the tooltip, and it sorts by *when*, not by name.
  **Comments** sit between Modified and Qty as an icon-sized column (sortable by count): clicking the
  bubble opens a chat-style thread without opening the drawer (`stopPropagation`), and the same
  thread is embedded in the detail drawer. Any signed-in rank can read and post — including Viewer —
  and a locked order still accepts notes, because comments are not order edits and never write
  activity or move Modified. Each list row carries `comment_count` from one GROUP BY so the badge
  never N+1s. `All / Ongoing / On hold / Completed` filter pills carry live
  counts derived from each order's stage — the three named buckets partition the four stages, so
  they always add up to All, search included. Search is the server's `q` (job, PO, part, material,
  customer), the same as the task board. Every column sorts on click and reverses on the second
  click, each on its own terms: dates and quantities compare as numbers, job and PO numbers compare
  naturally so `J-9` precedes `J-40`, priority walks HOT → LOW and stage walks the board, and empty
  cells sink to the bottom whichever way the column points. Clicking or Entering a row opens the
  usual detail drawer, so edits and the activity trail work unchanged; the top-right button creates
  a PO through the same drawer. Signing in lands here too. On a desktop-height window
  the column headings pin to the top of the table while the rows scroll under them. Filter and sort
  stick per browser (`po_calendar_dashboard_filter` / `po_calendar_dashboard_sort`).
- **Calendar view** — FullCalendar year/month/week/list. Each event is a compact job card showing
  job no, PO #, material, qty and status. Drag a card to a new day to reschedule (PATCH
  `due_date`). The year view (`@fullcalendar/multimonth`) zooms out to all twelve months at once,
  tinting every day that carries work and drawing each job as a status-coloured dot; clicking a
  dot opens the drawer, clicking the day zooms into that month.
- **Cards view** — full spreadsheet-style job cards grouped by due date.
- **Task cards** — two views of the same jobs, chosen with a Progress / All cards toggle. *Progress*
  is the kanban board with Pending / On Hold / In Progress / Completed columns: drag a card between
  columns and its status follows (a column's default status, unless the current one already belongs
  there, so `WAIT VQC` stays `WAIT VQC` inside In Progress). *All cards* drops the columns and lays
  every matching job out in one responsive grid, with a five-step zoom (XS to XL, `12rem` to `29rem`
  of minimum card width) that resizes the cards themselves rather than transform-scaling them, so
  the type stays sharp — seven cards per row at XS down to three at XL on a 1920px screen. Zoom is
  hidden on the board, whose four columns set their own width. Sorting by due date (earliest or
  latest) or by priority applies within each column on the board and across the whole set in the
  all-cards view; view, zoom and sort all stick per browser.
- **Card dragging** — pointer-driven rather than HTML5 drag-and-drop, which only reports a few
  positions per second and hands the browser a frozen bitmap. `lib/useBoardDrag.ts` lifts the card
  into a fixed-position clone that tracks the pointer every frame, auto-scrolls near the window
  edges, and flies to wherever the card lands. `Escape` abandons a drag; a press that never travels
  6px stays a plain click and opens the drawer. `lib/flip.ts` slides the cards that shifted as a
  result, so nothing teleports. On touch, a vertical swipe still scrolls the page.
- **Priority** — `HOT` / `HIGH` / `NORMAL` / `LOW`, set from the card editor. Anything above normal
  gets a coloured badge on the card and a dot on the calendar chip.
- **Order lock** — any editor (`admin` / `manager`) can lock a purchase order from the card editor;
  while it is locked only an `admin` may change it, and clearing the lock counts as a change, so
  only an admin can unlock it either. A `manager` keeps read access but is held out of every
  mutation — form save, status and stage changes, kanban and calendar drags, image attach and
  delete — and the server enforces it on `PATCH` and `DELETE` rather than trusting the UI, with a
  plain-language 403. A locked card wears a quiet `LOCKED` badge on the board and loses its drag
  affordance for anyone who can't move it; the drawer disables its fields, Save and Delete and says
  why. Locks and unlocks land in the activity trail.
- **Detail drawer** — the job card itself is the form: every cell is editable, including a
  click-or-drop image well for the part photo. Same editor creates new POs. Saving keeps the drawer
  open on the saved record, so the confirmation and the refreshed activity trail are visible in
  place. **Only real changes reach the activity trail.** The drawer sends its whole draft, so the
  server compares each incoming field against what is stored and the `PO updated` line names just
  the fields that genuinely moved; `status`, `due_date`, `locked` and `owner_id` keep their own
  lines and are held out of that list. The comparison defeats the same false positives
  `lib/dirty.ts` does on the client — `null` against an empty string, whitespace typed and deleted,
  a number or a date that round-tripped through an input, an enum arriving as its value — so a save
  with no edits writes no row at all, and leaves `updated_at` where it was: a stamp that moved
  while the trail recorded nothing would be the same false claim in another column. Below the form,
  a **Comments** section shares the same thread UI as the dashboard bubble; posting a note never
  dirties the unsaved-changes guard and never requires editor rank.
- **PO comments** — first-class `po_comments` rows (not activity): body, author, timestamp. Any
  signed-in user may list and post; author or Manager+ may delete. Cascade with the order; author
  delete SETs NULL so the thread keeps its chronology. No activity row, no lock check, no
  Modified bump — notes are conversation, not edits.
- **Unsaved changes** — dismissing the drawer with edits in it asks first. The scrim, `Escape` and
  the `Close` button all route through one guard, and it only fires when the form has really moved
  away from the record it was opened on: `lib/dirty.ts` compares the draft field by field after
  flattening both sides, so `null` against an empty string, a number that came back from an input as
  a string, a date normalised to a timestamp, whitespace typed and deleted, and a select re-picking
  the value it already had are all *not* changes. It walks whatever fields the draft has and names
  only the ones the server owns, so a field added to the card editor later is covered without
  touching it. The baseline resets on every successful save — the drawer staying open is exactly why
  it has to. The prompt offers three answers, never two: **Save and close**, **Discard changes** and
  **Keep editing**, because clicking outside a drawer is usually an accident; `Escape` and a click on
  the prompt's own scrim both mean *keep editing*. A new order that has never been saved says
  **Discard this new order?** instead, since discarding loses the order rather than an edit. A refused
  save — a 403 on a locked order, a validation message, a dead network — closes nothing: the prompt
  steps aside and the drawer keeps the edits and shows the reason. A read-only drawer renders its
  fields disabled and so can never reach a dirty state, and never prompts. Opening or posting
  comments is never treated as a draft change.
- **3D model** — one model per order, in a slot beside the part photo rather than instead of it.
  Click or drop **OBJ, FBX, STEP** (`.stp`/`.step`) or **Rhino 3DM** into the well and it opens in a
  full-screen viewer with orbit, pan and zoom, the camera framed on the part's bounding box, and a
  triangle / vertex / bounding-box readout. The read-only card wears a `3D ⟨format⟩` badge in the
  same family as `LOCKED` that opens the viewer in one click. Attaching or clearing a model is an
  ordinary edit, so it needs the same rank as any other field and a locked order refuses it the same
  way — though a locked order's model stays *viewable*, since looking is not changing.
  **CAD is translated in the browser, not on the server**: `.obj` and `.fbx` use three.js's own
  loaders, `.stp` goes through OpenCascade compiled to WASM (`occt-import-js`) and `.3dm` through
  `rhino3dm`. The server stores and serves the uploaded bytes untouched. None of that machinery is
  in the initial page load — three.js, each loader and each WASM payload are fetched the first time
  someone opens a model of that format, so nobody who never opens a STEP file downloads the 7.4 MB
  OpenCascade binary. Files that name textures which were never uploaded fall back to a plain shop
  grey rather than rendering black, and an unreadable file says so instead of spinning.
- **Owner** — an order can be handed to any active account from the card editor: an `OWNER` row in
  the same labelled grid as the rest of the card, the person's avatar beside their name, and
  *Unassigned* as a real choice, since an order may legitimately have nobody on it. Reassignment is
  an ordinary edit, so it needs the same rank as any other field and a locked order refuses it in
  exactly the same way. A new PO starts out owned by whoever is raising it. The picker is fed by
  `/api/users/assignable`, a narrow projection — id, name, initials, avatar, role — gated on the
  same floor as editing an order, so an editor never meets a dropdown it isn't allowed to fill and
  nobody has to be handed the full directory to draw one. Handovers land in the activity trail by
  name: `Owner changed · J-42: Tri Le -> Dana Reyes`.
- **Roles** — a four-rung hierarchy, **Admin > Manager > User > Viewer**. It is written down once,
  as `ROLE_RANK` in `backend/app/models.py` (mirrored by `ROLE_ORDER` in `frontend/lib/types.ts`),
  and every check derives from it rather than from hard-coded role names: "manager and above" is
  `has_rank(role, Role.MANAGER)`, and "may act on" is `outranks(actor, target)`. Full purchase-order
  edits (create, delete, arbitrary PATCH) need Manager or above (`EDITOR_FLOOR`). A **User** may
  change **status** and **stage** on an unlocked order (`STATUS_FLOOR`) — drawer status select and
  kanban column drag — but is refused on every other field; a locked order stays Admin-only.
  Viewer remains read-only on orders. Accounts are provisioned by an Admin.
- **Users** — directory with search, role filter and per-user activity, for the ranks that
  administer accounts. Only an Admin can create an account and set its initial password. Manager
  and above can set roles and assign an org (pick an existing one or type a new one). Two rules keep that
  from being a way to climb: **you may only assign a role strictly below your own, and only act on
  people strictly below your own rank.** So a manager can make someone a User or a Viewer, but can't
  mint an Admin, can't edit or demote one, can't touch a fellow manager, and can't promote itself.
  Admins are exempt and can do anything, including changing their own role — though once they drop
  to manager, only another admin can put them back. The API also refuses any change
  that would leave no admin able to sign in, so the shop can't lock itself out. Everyone gets a
  **profile photo** — a click-or-drop well on their detail panel, shown in the rail, the directory,
  the activity trail and on the job cards they own, with initials as the fallback. Photos are
  self-service at every rank, Viewer included: `POST /api/uploads/avatar` stores the image and
  hangs it on the caller's own account in one step. It takes no user id, so the only record it can
  write is your own — which is what lets it sit open to everyone while the general image upload
  stays at the editor floor for order photos and models. Setting someone *else's* photo is an
  ordinary upload plus a PATCH, and needs rank over them.
  The directory itself is only for manager and above — it used to be readable by anyone signed in,
  which with sign-up open meant a new Viewer could enumerate every address in the shop. Below
  Manager the same page becomes **My profile**: it renders your own record, which the app already
  holds from the session, and asks the server for no listing at all. The nav rail names the link for
  whichever it is, so self-service stays one click away without pretending a one-person page is a
  directory.
- **PWA** — installable, offline shell for the app pages (API always hits the network).
- **Fluid layout** — everything is sized in `rem` against a viewport-scaled root font, and the job
  card uses container queries so it re-tunes to its column rather than the window. `npm run
  check:layout` drives a headless browser across seven widths and fails on any element that
  spills past the viewport. The dashboard's twelve-column table narrows the same way: container
  queries drop the least scannable columns in bands (finish, then PO #, material and last-modified,
  then stage and owner, then customer, then status) and restate the remaining widths so the short
  fixed-vocabulary cells — the priority tag, stage pill, date and quantity — are never clipped, down
  to four columns at the narrowest. Headings give up their letter-spacing a band before any column
  gives up its letters. Because the query is on the table's own container rather than the viewport,
  it gets the extra room back when the rail folds away below 780px, showing more at 640px than at
  820px. The table also keeps its own horizontal scroll container as a safety net for scaled-up type,
  so the page itself never scrolls sideways; on a window tall enough for it, that same container is
  what the pinned headings stick to.
- **Look and motion** — the page sits on soft, wide colour blooms rather than a pattern, so nothing
  competes with the cards. Everything that moves shares one decelerating curve and three durations
  (`--ease`, `--t-fast/mid/slow` in `globals.css`); only `transform` and `opacity` are animated, so
  motion stays off the layout path. `prefers-reduced-motion` cuts every transition and skips the
  drag flourishes while leaving the interaction itself intact.
- **Board settings** (Admin only) — `/settings` in the rail. A published JSON document in
  `board_settings` configures card field visibility/order (built-ins plus custom attributes), the
  status catalog (label + tone), dashboard table columns, and Task Progress kanban columns (each
  with an ordered list of status keys). Live preview on the right uses fixed sample data so edits
  never mutate production rows. Save publishes atomically for everyone; Cancel reverts the draft.
  Removing a custom attribute hides it from the UI but does **not** purge values already stored in
  each PO’s `custom_fields` JSON map. Removing a status that any PO still uses is blocked with a
  count. Kanban drag still sets status to the target column’s first mapped status (same behaviour as
  the old stage→default-status rule). Day-one seed uses the shop-floor catalog (Need Material Size →
  Ready to ship); an idempotent startup repair rewrites legacy status keys and upgrades stored
  `board_settings` to document version 2 while preserving unrelated Admin config.

## API

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/auth/config` | whether sign-up is open, which provider is active |
| POST | `/api/auth/login` | email + password → JWT |
| GET | `/api/auth/me` | current user |
| GET | `/api/purchase-orders` | filters: `start`, `end`, `status`, `stage`, `priority`, `owner_id`, `q`; `sort` = `due_asc` \| `due_desc` \| `priority_desc` \| `priority_asc` \| `job`; every row carries `locked` and `comment_count` |
| POST | `/api/purchase-orders` | create — manager and above; `owner_id` assigns it to someone else, an explicit `null` starts it unassigned, and leaving the field out gives it to the creator |
| PATCH | `/api/purchase-orders/{id}` | partial update, logs status / due-date / lock / owner changes; accepts `locked` (any editor may set it, only an admin may clear it), 403 on any change to a locked order from below admin; a **User** may PATCH only `status` / `stage` on an unlocked order (other fields 403); `owner_id` reassigns — omit it to leave the owner alone, send `null` to clear it, and an unknown id is a 400 rather than a dangling reference |
| DELETE | `/api/purchase-orders/{id}` | delete — 403 while the order is `locked` unless admin |
| GET | `/api/purchase-orders/{id}/activity` | audit trail |
| GET | `/api/purchase-orders/{id}/comments` | comment thread, oldest→newest — any signed-in rank; lock does not apply |
| POST | `/api/purchase-orders/{id}/comments` | add a note (`{body}`) — any signed-in rank, including Viewer and on locked orders; empty/whitespace body → 400 plain string; does not write activity or move Modified |
| DELETE | `/api/purchase-orders/{id}/comments/{comment_id}` | remove a note — author or Manager+ (people floor); lock does not block it |
| GET | `/api/users` | the full directory, with `q` and `role` filters — manager and above. Carries email, role and sign-in state, so it sits on the same floor as administering accounts; a filter is not a side door |
| POST | `/api/users` | create an account — admin only; requires an initial 8+ character password |
| GET | `/api/users/{id}` | one person — your own record at any rank, anyone else's at manager and above. Refuses before it looks, so a 403 doesn't reveal whether the id exists |
| GET | `/api/users/{id}/activity` | that person's audit trail — gated exactly like the by-id read |
| GET | `/api/users/orgs` | orgs already in use, for the assignment picker — manager and above, like the rest of the directory |
| GET | `/api/users/assignable` | active people an order may be assigned to — id, name, initials, avatar, role only; manager and above, the same floor as editing an order |
| PATCH | `/api/users/{id}` | change role or org, set password, disable — manager and above, and only on someone strictly below your own rank; anyone may PATCH their own `avatar_url` / `name`; admins are exempt from both restrictions |
| DELETE | `/api/users/{id}` | remove — admin only |
| PATCH | `/api/purchase-orders/{id}` with `{"stage": …}` | move a card between kanban columns |
| POST | `/api/uploads` | multipart image for a purchase order (PNG/JPEG/WebP/GIF, ≤ 8 MB) → `/uploads/…` — manager and above |
| POST | `/api/uploads/avatar` | multipart image, same rules, stored and applied to the caller's own account → updated user; any signed-in rank |
| POST | `/api/uploads/model` | multipart 3D model for a purchase order (OBJ/FBX/STEP/3DM, ≤ 64 MB) → `{url, filename, size, format}` — manager and above. Validated by extension **and** by the file's leading bytes; the declared MIME type is ignored, so a renamed PNG is refused |
| GET | `/api/meta/statuses` | status values, labels and colour tones — from published board settings |
| GET | `/api/meta/stages` | kanban columns and the statuses each contains — from published board settings |
| GET | `/api/meta/priorities` | priority values, labels and colour tones |
| GET | `/api/meta/roles` | the four roles with their labels and ranks, most authority first |
| GET | `/api/settings/board` | published board settings document — any signed-in user |
| PUT | `/api/settings/board` | replace board settings — Admin only; validates unique keys, every status in exactly one kanban column, blocks removing in-use statuses |

Interactive docs: http://localhost:8000/docs

## Auth: prototype now, SSO later

`AUTH_PROVIDER=local` uses email + password with PBKDF2 hashes and HS256 JWTs. Public
self-registration is disabled; only an authenticated Admin can create accounts through the Users
page or `POST /api/users`. Every protected route depends on one function — `get_current_user` in
`backend/app/security.py`. To move to
Entra ID (or Auth0), validate the OIDC token there and map the `email` claim onto a `User` row;
no route or frontend change is required beyond swapping the login page for the provider redirect.

## Schema changes

`Base.metadata.create_all` only creates missing tables, so columns added to a model after the fact
are applied on startup by `backend/app/migrations.py` — an append-only list of `ALTER TABLE … ADD
COLUMN` statements that skip anything already present. Note that `Enum(..., native_enum=False)`
stores the member *name* (`NORMAL`), so defaults in that file are upper case. Anything beyond
adding a defaulted column should move to Alembic. Applied so far: `purchase_orders.priority`,
`purchase_orders.locked`, `purchase_orders.model_url`, `purchase_orders.model_filename`,
`purchase_orders.model_size` and `users.avatar_url`. `purchase_orders.custom_fields` (JSON, nullable)
holds Admin-defined attribute values; the `board_settings` table is created by `create_all` (no
column entry needed). Status values are normalised to lowercase keys on startup.

The same file carries a short `REPAIRS` list of idempotent `UPDATE`s for rewriting stored enum
values. That is how the role change landed: rows written under the old hierarchy hold `PJM` and
`PM`, which the new `Role` enum cannot deserialize at all, so `users.role` is rewritten to
`MANAGER` on startup — before anything reads a `User`. Watch the casing when adding to that list;
these are member names, not values.

Handy one-offs in `backend/tools/`: `prune_users.py`, `set_primary_account.py`, and
`backfill_priorities.py` (spreads priorities over demo POs still sitting at the default).

## Free public demo deployment

`Dockerfile.render` packages Next.js, FastAPI and nginx into one free Render web service. The
browser uses one origin; nginx sends `/api` and `/uploads` to FastAPI and everything else to
Next.js. Use a free Neon Postgres database so order and account data survives Render restarts.

1. Push this repository to GitHub.
2. Create a free Postgres project at https://neon.com and copy its connection string.
3. In https://dashboard.render.com choose **New > Blueprint**, connect the repository and select
   `render.yaml`.
4. Fill the prompted secrets:
   - `DATABASE_URL`: the Neon connection string (generic `postgresql://` URLs are normalized to
     the installed psycopg 3 driver automatically).
   - `BOOTSTRAP_ADMIN_NAME` and `BOOTSTRAP_ADMIN_EMAIL`: the first administrator.
   - `BOOTSTRAP_ADMIN_PASSWORD`: a unique long password.
5. Deploy, open the generated `onrender.com` URL and sign in with those bootstrap credentials.
   The bootstrap values are used only while seeding an empty database.

The free Render filesystem is ephemeral. Database records persist in Neon, but uploaded images
and 3D models disappear whenever the service restarts or redeploys. That is acceptable for a
throwaway demo; durable uploads require object storage or a paid persistent disk. The free service
also sleeps when idle, so the first request can take about a minute.

For production, use durable object storage, a production Postgres plan, SSO, and an always-on
service. Set a custom domain and terminate HTTPS at the hosting platform.
