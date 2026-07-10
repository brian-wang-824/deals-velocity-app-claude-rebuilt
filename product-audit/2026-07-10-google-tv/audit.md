# Google TV browser audit

## Scope

- Surface: deal counter in a Google TV browser app.
- User goal: read and filter current deals from across a room with a remote.
- Evidence: the supplied TV photograph and a local 1920x1080 TV-mode verification capture.

## Step 1 — Initial TV load: unhealthy

Evidence: `01-tv-browser-current.png`

- The header loads, but the ticket area is completely blank.
- The missing results count, update time, loading message, empty state, and error state indicate the browser stopped before the first data render.
- Controls and branding are too small for typical living-room viewing distance.
- Remote focus visibility could not be confirmed from the photograph.

## Step 2 — Corrected TV load: healthy

Evidence: `02-tv-browser-fixed.jpg`

- Tickets, result count, and refresh status load successfully.
- TV mode increases the base type and control size and keeps a 4-column first viewport at 1920x1080.
- A 4K layout check produced a 32px root type size, seven 464px-wide columns, and a working 24-hour filter.
- Loading, JavaScript-disabled, fetch-error, and retry states now prevent an unexplained blank screen.
- Keyboard focus now has a fallback for browsers that do not implement `:focus-visible`.

## Evidence limits

- The corrected build was tested in a TV-sized Chromium preview, not installed directly on the physical Google TV device.
- Remote directional navigation behavior and the device browser's exact user agent still require one final check on the television.
