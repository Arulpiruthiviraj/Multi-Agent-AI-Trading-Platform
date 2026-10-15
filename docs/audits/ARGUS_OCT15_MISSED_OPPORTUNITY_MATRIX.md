# ARGUS October 15, 2026 - missed-opportunity matrix (first pass)

Status: **FIRST PASS, partly NOT_PROVEN.** Argus side = read-only queries of the production database (`observability_events`, `agent_predictions`, `transaction_traces`, `news_clusters`, `trade_plans`, `settings`), evidence scripts in the session scratch directory (`q40_seed_symbols.cjs`). Market side = IBKR read-only 30-minute bars (regular session) pulled after the close from the connected IBKR data service, plus the owner's press-report percentages (Barron's / Reuters / ChartMill, not re-verified here). **Limits:** 30-minute bars only (no point-in-time bid/ask, no 1-minute bars: `ohlcv_bars` holds none for these symbols), so entry timing, spread and slippage are NOT measured. The matrix classifies where Argus stopped, not whether a trade would have made money. No eventual close is used to define an entry.

Rule applied: Argus buys only; max trade size is **$1,000** (`settings.max_trade_size`), whole shares, max 2 open positions, strategy-authorization and 0.75 / 2-independent-group consensus unchanged.

## 1. Market facts (Oct 15, 30-minute bars, regular hours; prior close = last Oct 14 bar)

| Symbol | Prior close | Day open | First 30-min close | Day close | Gap (open) | Move in first 30 min | Move after 10:00 ET | High |
|---|---|---|---|---|---|---|---|---|
| PAG | 195.11 | 211.65 (the 07:30 ET pre-market bar; RTH opened 211.22) | 211.22-212 | 212.00 | +8.5% pre-market | all of it before 07:30 ET | ~0% | 216.23 (pre-mkt) |
| IP | 32.15 | 32.19 | 33.25 | 34.08 | +0.1% | +3.4% | +2.5% | 34.62 |
| LLY | 1211.57 | 1235.04 | 1258.33 | 1252.39 | +1.9% | +3.9% | -0.5% | 1275.88 |
| UNH | 395.76 | 401.45 | 408.94 | 406.60 | +1.4% | +3.3% | -0.6% | 414.12 |
| AJG | 237.04 | 243.59 | 250.11 | 250.17 | +2.8% | +5.5% | +0.0% | 252.76 |
| CSGP | 30.12 | 30.54 | 31.36 | 31.99 | +1.4% | +4.1% | +2.0% | 32.50 |
| INTU | 310.45 | 314.26 | 328.81 | 330.20 | +1.2% | +5.9% | +0.4% | 332.27 |

Pattern: five of seven were **gap-and-go with 70-100% of the day's move inside the first 30 minutes**. Only **IP** and **CSGP** kept trending after 10:00 ET.

## 2. Argus evidence per symbol (America/New_York)

| Symbol | In Argus universe / scanned | First subscribed | First agent evaluation | Quant | Ideas / rate-limited | Best consensus score | Terminal reasons |
|---|---|---|---|---|---|---|---|
| PAG | **Never** (zero events of any kind) | never | never | none | 0 / 0 | - | - |
| IP | first seen 11:23 ET | 11:23 ET (SUBSCRIPTION_PROMOTED) | 11:25 ET | none | 58 / 19 | 0.51 | CONFIDENCE_BELOW_STRONG 44, no-terminal 14 |
| LLY | all day (premarket 04:03 ET onward) | already active | 04:03 ET | none | 500 / 203 | 0.586 | CONFIDENCE_BELOW_STRONG 307, MODERATE_REJECT_INSUFFICIENT_INDEPENDENCE 1, AGENT_DATA_UNAVAILABLE 3 |
| UNH | all day | already active | 04:03 ET | none | 609 / 179 | 0.51 | CONFIDENCE_BELOW_STRONG 367, MODERATE_REJECT_INSUFFICIENT_INDEPENDENCE 1, AGENT_HOLD 1 |
| AJG | **movers shadow probe only**, first 10:21 ET (gap 2.2%) | never | never | none | 0 / 0 | - | - |
| CSGP | **movers shadow probe only**, first 15:34 ET (gap 3.0%) | never | never | none | 0 / 0 | - | - |
| INTU | all day | already active | 04:03 ET | none | 368 / 217 | 0.59 | CONFIDENCE_BELOW_STRONG 240, AGENT_DATA_UNAVAILABLE 2 |

Agent behaviour on the symbols Argus did evaluate (LLY / UNH / INTU): Kronos SELL-heavy (e.g. UNH SELL 325 vs BUY 110), TechnicalAgent BUY at ~0.59 confidence, MacroAgent HOLD at ~0.0-0.04, JavaFactorComposite BUY at 0.02-0.11, **QuantEngine: no prediction at all** (QuantEngine covered 23 symbols all day versus 188 for Kronos and 471 flagged by discovery). Weighted scores topped out at 0.51-0.59 against the 0.75 bar.

News: **no news cluster mentions PAG, IP, AJG, CSGP or INTU** around the catalysts. `news_clusters` held 339 clusters in ~29 hours, dominated by low-impact (0.5) syndicated articles; the PAG acquisition and the IP buyout-interest reports never entered Argus. This is a verified coverage gap, but a fast-moving wire catalyst alone is not an entry signal.

## 3. Matrix

