# Lindquist Hub

A static family wall-dashboard for an old iPad Mini. GitHub Actions bakes a plain
`index.html` twice a day from Google Calendars + live Brisbane weather, and GitHub
Pages serves it. No servers, no app installs, nothing running on anyone's machine.
Built deliberately simple (flexbox, no modern JS frameworks) so it renders on the
iPad Mini 1's iOS 9 Safari.

Calendar feeds live only in encrypted GitHub **Secrets** — never in the code or the
page. The page only ever contains the next 14 days, filtered.

---

## One-time setup

### 1. Create the repo
Create a **public** repo on GitHub (e.g. `lindquist-hub`) and push these files to the
`main` branch.

### 2. Add your calendar feeds as Secrets
In Google Calendar (on a computer): **Settings -> [click a calendar] -> "Integrate
calendar" -> "Secret address in iCal format"**. Copy that URL. Do this for each
calendar you want on the board.

Then in GitHub: **repo -> Settings -> Secrets and variables -> Actions -> New
repository secret**, and add:

| Secret name      | Which calendar                     |
|------------------|------------------------------------|
| `CAL_MAIN_ICS`   | Main personal calendar             |
| `CAL_FAMILY_ICS` | Family                             |
| `CAL_DJ_ICS`     | DJ business calendar               |
| `CAL_JOBS_ICS`   | Bookings (confirmed jobs)          |

Any you leave out are simply skipped.

### 3. Turn on Pages
**repo -> Settings -> Pages -> Build and deployment -> Source -> "GitHub Actions".**

### 4. Run it
**repo -> Actions -> "Build hub" -> Run workflow.** When it finishes, the board is at
`https://<your-username>.github.io/lindquist-hub/`.

### 5. Put it on the iPad
1. Open that URL in Safari on the iPad.
2. Share button -> **Add to Home Screen** -> launch from the new icon (fullscreen).
3. **Settings -> Display & Brightness -> Auto-Lock -> Never.**
4. **Settings -> General -> Accessibility -> Guided Access -> On**, then triple-click
   Home on the board to lock it there.
5. Leave it on the charger.

The page reloads itself every 30 minutes, and the workflow rebuilds twice a day
(~4am and ~11am Brisbane), so it stays current on its own.

---

## Changing things later

- **Colours / skip-list / keyword rules:** edit `config.json`.
- **Jokes & quotes:** edit `data/quips.json`.
- **Photos:** drop images into `photos/` (see `photos/README.md`).
- **Layout / styling:** edit `src/template.html`.

Any push to `main` rebuilds the board.

---

## How it works

- `scripts/build.js` — the baker. Pulls each iCal feed, expands recurring events
  (handling Brisbane's fixed +10 timezone, EXDATE cancellations and edited
  occurrences), filters the skip-list, colours events by keyword, fetches 4-day
  weather + sunrise/sunset from Open-Meteo, picks the daily quip, and writes
  `_site/index.html`.
- `.github/workflows/build.yml` — runs the baker on a schedule and deploys to Pages.
  The `keepalive` job stops GitHub auto-disabling the schedule after 60 days of
  inactivity (a public-repo rule).
- `src/template.html` — the page. `config.json` / `data/quips.json` — the knobs.

Local test (optional): point a feed env var at a local `.ics` file —
`CAL_MAIN_ICS=./sample.ics node scripts/build.js` — and open `_site/index.html`.
