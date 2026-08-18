# Mobile Mission Control — Manual Test Checklist

Test in Chrome DevTools device mode (or a real phone on the same network as the Argus host).

## Viewports

Repeat the checklist at **375px**, **390px**, and **414px** width (iPhone SE, iPhone 14, iPhone 14 Pro Max class widths).

## Preconditions

1. `npm run dev` (or `npm run dev:server-only`) on the host — backend stays on host.
2. Authenticate via the normal login screen.
3. Confirm WebSocket connects (`connected` in mobile header).

## Layout

- [ ] At width < 768px, mobile Mission Control loads automatically after login.
- [ ] **Mobile / Desktop** toggle in the mobile sub-header switches to desktop layout on wide screens.
- [ ] Desktop header **Mobile** button forces mobile layout when viewport ≥ 768px.
- [ ] Touch targets (autobot, kill, tabs, accordion) feel ≥ 44×44px.
- [ ] Content respects safe-area insets on iOS (notch/home indicator) — no controls clipped.

## Data honesty

- [ ] Portfolio shows `--` when `GET /api/v1/portfolio` fails (no invented equity).
- [ ] Quant inspector shows `--` when no `quantAssessment` on latest transaction.
- [ ] Intraday P&L shows unavailable reason text when mission-control reports null realized P&L.

## Supervisory controls (mutating)

- [ ] Autobot toggle calls `POST /api/v1/autobot/toggle` and UI reflects new state.
- [ ] Emergency kill requires **two steps** in bottom sheet, then `POST /api/v1/system/emergency-stop`.

## Resync

- [ ] Pull down at top of scroll → “Release to refresh” → REST refetch + WS force reconnect.
- [ ] Background tab 30s+ → return to tab → WS reconnects (status briefly `connecting` then `connected`).

## Widgets

- [ ] Header: PAPER/LIVE chip, session chip, WS latency ms.
- [ ] Portfolio: equity, cash, budget, intraday P&L, drawdown meter.
- [ ] Positions / Orders segmented control.
- [ ] Consensus card + agent accordion + NO_CONSENSUS badge when applicable.
- [ ] 24-gate monitor summary + accordion ladder.
- [ ] Organic Paper Soak tracker + closed trades list.
- [ ] Health grid + filtered event log (50 cap).

## JSON modals

- [ ] “View full consensus JSON” / trade row tap opens modal with raw API payload.
