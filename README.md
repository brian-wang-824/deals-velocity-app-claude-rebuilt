# Deals Velocity

An independent, experimental dashboard that calculates activity trends for deals appearing on the Slickdeals frontpage. A scheduled data collector maintains a limited rolling history; a dependency-light browser app provides search, posted-time filters, sorting, and pagination.

## Data source and independence

Deal information and community-vote counts originate from [Slickdeals](https://slickdeals.net/) and are transformed here into independently calculated velocity metrics. This project is not affiliated with, endorsed by, sponsored by, or operated by Slickdeals, LLC. “Slickdeals” and related marks belong to their respective owner.

Displayed deal information is time-sensitive, may be incomplete or inaccurate, and should be verified on the linked source and retailer pages before use. This repository does not grant permission to access, reproduce, or redistribute third-party content. Anyone operating or deploying the project is responsible for obtaining any required authorization and complying with applicable website terms, robots instructions, intellectual-property rights, and law.

## How it works

1. `scripts/run_scrape.py` fetches and parses the Slickdeals frontpage.
2. `site/public/data/history.json` retains the latest 48 snapshots (about eight hours at the scheduled cadence).
3. `scraper/velocity.py` calculates vote deltas, recent and lifetime velocity, discounts, and velocity labels.
4. `site/public/data/deals.json` stores the enriched current snapshot consumed by the frontend.
5. Render builds and serves the static files from `site/dist/`.

## Project structure

```text
scraper/                 Parsing and velocity calculations
scripts/run_scrape.py    One-shot scraper entry point
site/public/app.js       Browser application and exported test helpers
site/public/data/        Committed scraper output
site/src/                HTML shell and Tailwind source CSS
site/scripts/            Static build asset copying
site/tests/              Frontend helper tests
tests/                   Python unit and scraper workflow tests
```

## Setup

Requirements: Python 3.12+ and Node.js with npm.

```powershell
python -m pip install -r requirements-scraper.txt
cd site
npm ci
```

## Development

The collection and deployment instructions below assume that the operator has obtained any permission required by the source website. They are not authorization from Slickdeals or any other third party.

Watch and rebuild CSS in `site/public/style.css`:

```powershell
cd site
npm run dev
```

Serve `site/public/` with any local static server. The generated CSS, dependencies, and `site/dist/` are intentionally ignored.

Run one scrape from the repository root:

```powershell
python scripts/run_scrape.py
```

The scraper leaves existing data untouched if no deals are returned and writes successful updates atomically.

## Test and build

```powershell
python -m unittest discover -v
cd site
npm test
npm run build
```

The production build writes minified CSS and required static assets to `site/dist/`. It removes stale build assets and fails if a required source asset is missing.

## Automation and deployment

When enabled by an authorized operator, `.github/workflows/scrape.yml` runs every ten minutes and commits updated `history.json` and `deals.json` files. `render.yaml` configures the Render static site to run `npm install && npm run build`, publish `site/dist`, and disable caching for JSON data.

## Push notifications

The site supports anonymous, per-device Web Push subscriptions for the six heat levels. Render continues to host the static PWA, while Supabase stores subscriptions and sends notifications after each successful scrape.

### Supabase setup

1. Create a Supabase project and install the Supabase CLI.
2. Link the repository and apply `supabase/migrations/202607110001_push_notifications.sql` with `supabase db push`.
3. Generate VAPID keys (for example, `npx web-push generate-vapid-keys`) and deploy the function:

```powershell
supabase secrets set VAPID_PUBLIC_KEY="..." VAPID_PRIVATE_KEY="..." VAPID_SUBJECT="mailto:you@example.com" SCRAPE_DISPATCH_SECRET="..." SITE_ORIGIN="https://your-site.example"
supabase functions deploy notifications --no-verify-jwt
```

Set these Render build environment variables:

- `SUPABASE_NOTIFICATION_FUNCTION_URL=https://PROJECT_REF.supabase.co/functions/v1/notifications`
- `VAPID_PUBLIC_KEY` to the same public VAPID key stored in Supabase.

Set these GitHub Actions repository secrets:

- `SUPABASE_NOTIFICATION_PROCESS_URL=https://PROJECT_REF.supabase.co/functions/v1/notifications/process`
- `SCRAPE_DISPATCH_SECRET` to the same random secret stored in Supabase.

If the GitHub secrets are absent or notification delivery is unavailable, scraping, committing data, and Render deployment continue normally. On iPhone and iPad, Web Push requires installing the site to the Home Screen.
