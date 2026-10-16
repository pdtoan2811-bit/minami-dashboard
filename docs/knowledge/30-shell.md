# §30 — The app shell and the one map

Part of the [Minami Bento knowledge record](../KNOWLEDGE.md).

## Why it exists

By October 2026 the dashboard had grown a page per use case: Bento, Today, Goals, Automations, Ideas,
Meetings, Agents, Teams, Metrics, Settings. Each page drew its own header. `components/Nav.tsx` was a
hardcoded row of 8 that every new page either joined (it was already full) or skipped (Ideas and
Meetings were reachable only by URL). Half the pages were the dark bento and half were the Today
golden-hour sky, so moving between them felt like switching apps. Thomas called it *chắp vá*
(patchwork) and answered 20 design questions on 2026-10-16. This section is the result.

## The decisions (Thomas's answers, 2026-10-16)

| Question | Answer |
|---|---|
| Front door (`/`) | **Bento**, unchanged, with a **Day strip** on top |
| Nav model | **Work / Day / Autopilot / Library**, with Metrics and Settings in the rail footer |
| Goals + Automations | One **Autopilot** page: goals first, each listing the runners working on it, then Housekeeping |
| Agents + Teams | One **Crew** page: the roster, then the products |
| Meetings | A Library item. The canvas and `/meet` stay launch-only |
| Desktop nav | A **grouped, collapsible left rail**. No ⌘K: he doesn't use it |
| Look | The **Today material everywhere**: ecvision's dark ground, golden-hour sky, glass, Inter, blue accent |
| Inbox | A **global drawer** from a bell, not a page and not a Today section |
| The one badge | Chat questions, plans and held steps · goal-runner asks · failing automations. Team answers are excluded |
| Phone bar | Chats · Today · Autopilot · Ideas · More |
| Projects | A **filter** in the shell, honoured by every page. Not a page level |
| Capture | One **+** in the shell: idea / to-do / goal |
| Links | To-do → chat status · meeting → to-dos and ideas · idea → to-do and Video Studio · goal → its runners |
| Studios | A "send to studio" action only. No rail item |
| Rollout | Big bang, on one worktree branch |
| Done when | Every page has the same shell · any item is ≤2 clicks or taps from home |

## How it works

- **`lib/nav.ts` is the only map.** The rail's groups, the footer, the phone tabs and the list of
  **bare routes** (`/canvas`, `/meet`, `/glance`, `/preview`, `/browser`) are all defined there. A new
  page is one entry in a group. `isActive()` takes `also: [...]`, so old routes that now redirect
  (`/goals`, `/automations`, `/agents`, `/teams`) still light up the right item.
- **`components/shell/AppShell.tsx`** wraps every non-bare page from the root layout. It paints the sky
  once (`Sky` from `app/today/ui.tsx`; `Ground` no longer paints its own). On a desktop it draws a
  **fixed** rail (208px, or 64px collapsed via the `railShut` setting). On a phone (the `compact`
  query) it draws a 48px top strip and a 64px bottom bar.
  - **Fixed rail plus padding, not a flex row with a scrolling `<main>`.** Pages here either scroll the
    document (Today, Ideas, Autopilot) or are an `h-dvh` column (Bento). Both keep working when the
    only change is an inset.
  - **The insets are CSS variables on `<html>`:** `--shell-left`, `--shell-top` and `--shell-bottom`
    (bottom includes the safe area). Bento's height is `calc(100dvh - top - bottom)`, and its phone
    search bar sits at `bottom: var(--shell-bottom)`, above the shell's bar instead of under it.
  - **Fullscreen.** A page calls `useShellFullscreen(on)` to drop the phone strip and bar. Bento does
    this when a topic is open on a phone, because the composer owns the bottom edge. It is a context
    and not a setting because it must reset the moment the page unmounts. A stale "hidden" would
    leave you with no nav.
- **`/api/shell`** returns, in one poll, `needs` (the badge), `day` (the strip) and `projects` (the
  filter's list: the top 12 by messages over 14 days).
  - **Why one route:** the shell is on every tab, and Chrome's six connections per host are already
    contested by pane streams (§3).
  - **Caching:** goals and automations are cached for 60s, because `lib/automations.ts` shells out to
    `launchctl` once per job. Chats are read live.
  - **Client side:** `components/shell/use-shell.ts` keeps a module-level store, so the rail, the
    drawer and the Day strip make one request between them. Hidden tabs don't poll.
- **The drawer** (`components/shell/Drawer.tsx`) lists the needs and then the update log (deploys,
  builds). That log used to be `NotificationBell`'s dropdown, which only existed on Bento.
  - Updates don't raise the count. They show as a dot instead.
  - A chat opens through `useOpenChat()`. On Bento it sends a `minami:open-chat` event, because
    Bento reads `?open=` only at mount. Anywhere else it pushes `/?open=<sid>`.
  - Goals link to `/autopilot#goal-<id>` and failures to `/autopilot#runners`.
- **Capture** (`components/shell/Capture.tsx`):
  - An idea goes to the Ideas drop box (multipart `text`).
  - A to-do goes to `POST /api/today {op:"add"}`.
  - A goal goes to `POST /api/shell {op:"goal"}`, which starts a chat in the vault. That chat drafts
    the ```` ```json goal ```` block and waits for a yes before writing it. A goal is a spec with
    targets, levers and rules, not a line of text, so there is no direct write.
- **The project filter** (`lib/project-filter.ts`) is the `projectFilter` setting.
  - `projectKey()` folds the names each store uses to one form: folder basenames, display names like
    "Minami Dashboard", vault note names, and paths.
  - `matchesProject()` is a one-way prefix match: filtering "ecvision" keeps "ecvisionContent".
  - Every page that hides something because of the filter says so ("Filtered to X · N hidden"), so a
    filtered page never looks broken.
- **The Day strip** (`components/shell/DayStrip.tsx`) sits above the Bento grid on the full board. It
  shows the waiting count (which opens the drawer), the next to-do (→ /today) and one pulse per goal
  (→ its card). It acts on nothing.
- **Look.**
  - Inter is loaded once in the layout but applied by the shell's wrapper, not by `--font-sans`. A
    global font would also restyle the bare routes, and the meeting canvas is customer-facing.
  - **Two blues, not one** (Thomas, 2026-10-16: "too hard to read"). `#346aff` failed both as text on
    the dark ground (4.3:1) and as the fill behind small white labels (4.5:1).
    - `--sakura` is the light blue `#7aa2ff`, for text, rings, dots and tints (7.8:1). The old name was
      kept so ~100 call sites didn't change.
    - `--accent-fill` is `#2a56d6`, for solid fills that carry white text (white on it is 6.2:1).
      `K.accent` in `app/today/ui.tsx` is the same deep blue. Accent text uses `K.accentBright`.
  - `--bento-bg` is transparent, so the sky shows through.

## Things to know

- **"Autopilot" now means two things.** The nav's Autopilot is goals and runners. The older
  `/api/autopilot` and `AutopilotTile` are the **worktree merge runner** (§5f). The names collide;
  they are unrelated.
- Team answers (`TeamButton`) keep their own button on Bento's top-right. Thomas excluded them from
  the one badge.
- Meetings stays light on purpose (see the header comment in `app/meetings/page.tsx`). The shell
  frames it, but its content keeps its own ground.
- The bare routes must never get the shell. The canvas is a client-facing screen share (see the
  CLAUDE.md section on the live canvas), and `/glance` is a 360px cover screen.
