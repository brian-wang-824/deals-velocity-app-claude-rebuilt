const REFRESH_INTERVAL_MINUTES = 10;
const PAGE_SIZE = 25;
const POLL_FOR_NEW_DATA_MS = 60000; // check for a fresh deals.json every minute
const POSTED_WINDOW_HOURS = {
  "3h": 3,
  "6h": 6,
  "9h": 9,
  "12h": 12,
  "24h": 24,
};
const LOCAL_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const POST_TIME_FORMAT_OPTIONS = {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
};
if (LOCAL_TIME_ZONE) POST_TIME_FORMAT_OPTIONS.timeZone = LOCAL_TIME_ZONE;
const POST_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, POST_TIME_FORMAT_OPTIONS);
const HAS_DOCUMENT = typeof document !== "undefined";

let allDeals = [];
let scrapedAtIso = null;
let currentPage = 1;
let countdownTimer = null;

const els = HAS_DOCUMENT
  ? {
      search: document.getElementById("search"),
      sort: document.getElementById("sort"),
      postedWindow: document.getElementById("posted-window"),
      dealsList: document.getElementById("deals-list"),
      pagination: document.getElementById("pagination"),
      resultsMeta: document.getElementById("results-meta"),
      lastUpdated: document.getElementById("last-updated"),
      nextRefresh: document.getElementById("next-refresh"),
    }
  : {};

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : str;
  return div.innerHTML;
}

function formatRelativeTime(iso) {
  if (!iso) return "unknown";
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m ago`;
}

function getPostTimeMs(iso) {
  if (!iso) return Number.NEGATIVE_INFINITY;
  const time = Date.parse(iso);
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

function formatPostTime(iso) {
  const time = getPostTimeMs(iso);
  if (time === Number.NEGATIVE_INFINITY) return "unknown";
  return POST_TIME_FORMATTER.format(new Date(time));
}

function sortDealsByNewest(deals) {
  return deals
    .map((deal, index) => ({ deal, index }))
    .sort((a, b) => {
      const aTime = getPostTimeMs(a.deal.posted_time);
      const bTime = getPostTimeMs(b.deal.posted_time);
      if (aTime !== bTime) return bTime - aTime;
      return a.index - b.index;
    })
    .map(({ deal }) => deal);
}

function filterDealsByPostedWindow(deals, windowKey = "12h", nowMs = Date.now()) {
  const hours = Object.prototype.hasOwnProperty.call(POSTED_WINDOW_HOURS, windowKey)
    ? POSTED_WINDOW_HOURS[windowKey]
    : POSTED_WINDOW_HOURS["12h"];

  const cutoff = nowMs - hours * 60 * 60 * 1000;
  return deals.filter((deal) => {
    const postedMs = getPostTimeMs(deal.posted_time);
    return postedMs !== Number.NEGATIVE_INFINITY && postedMs >= cutoff && postedMs <= nowMs;
  });
}

function formatDiscount(value) {
  if (value == null || Number.isNaN(Number(value)) || Number(value) <= 0) return "";
  return `-${Math.round(Number(value))}%`;
}

function classifyPrice(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return { kind: "missing", label: "Price", value: "See deal" };
  }

  const isCurrencyPrice = /^(?:(?:from|starting at)\s+)?\$\s*\d|^\d+\s+for\s+\$\s*\d/i.test(
    normalized,
  );
  return {
    kind: isCurrencyPrice ? "price" : "offer",
    label: isCurrencyPrice ? "Price" : "Offer",
    value: normalized,
  };
}

function getDealCondition(deal) {
  const title = String((deal && deal.title) || "").trim();
  const price = String((deal && deal.price) || "").trim();
  const conditions = [];
  const titlePrefix = title.includes(":") ? title.split(":", 1)[0].trim() : "";

  if (
    titlePrefix &&
    /\b(?:accounts?|accts?|members?|membership|customers?|coupon|stores?|in[ -]?stores?|epp|edu)\b/i.test(
      titlePrefix,
    )
  ) {
    conditions.push(titlePrefix);
  }

  const purchaseMatch = price.match(/(?:free\s+)?w\/\s*(\$[\d,.]+\+?)\s+purchase/i);
  if (purchaseMatch) {
    conditions.push(`Requires ${purchaseMatch[1]} purchase`);
  }

  return Array.from(new Set(conditions)).join("; ");
}

function formatDelta(value) {
  if (value == null || Number.isNaN(Number(value))) return "pending";
  const amount = Number(value);
  if (amount > 0) return `+${amount}`;
  return `${amount}`;
}

function renderTallyDelta(d) {
  const hasDelta = d.vote_delta != null && !Number.isNaN(Number(d.vote_delta));
  const label = hasDelta
    ? `${formatDelta(d.vote_delta)} tallies since last count`
    : "pending next count";

  return `<span class="ticket-rate">${label}</span>`;
}

function renderVelocityStamp(label) {
  if (label === "inferno") {
    return `<span class="badge-stamp badge-inferno" aria-label="Inferno velocity">&#x1F525;&#x1F525; INFERNO</span>`;
  }
  if (label === "on fire") {
    return `<span class="badge-stamp badge-on-fire" aria-label="On fire velocity">&#x1F525; ON FIRE</span>`;
  }
  if (label === "blazing") {
    return `<span class="badge-stamp badge-blazing">BLAZING</span>`;
  }
  if (label === "surging") {
    return `<span class="badge-stamp badge-surging">SURGING</span>`;
  }
  if (label === "hot") {
    return `<span class="badge-stamp badge-hot">HOT</span>`;
  }
  if (label === "warming") {
    return `<span class="badge-stamp badge-warming">WARMING</span>`;
  }
  return "";
}

