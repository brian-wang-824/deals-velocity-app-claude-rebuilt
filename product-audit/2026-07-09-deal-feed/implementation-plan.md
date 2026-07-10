# Deals Velocity recommended-change plan

Date: 2026-07-09  
Source: UX and accessibility audit of the captured deal-feed browse state  
Primary goal: Help users identify a worthwhile deal quickly, understand why it is trending, and open it confidently.

## Delivery strategy

Implement the work in three small releases. Each release should leave the feed usable and testable; avoid combining the information-model, layout, and refresh-behavior changes into one large rewrite.

## Release 1 - Clarify the card information model

Priority: P0  
Primary files: `site/public/app.js`, `site/tests/app-helpers.test.js`

1. Replace internal shorthand with plain language.
   - Rename `Sort: Pace` to `Sort: Trending speed`.
   - Replace the `PACE` row with one momentum line such as `30.1 votes/hr - up 5 since last count`.
   - Render the tally as `20 votes`; keep the tally mark only as supporting decoration.
   - Explain thresholds near the sort control: `Surging: 12+ votes/hr` and `Hot: 6-11.9 votes/hr`.
2. Give every card the same reading order:
   - Product title.
   - Current price and discount.
   - Offer conditions, when applicable.
   - Store and posted time.
   - Momentum and total votes.
3. Normalize unlike offer types.
   - Add a pure helper that distinguishes currency prices from offer copy such as `Extra 10% Off`.
   - Show non-currency values under an `Offer` label instead of treating them as a normal price.
   - Keep account, membership, coupon, or store restrictions in a dedicated condition line when the available source text exposes them.
4. Strengthen the destination affordance.
   - Keep one semantic deal link per card.
   - Add visible `View deal` copy or make the title treatment unmistakably interactive.
   - If links continue opening a new tab, expose that behavior visually and in the accessible name.

Acceptance criteria:

- A new user can interpret votes, vote change, and votes per hour without a legend hidden elsewhere.
- `HOT` and `SURGING` have visible definitions that match `scraper/velocity.py`.
- Direct prices and percentage/coupon offers no longer occupy the same unlabeled slot.
- Unit tests cover momentum formatting, missing data, non-currency offers, and threshold labels.

## Release 2 - Improve scanability and responsive layout

Priority: P0  
Primary file: `site/src/input.css`

1. Reduce column density.
   - Keep one column below 40rem and two columns from 40rem.
   - Use three columns from 64rem, four from 80rem, and reserve five columns for approximately 96rem and wider.
   - Treat roughly 14rem/224 CSS px as the minimum practical card width.
2. Raise the typography floor.
   - Product title: approximately 0.95-1rem with a three-line allowance where needed.
   - Merchant, time, votes, and momentum: at least 0.75rem with comfortable line height.
   - Preserve price emphasis; de-emphasize the original struck price.
3. Simplify decoration without losing the ticket identity.
   - Keep the torn top edge and one status stamp.
   - Reduce repeated dashed separators and competing red/orange accents.
   - Align current price, original price, and discount on a stable baseline.
4. Normalize product imagery.
   - Keep a consistent image-stage aspect ratio and safe area.
   - Verify small or pale objects remain identifiable against white.
5. Increase interactive targets.
   - Header controls and pagination should be at least 44 CSS px high where practical.
   - Add Previous/Next pagination controls and retain the strong current-page treatment.

Acceptance criteria:

- The captured desktop state renders four columns, not five.
- No card is narrower than the agreed minimum at supported desktop breakpoints.
- The page reflows at 320 CSS px and at 200% zoom without horizontal scrolling or overlapping controls.
- Titles, metadata, and momentum remain readable without removing the ticket visual language.

## Release 3 - Accessibility and stable live updates

Priority: P0  
Primary files: `site/src/index.html`, `site/src/input.css`, `site/public/app.js`

1. Add persistent labels and instructions.
   - Give Search a visible compact label; keep the programmatic `<label>` association.
   - Ensure posted-window and sort controls retain explicit accessible names.
   - Add a short, keyboard-accessible explanation of trending speed.
2. Verify color and focus.
   - Measure all normal text at 4.5:1 or better and meaningful component boundaries/focus indicators at 3:1 or better.
   - Adjust muted paper text before changing the brand colors.
   - Verify the existing focus outline is visible and not clipped on every control and deal link.
3. Replace automatic result replacement with a user-controlled refresh.
   - Continue polling in the background.
   - When a new snapshot arrives, retain the current DOM and show `New deals available` with an Apply/Refresh button.
   - Apply the snapshot only after user action; preserve the query, time window, sort, page, and keyboard position where possible.
4. Verify semantics.
   - Keep each card as an article with one clearly named destination link.
   - Confirm heading order, results-list reading order, image treatment, `aria-current` pagination, and empty/error status messages.

Acceptance criteria:

- A complete keyboard sweep works in logical order with visible focus.
- Background polling never removes focus or silently reorders visible cards.
- Automated and manual contrast checks pass the defined WCAG 2.2 AA targets.

## Verification matrix

Run after every release:

- `npm test` from `site/`.
- `npm run build` from `site/`.
- Existing Python test suite for scraper and velocity regressions.
- Visual checks at 375, 768, 1024, 1280, and 1536 CSS px.
- Keyboard-only sweep: search, time window, sort, deal links, refresh action, and pagination.
- 200% text zoom and 400% browser zoom/320 CSS px reflow.
- Contrast measurement for muted card metadata, header status, placeholders, badges, controls, and focus indicators.
- Reduced-motion check and refresh behavior while focus is inside a deal card.

## Suggested implementation order

1. Add pure formatting helpers and tests.
2. Update card markup and plain-language labels.
3. Rework grid breakpoints and typography.
4. Add visible labels, target-size, contrast, and focus adjustments.
5. Introduce the pending-snapshot refresh pattern.
6. Run the full verification matrix and capture the same audit viewport for comparison.
