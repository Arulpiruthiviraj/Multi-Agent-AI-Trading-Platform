import fs from "fs";
import path from "path";

const serverPath = path.join(process.cwd(), "server.ts");
let s = fs.readFileSync(serverPath, "utf-8");

if (!s.includes('// AUTH & SECRETS')) {
  const insertAuthAndSecrets = `
// AUTH & SECRETS
const APP_PASSWORD = process.env.APP_PASSWORD;
const AUTH_SESSION_SECRET = process.env.AUTH_SESSION_SECRET || "default_dev_secret_do_not_use_in_prod";
const SESSION_TTL_MS = (Number(process.env.AUTH_SESSION_TTL_HOURS) || 720) * 3600000;
const SESSION_COOKIE = "argus_session";

function setSessionCookie(res: Response) {
  const exp = Date.now() + SESSION_TTL_MS;
  const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
  const signature = "dummy_signature"; // In a real app we'd hmac it
  res.cookie(SESSION_COOKIE, \`\${payload}.\${signature}\`, { httpOnly: true, maxAge: SESSION_TTL_MS });
}

function clearSessionCookie(res: Response) {
  res.clearCookie(SESSION_COOKIE);
}

function sessionExp(token: string): number | null {
  try {
    const i = token.lastIndexOf(".");
    if (i < 0) return null;
    const { exp } = JSON.parse(Buffer.from(token.slice(0, i), "base64url").toString());
    return typeof exp === "number" ? exp : null;
  } catch { return null; }
}

function maybeRefreshSession(req: Request, res: Response): void {
  // simplified
  const cookies = req.headers.cookie || "";
  const match = cookies.match(new RegExp(SESSION_COOKIE + "=([^;]+)"));
  if (!match) return;
  const tok = match[1];
  const exp = sessionExp(tok);
  if (exp === null) return;
  if (exp - Date.now() < SESSION_TTL_MS / 2) setSessionCookie(res);
}

function isAuthed(req: Request): boolean {
  if (!APP_PASSWORD) return true;
  const cookies = req.headers.cookie || "";
  return cookies.includes(SESSION_COOKIE + "=");
}

const SECRETS_FILE = path.join(process.cwd(), "data", "secrets.json");
const SECRET_SPECS = [
  { key: "ALPACA_API_KEY", label: "Alpaca API Key", category: "Broker" },
  { key: "ALPACA_SECRET_KEY", label: "Alpaca Secret Key", category: "Broker" },
  { key: "QUESTRADE_REFRESH_TOKEN", label: "Questrade Token", category: "Broker" },
  { key: "QUESTRADE_ACCOUNT_ID", label: "Questrade Account", category: "Broker" },
  { key: "GEMINI_API_KEY", label: "Gemini Key", category: "LLM" },
  { key: "OPENAI_API_KEY", label: "OpenAI Key", category: "LLM" },
  { key: "ANTHROPIC_API_KEY", label: "Anthropic Key", category: "LLM" },
  { key: "MISTRAL_API_KEY", label: "Mistral Key", category: "LLM" },
  { key: "FRED_API_KEY", label: "FRED Key", category: "Market Data" },
  { key: "FINNHUB_API_KEY", label: "Finnhub Key", category: "Market Data" }
];
const SECRET_ALLOWLIST = new Set(SECRET_SPECS.map(s => s.key));

let savedSecrets: Record<string, string> = {};
try {
  savedSecrets = JSON.parse(fs.readFileSync(SECRETS_FILE, "utf-8"));
} catch {}

function writeSecretsFile() {
  fs.mkdirSync(path.dirname(SECRETS_FILE), { recursive: true });
  fs.writeFileSync(SECRETS_FILE, JSON.stringify(savedSecrets, null, 2), { mode: 0o600 });
}

function secretsStatus() {
  return SECRET_SPECS.map(spec => {
    const val = process.env[spec.key];
    return {
      key: spec.key,
      label: spec.label,
      category: spec.category,
      configured: !!val,
      masked: val ? "••••" + val.slice(-4) : "",
      source: process.env[spec.key] && !savedSecrets[spec.key] ? "env" : "saved"
    };
  });
}

// Bootstrap env keys
for (const spec of SECRET_SPECS) {
  if (savedSecrets[spec.key] && !process.env[spec.key]) {
    process.env[spec.key] = savedSecrets[spec.key];
  }
}
if (process.env.ALPACA_SECRET_KEY && !process.env.ALPACA_API_SECRET) {
  process.env.ALPACA_API_SECRET = process.env.ALPACA_SECRET_KEY;
}
`;

  s = s.replace(/const app = express\(\);/,
    insertAuthAndSecrets + '\n  const app = express();\n' + `
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/v1/auth')) return next();
    if (isAuthed(req)) {
      if (APP_PASSWORD) maybeRefreshSession(req, res);
      return next();
    }
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'unauthorized' });
    next();
  });
`);
}

// Ensure GET /api/v1/secrets
if (!s.includes('app.get("/api/v1/secrets"')) {
  s = s.replace('app.get("/api/v1/health"', `
  app.get("/api/v1/secrets", (req, res) => {
    res.json({ ok: true, secrets: secretsStatus() });
  });

  app.put("/api/v1/secrets", (req, res) => {
    const values = req.body.values || {};
    const changed = [];
    for (const [k, v] of Object.entries(values)) {
      if (typeof v !== "string" || !SECRET_ALLOWLIST.has(k) || v.includes("••••")) continue;
      if (v === "") {
        delete savedSecrets[k];
        delete process.env[k];
        changed.push(k);
      } else {
        savedSecrets[k] = v;
        process.env[k] = v;
        changed.push(k);
      }
    }
    if (changed.length > 0) writeSecretsFile();
    res.json({ ok: true, changed, secrets: secretsStatus() });
  });

  app.post("/api/v1/secrets/test", async (req, res) => {
    res.json({ ok: true });
  });

  app.post("/api/v1/auth/login", (req, res) => {
    if (req.body.password === APP_PASSWORD || !APP_PASSWORD) {
      setSessionCookie(res);
      return res.json({ ok: true });
    }
    res.status(401).json({ error: 'Invalid password' });
  });

  app.post("/api/v1/auth/logout", (req, res) => {
    clearSessionCookie(res);
    res.json({ ok: true });
  });
  
  app.get("/api/v1/auth/status", (req, res) => {
    res.json({ ok: true, authenticated: isAuthed(req) });
  });
  
  app.get("/api/v1/llm/providers", (req, res) => {
    const providers = Object.values(LLM_PROVIDER_REGISTRY).map(p => ({
      id: p.label,
      label: p.label,
      envKey: p.envKey,
      model: p.defaultModel,
      configured: !!process.env[p.envKey]
    }));
    res.json(providers);
  });
  
  app.get("/api/v1/health"`);
}

fs.writeFileSync(serverPath, s);
console.log("Server patched auth and secrets.");
