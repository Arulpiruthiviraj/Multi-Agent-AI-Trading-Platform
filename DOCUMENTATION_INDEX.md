# Documentation Index - Argus Trading Terminal

Index of all documentation, corrected 2026-08-08. Every file listed under "Core Documentation" below was rewritten during this pass after a full source-level audit — each was previously either partially or entirely fictional relative to the actual codebase (invented API routes, invented classes, invented database columns, and in Kronos's case, a fully working feature described where a permanently-broken one exists). See [AI_CONTEXT.md](./AI_CONTEXT.md) for the audit itself.

---

## 📖 Start Here

1. **[README.md](./README.md)** — project overview with an honest real/broken/mocked status table
2. **[AI_CONTEXT.md](./AI_CONTEXT.md)** ⭐ **MASTER REFERENCE** — single source of truth, file:line evidence for every claim
3. **[QUICK_START.md](./QUICK_START.md)** — fast setup path

---

## 🏗️ Architecture & Design

| Doc | Covers |
|---|---|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | High-level component map, real agent roster, known startup gaps |
| [SYSTEM_DESIGN.md](./SYSTEM_DESIGN.md) | Design principles (intent vs. reality), per-component real code |
| [DATA_FLOW.md](./DATA_FLOW.md) | Full payload-level trace through the real pipeline, plus the separate legacy simulation path |
| [EVENTBUS.md](./EVENTBUS.md) | Complete real event catalog, including the two confirmed event-name mismatches |
| [EVENT_FLOW.md](./EVENT_FLOW.md) | Timing/sequencing view — which agent runs on what timer |

---

## 🤖 AI & Agents

| Doc | Covers |
|---|---|
| [AGENTS.md](./AGENTS.md) | Modification guidelines for AI agents working on this repo |
| [AI_AGENTS.md](./AI_AGENTS.md) | Real agent roster with verified status per agent |
| [AI_ROUTER.md](./AI_ROUTER.md) | `AIRouter` implementation detail, including known bugs (fake cost tracking, ignored model overrides, cross-wired env fallback) |

---

## 🔧 Core Systems

| Doc | Covers |
|---|---|
| [BROKER_ENGINE.md](./BROKER_ENGINE.md) | Which of the 5 broker adapters actually work (2 of 5) |
| [RISK_ENGINE.md](./RISK_ENGINE.md) | Real ATR sizing + circuit breakers; what's persisted but not enforced |
| [KRONOS.md](./KRONOS.md) | Exact evidence for why Kronos cannot produce output under any configuration |

---

## 💻 Technical Implementation

| Doc | Covers |
|---|---|
| [API_REFERENCE.md](./API_REFERENCE.md) | Real REST/WebSocket routes, including which frontend-called routes 404 |
| [DATABASE_SCHEMA.md](./DATABASE_SCHEMA.md) | Full real 20-table schema |
| [DATABASE.md](./DATABASE.md) | Design philosophy, backup, performance notes |
| [FRONTEND_GUIDE.md](./FRONTEND_GUIDE.md) | Real component wiring, incl. which panels are mocked and why |

---

## 📋 Configuration & Setup

| Doc | Covers |
|---|---|
| [SETUP.md](./SETUP.md) | Detailed step-by-step setup |
| [CONFIGURATION.md](./CONFIGURATION.md) | Every environment variable actually read by the code |

---

## 🐛 Maintenance & Operations

| Doc | Covers |
|---|---|
| [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) | Real FAQ grounded in the confirmed gaps above |
| [DEBUGGING.md](./DEBUGGING.md) | WebSocket/EventBus/AIRouter debugging technique |
| [DEPLOYMENT.md](./DEPLOYMENT.md) | Real build process + what's missing for production (no CI, no Docker, auth off by default) |

---

## 📊 History & Historical Reports

| Doc | Covers |
|---|---|
| [CHANGELOG.md](./CHANGELOG.md) | Real commit history + this pass's fixes and doc corrections |

The following are **point-in-time audit snapshots from earlier development sessions**, intentionally left as-is rather than rewritten — treat their specific percentages and "Fully Implemented" claims as dated, not current:
- [CODE_AUDIT_REPORT.md](./CODE_AUDIT_REPORT.md)
- [IMPLEMENTATION_AUDIT.md](./IMPLEMENTATION_AUDIT.md)
- [ARGUS_ANALYSIS_REPORT.md](./ARGUS_ANALYSIS_REPORT.md)
- [ARGUS_FINAL_REPORT.md](./ARGUS_FINAL_REPORT.md)
- [FINAL_ANALYSIS.md](./FINAL_ANALYSIS.md)
- [REMEDIATION_PLAN.md](./REMEDIATION_PLAN.md)

For the current, up-to-date equivalent of all of these, use [AI_CONTEXT.md](./AI_CONTEXT.md) instead.

---

## 📚 Reading Paths

### New user
1. [QUICK_START.md](./QUICK_START.md) → 2. [AI_CONTEXT.md](./AI_CONTEXT.md) → 3. [API_REFERENCE.md](./API_REFERENCE.md) → 4. [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)

### AI agent making code changes
1. [AI_CONTEXT.md](./AI_CONTEXT.md) → 2. [AGENTS.md](./AGENTS.md) → 3. [ARCHITECTURE.md](./ARCHITECTURE.md) → 4. [DATA_FLOW.md](./DATA_FLOW.md) → 5. [DATABASE_SCHEMA.md](./DATABASE_SCHEMA.md) → 6. the specific subsystem doc you're touching

### Frontend work
1. [QUICK_START.md](./QUICK_START.md) → 2. [FRONTEND_GUIDE.md](./FRONTEND_GUIDE.md) → 3. [API_REFERENCE.md](./API_REFERENCE.md)

### Backend work
1. [AI_CONTEXT.md](./AI_CONTEXT.md) → 2. [ARCHITECTURE.md](./ARCHITECTURE.md) → 3. [DATABASE_SCHEMA.md](./DATABASE_SCHEMA.md) → 4. [BROKER_ENGINE.md](./BROKER_ENGINE.md) → 5. [RISK_ENGINE.md](./RISK_ENGINE.md) → 6. [EVENTBUS.md](./EVENTBUS.md)

### Deployment / ops
1. [SETUP.md](./SETUP.md) → 2. [CONFIGURATION.md](./CONFIGURATION.md) → 3. [DEPLOYMENT.md](./DEPLOYMENT.md) → 4. [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)

---

## 🔍 "How do I...?" / "What is...?"

| Task or concept | Document |
|---|---|
| Set up the project | [QUICK_START.md](./QUICK_START.md), [SETUP.md](./SETUP.md) |
| Configure AI providers (and know the restart caveat) | [AI_ROUTER.md](./AI_ROUTER.md) |
| Understand real vs. mocked data everywhere | [AI_CONTEXT.md](./AI_CONTEXT.md) |
| Understand why Kronos never predicts anything | [KRONOS.md](./KRONOS.md) |
| Understand why my broker isn't active | [BROKER_ENGINE.md](./BROKER_ENGINE.md) |
| Understand real risk/circuit-breaker math | [RISK_ENGINE.md](./RISK_ENGINE.md) |
| Query the real database | [DATABASE_SCHEMA.md](./DATABASE_SCHEMA.md) |
| Call the real API | [API_REFERENCE.md](./API_REFERENCE.md) |
| Debug the WebSocket/EventBus | [DEBUGGING.md](./DEBUGGING.md), [EVENTBUS.md](./EVENTBUS.md) |
| Deploy to production (and what's missing first) | [DEPLOYMENT.md](./DEPLOYMENT.md) |

---

## 🔄 Keeping these docs accurate going forward

This index and every "Core Documentation" file above were corrected by direct source inspection, not by trusting prior documentation. **If you change code that one of these files describes, update the file in the same change** — this repository has repeatedly drifted into documentation that describes intended behavior instead of shipped behavior, and agents (human or AI) have trusted it at face value and shipped incorrect work as a result. When in doubt, re-verify against the source rather than propagating a doc's claim forward.

---

**Last audited**: 2026-08-08
**Core documentation files**: 21 (all corrected this pass)
**Historical snapshot files**: 6 (intentionally left dated — see above)
