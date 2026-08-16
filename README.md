# Argus

Node.js multi-agent trading terminal (Express + Vite + `ws` + SQLite).

**Docs:** [docs/ARGUS.md](docs/ARGUS.md) · [docs/ARGUS_REFERENCE.md](docs/ARGUS_REFERENCE.md) · [docs/LOCAL_AI_SETUP.md](docs/LOCAL_AI_SETUP.md)

**Agents:** root `CLAUDE.md` is the live-path contract. LIVE real-money is **NO-GO**.

```bash
cp .env.example .env   # add keys
npm run dev            # :3000 + optional Chronos/Ollama/OpenAlice/IBKR
npm test
```

`PORT` is not read; the server listens on **3000**.