function renderDealStamp(d) {
  return renderVelocityStamp(d.velocity_label);
}

function renderPriceLine(d, discount) {
  const display = classifyPrice(d.price);
  const currentPrice = escapeHtml(display.value);
  const referencePrice = display.kind === "price" && d.original_price
    ? escapeHtml(d.original_price)
    : "";
  const condition = renderConditionLine(d);

  return `
    <div class="ticket-price-row ticket-price-row-${display.kind}">
      ${display.kind === "offer" ? '<span class="ticket-offer-label">Offer</span>' : ""}
      <span class="ticket-price">${currentPrice}</span>
      ${referencePrice ? `<span class="ticket-reference-price">${referencePrice}</span>` : ""}
      ${display.kind === "price" && discount ? `<span class="ticket-discount">${discount}</span>` : ""}
      ${condition}
    </div>`;
}

function renderConditionLine(d) {
  const condition = getDealCondition(d);
  if (!condition) return "";
  return `<span class="ticket-condition"><span class="sr-only">Condition: </span>${escapeHtml(condition)}</span>`;
}

function renderPostedTime(d) {
  const formatted = formatPostTime(d.posted_time);
  if (formatted === "unknown") {
    return "posted unknown";
  }

  return `<time datetime="${escapeHtml(d.posted_time)}">${escapeHtml(formatted)}</time>`;
}

function renderVoteMetric(d) {
  const votes = Number.isFinite(Number(d.votes)) ? Number(d.votes) : 0;
  return `<span class="tally" aria-label="${votes} votes">
    <svg viewBox="0 0 20 14" aria-hidden="true">
      <g fill="none" stroke="currentColor" stroke-width="1.6">
        <line x1="2" y1="2" x2="2" y2="12" />
        <line x1="6" y1="2" x2="6" y2="12" />
        <line x1="10" y1="2" x2="10" y2="12" />
        <line x1="14" y1="2" x2="14" y2="12" />
        <line x1="1" y1="12" x2="15" y2="1" />
      </g>
    </svg>
    ${votes}
  </span>`;
}

function applyFiltersAndSort() {
  const q = els.search.value.trim().toLowerCase();
  const sort = els.sort.value;
  const postedWindow = els.postedWindow.value;

  let filtered = filterDealsByPostedWindow(allDeals, postedWindow);
  if (q) {
    filtered = filtered.filter(
      (d) => d.title.toLowerCase().includes(q) || (d.store || "").toLowerCase().includes(q)
    );
  }
  let sorted = [...filtered];
  if (sort === "votes") sorted.sort((a, b) => b.votes - a.votes);
  else if (sort === "posted") sorted = sortDealsByNewest(filtered);
  // "velocity" (default) keeps the server-computed order from deals.json

  return sorted;
}

function renderDeals() {
  const filtered = applyFiltersAndSort();
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  currentPage = Math.min(currentPage, totalPages);
  const start = (currentPage - 1) * PAGE_SIZE;
  const pageItems = filtered.slice(start, start + PAGE_SIZE);
  const end = Math.min(start + pageItems.length, filtered.length);

  els.resultsMeta.textContent = filtered.length
    ? `Showing ${start + 1}-${end} of ${filtered.length} tickets`
    : "No tickets match that search yet";

  if (pageItems.length === 0) {
    els.dealsList.innerHTML = `<p class="ticket-state">No tickets match that search yet.</p>`;
  } else {
    els.dealsList.innerHTML = pageItems.map(renderDealCard).join("");
  }

  els.dealsList.setAttribute("aria-busy", "false");

  renderPagination(totalPages);
}