| SYMBOL | EXTERNAL MOVE | ARGUS ELIGIBLE | FIRST SCANNED | FIRST SUBSCRIBED | FIRST ANALYZED | SIGNAL | CONSENSUS | FIRST BLOCKING STAGE | CLASS | MISSED_VALID_SETUP? |
|---|---|---|---|---|---|---|---|---|---|---|
| PAG | +8.5% gap pre-market, flat in RTH | yes ($212 x 4 shares fits $1,000) | never | never | never | none | none | UNIVERSE (not in curated or broad lists; no wire-news path) | **TOO_LATE_TO_ENTER** (the entire move preceded 07:30 ET; RTH drift ~0%). Discovery/news gap noted, but no tradable RTH setup existed | **No** (nothing left to capture) |
| IP | +6.0% (3.4% in first 30 min, +2.5% after) | yes | 11:23 ET | 11:23 ET | 11:25 ET | TechnicalAgent BUY 0.59, Kronos mixed | 0.51 max | DISCOVERY (1 h 53 min after open) then CONSENSUS | **MISSED_DISCOVERY** (late) then **CORRECTLY_REJECTED**: first idea at ~34.2-34.4 was within ~1% of the day high 34.62 and the stock closed 34.08; only one directional source at 0.59 | **Inconclusive** - a 10:00 ET continuation entry (~33.3) existed in hindsight but Argus had no information that could have identified it |
| LLY | +3.4% | **No - share price $1,235-1,270 exceeds the $1,000 max trade size (whole shares only)** | all day | active | 04:03 ET | Technical BUY 0.59, Kronos SELL-heavy | 0.586 | RISK/SIZING eligibility (never sizeable) | **INELIGIBLE**; also CORRECTLY_REJECTED on consensus | **No** |
| UNH | +2.7% (gap-and-fade after 10:30) | yes (~$410, 2 shares) | all day | active | 04:03 ET | Technical BUY 0.59, Kronos SELL 325 vs BUY 110 | 0.51 | CONSENSUS (confidence) | **CORRECTLY_REJECTED / INSUFFICIENT_PREDICTIVE_EVIDENCE** (after the first 30 min the stock drifted -0.6%) | **No** |
| AJG | +5.5% (entire move in first 30 min) | yes | movers probe 10:21 ET | never | never | none | none | DISCOVERY -> SUBSCRIPTION | **MISSED_DISCOVERY** and **TOO_LATE_TO_ENTER** (flat for the rest of the day) | **No** |
| CSGP | +6.2% (4.1% first 30 min, steady +2.0% grind to 32.50 afterwards) | yes ($32 x 30 shares) | movers probe 15:34 ET | never | never | none | none | DISCOVERY -> SUBSCRIPTION (admitted to movers funnel 6 h after open) | **MISSED_DISCOVERY** | **Plausible, NOT_PROVEN**: a continuation existed after 10:00 ET, but with no 1-minute bars, quotes or Argus signal the entry cannot be defined. Most material candidate for the next iteration |
| INTU | +6.4% (5.9% in first 30 min, then flat) | yes (~$330, 3 shares) | all day | active | 04:03 ET | Technical BUY 0.59, Kronos SELL 247 vs BUY 91 | 0.59 | CONSENSUS (confidence) | **CORRECTLY_REJECTED** and **TOO_LATE_TO_ENTER** after the open gap (gap flagged by the movers probe at 10:21 ET) | **No** |
| MRNA / MCD | not re-priced in this pass | yes | MRNA subscribed 10:39 ET | - | - | Quant 0.979 (single `CORE_QUANT_ENSEMBLE` group) | rejected | CONSENSUS (independence) | see `ARGUS_OCT15_CONSENSUS_FORENSICS_ADDENDUM.md` | not assessed here |

## 4. What this says, and does not say

* **Zero stocks in this set were demonstrably missed because of a software defect.** Two are not tradable by rule or timing (LLY over the trade-size cap; PAG moved pre-market). Three moved almost entirely in the opening 30 minutes (AJG, INTU, UNH), where a system that waits for ~50 ticks / independent agreement cannot be present by design. Two (IP, CSGP) trended after 10:00 ET and were discovered late or never.
* **Verified discovery-latency finding (design limitation, not yet proven a defect):** the movers funnel first flagged AJG and INTU at 10:21 ET (51 minutes after the open) and CSGP at 15:34 ET; `DiscoveryOutcomeTracker` writes only ~500-800 probe rows per hour, so a cap may be limiting coverage (NOT_PROVEN - the cap source was not traced tonight). A movers-flagged symbol never reached the subscription competition (`SUBSCRIPTION_NOT_PROMOTED` 10,456 vs `SUBSCRIPTION_PROMOTED` 711 for the whole day).
* **Verified quant-coverage finding:** QuantEngine evaluated 23 symbols all day. None of the three strongest evaluated names (LLY, UNH, INTU) ever received a Quant opinion, so the only independent evidence group available for them was Technical/Kronos, which disagreed.
* **Verified news-coverage finding:** Argus received no wire-news cluster for the day's acquisition catalysts.
* A 10:00 ET entry in IP or CSGP would only count as a missed opportunity if some information Argus held before that time identified it. No such signal exists in the database.

## 5. Next steps (not done tonight)

1. Pull 1-minute bars and the premarket gap list for the full liquid universe and score recall by an independent oracle (the existing `OpportunityOracle` synthetic harness is the template).
2. Trace why movers-flagged symbols (AJG, INTU, CSGP) were never offered a subscription slot, and what caps the probe write rate.
3. Decide whether QuantEngine coverage (23 symbols) is intended or a scheduling shortfall.
4. Add a wire-news source evaluation (separate task; no code change proposed here).
