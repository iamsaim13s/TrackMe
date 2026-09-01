# 100-Day Tracker Wallpaper

Generates a daily iPhone 12 Pro lock-screen wallpaper (1170×2532) showing a
10×10 dot grid. One dot fills in per day, starting from `startDate` in
[config.json](config.json). Runs entirely free on GitHub's infrastructure —
no server, no app, no paid tier.

**Pipeline:** GitHub Actions (cron, daily) → generates PNG → GitHub Pages
(free static hosting, stable URL) → iOS Shortcuts Automation (daily, on
your phone) → downloads the PNG → sets it as wallpaper.

---

## 1. One-time setup

### a) Push this repo to GitHub

```bash
cd 100-day-tracker
git init
git add .
git commit -m "Initial commit: 100-day tracker wallpaper generator"
gh repo create 100-day-tracker --public --source=. --remote=origin --push
```

(No `gh` CLI? Create an empty repo on github.com, then `git remote add origin <url>` and `git push -u origin main`.)

The repo must be **public** for GitHub Pages to serve it on the free plan
(private repos need GitHub Pro/Team for Pages).

### b) Enable GitHub Pages

In the repo on github.com: **Settings → Pages → Build and deployment → Source: "GitHub Actions"**.
(Not "Deploy from a branch" — the workflow uses the newer Pages Actions deployment.)

### c) Run the workflow once manually

**Actions tab → "Generate daily wallpaper" → Run workflow.**
This does the first generate + deploy so Pages has content immediately,
rather than waiting for tomorrow's cron.

### d) Find your Pages URL

After the first successful run, it's shown in the workflow's `deploy` job
output, and also at **Settings → Pages**. It looks like:

```
https://<your-github-username>.github.io/100-day-tracker/
```

Your daily wallpaper is always at:

```
https://<your-github-username>.github.io/100-day-tracker/wallpaper.png
```

This exact URL is overwritten in place every day — that's the URL the
Shortcut will always fetch.

---

## 2. iOS Shortcut setup (on your iPhone)

### a) Create the Shortcut

1. Open **Shortcuts** app → **+** (new shortcut).
2. Add action **"Get Contents of URL"** → paste your `wallpaper.png` URL
   from above.
3. Add action **"Set Wallpaper"** (search "wallpaper" in the action
   picker) → set its input to the output of the previous step ("Contents
   of URL"). Choose whether to apply it to Lock Screen, Home Screen, or
   both, and turn **off** "Show Preview" so it applies silently.
4. Name the shortcut, e.g. **"Update Tracker Wallpaper"**.
5. Run it once manually to confirm it downloads and sets the image.

> Tip: append `?t=` and nothing else doesn't bust cache reliably on iOS.
> If you ever see a stale image, add a cache-buster query param in step 2,
> e.g. `.../wallpaper.png?nocache=1`, and rely on "Get Contents of URL"'s
> own fresh fetch (it doesn't cache by default, so normally this isn't needed).

### b) Automate it to run daily

1. In Shortcuts app → **Automation** tab → **+** → **Create Personal Automation**.
2. Choose **Time of Day** → set a time slightly *after* your GitHub
   Actions cron run (see step 3 below on timing) → **Daily**.
3. Add action: **Run Shortcut** → select "Update Tracker Wallpaper".
4. **Turn OFF "Ask Before Running"** — otherwise iOS will prompt you
   every day instead of running silently.
5. Save.

iOS may still occasionally ask for one-time confirmation the first few
times a Time-of-Day automation runs a network action — that's normal iOS
behavior for unattended automations, not a bug in this setup.

---

## 3. Timing: keep the cron and the automation in sync

- The GitHub Actions cron in [.github/workflows/daily-wallpaper.yml](.github/workflows/daily-wallpaper.yml)
  runs at **06:00 UTC** by default. Convert that to your local time, or
  edit the cron line to run right after your local midnight (GitHub
  Actions cron schedules are always UTC).
- Set your iPhone automation to fire **20–30 minutes after** that, to
  safely account for GitHub Actions' queue/start delay (free-tier
  scheduled workflows aren't always instant, occasionally a few minutes
  late).

---

## 4. Customizing

Edit [config.json](config.json):

| Field | Meaning |
|---|---|
| `startDate` | Day 1 of the tracker (`YYYY-MM-DD`) |
| `totalDays` | Total dots / days to track (default 100) |
| `grid.cols` / `grid.rows` | Grid dimensions (default 10×10) |
| `colors.*` | Background / filled / unfilled dot colors |
| `dot.diameter`, `dot.gapX`, `dot.gapY` | Dot size and spacing — grid auto-centers |
| `showDayCounterText` | Set `true` to show "Day N / 100" text below the grid |

After editing, commit and push — tomorrow's run picks up the new config
automatically. To regenerate immediately, re-run the workflow manually
(Actions tab → Run workflow) or run locally:

```bash
npm install
npm run generate
```

Test a specific date without waiting for real time to pass:

```bash
node scripts/generate.js --date=2026-09-15
```

---

## 5. How day-counting works

`scripts/generate.js` computes whole UTC days elapsed between `startDate`
and the current UTC date, so "Day 1" = `startDate` itself (1 dot filled),
and the grid fills 1 dot/day up to 100, then stays fully filled
thereafter. See [status.json](docs/status.json) (regenerated daily) for
the current day count and completion status.

---

## 6. Cost

Everything here runs on free tiers:
- **GitHub Actions**: public repos get unlimited free minutes for
  standard runners; this job takes seconds/day.
- **GitHub Pages**: free static hosting for public repos.
- **iOS Shortcuts**: built into iOS, no cost.

No accounts, API keys, or paid services required.