function renderDealCard(d) {
  const discount = formatDiscount(d.discount_percentage);

  return `
    <article class="ticket">
      ${renderDealStamp(d)}
      <div class="ticket-tear" aria-hidden="true"></div>
      <div class="ticket-photo">
        <img src="${escapeHtml(d.image_url || "")}" alt="" loading="lazy" />
      </div>
      <div class="ticket-body">
        <a href="${escapeHtml(d.url)}" target="_blank" rel="noopener" class="ticket-name">
          ${escapeHtml(d.title)}
        </a>
        ${renderPriceLine(d, discount)}
        <div class="ticket-foot">
          <div class="ticket-meta-row">
            <span class="ticket-source">${escapeHtml(d.store || "Unknown store")} · ${renderPostedTime(d)}</span>
            ${renderVoteMetric(d)}
          </div>
          <div class="ticket-rate-row">
            ${renderTallyDelta(d)}
          </div>
        </div>
      </div>
    </article>`;
}

function renderPagination(totalPages) {
  if (totalPages <= 1) {
    els.pagination.innerHTML = "";
    return;
  }
  const buttons = [
    `<button data-page="${currentPage - 1}" class="pagination-button pagination-direction" ${
      currentPage === 1 ? "disabled" : ""
    } aria-label="Previous page">Previous</button>`,
  ];
  for (let p = 1; p <= totalPages; p++) {
    buttons.push(
      `<button data-page="${p}" class="pagination-button" ${
        p === currentPage ? 'aria-current="page"' : ""
      } aria-label="Page ${p}">${p}</button>`
    );
  }
  buttons.push(
    `<button data-page="${currentPage + 1}" class="pagination-button pagination-direction" ${
      currentPage === totalPages ? "disabled" : ""
    } aria-label="Next page">Next</button>`,
  );
  els.pagination.innerHTML = buttons.join("");
  els.pagination.querySelectorAll("button:not(:disabled)").forEach((btn) => {
    btn.addEventListener("click", () => {
      currentPage = Number(btn.dataset.page);
      renderDeals();
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
    });
  });
}

function renderCountdown() {
  if (!scrapedAtIso) return;
  const nextRefresh = new Date(new Date(scrapedAtIso).getTime() + REFRESH_INTERVAL_MINUTES * 60000);

  clearInterval(countdownTimer);
  function tick() {
    const msLeft = nextRefresh - Date.now();
    els.lastUpdated.textContent = `● Counter updated ${formatRelativeTime(scrapedAtIso)}`;
    if (msLeft <= 0) {
      els.nextRefresh.textContent = "Counting again shortly…";
      return;
    }
    const mins = Math.floor(msLeft / 60000);
    const secs = Math.floor((msLeft % 60000) / 1000);
    els.nextRefresh.textContent = `Next count in ${mins}m ${secs}s`;
  }
  tick();
  countdownTimer = setInterval(tick, 1000);
}

async function loadDeals(options) {
  const silent = Boolean(options && options.silent);
  try {
    const res = await fetch(`/data/deals.json?ts=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const isNewSnapshot = data.scraped_at !== scrapedAtIso;
    allDeals = data.deals || [];
    scrapedAtIso = data.scraped_at;

    if (!silent || isNewSnapshot) {
      renderDeals();
    }
    renderCountdown();
  } catch (err) {
    if (!silent) {
      els.resultsMeta.textContent = "Counter unavailable";
      els.dealsList.setAttribute("aria-busy", "false");
      els.dealsList.innerHTML = `<div class="ticket-state ticket-state-error" role="alert">
        <p>Couldn't pull the latest tickets.</p>
        <button type="button" class="retry-button">Try again</button>
      </div>`;
      const retryButton = els.dealsList.querySelector(".retry-button");
      if (retryButton) retryButton.addEventListener("click", () => loadDeals());
    }
    console.error("Failed to load deals.json", err);
  }
}

if (HAS_DOCUMENT) {
  els.search.addEventListener("input", () => {
    currentPage = 1;
    renderDeals();
  });
  els.sort.addEventListener("change", () => {
    currentPage = 1;
    renderDeals();
  });
  els.postedWindow.addEventListener("change", () => {
    currentPage = 1;
    renderDeals();
  });

  loadDeals();
  setInterval(() => loadDeals({ silent: true }), POLL_FOR_NEW_DATA_MS);
}

if (typeof module !== "undefined") {
  module.exports = {
    classifyPrice,
    formatDelta,
    formatDiscount,
    formatPostTime,
    filterDealsByPostedWindow,
    getDealCondition,
    getPostTimeMs,
    renderDealStamp,
    renderTallyDelta,
    renderVelocityStamp,
    sortDealsByNewest,
  };
}
