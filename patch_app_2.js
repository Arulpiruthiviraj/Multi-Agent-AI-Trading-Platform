import fs from "fs";
import path from "path";

const appPath = path.join(process.cwd(), "src", "App.tsx");
let s = fs.readFileSync(appPath, "utf-8");

if (!s.includes('const [secrets, setSecrets]')) {
  const states = `
  const [secrets, setSecrets] = useState<any[]>([]);
  const [secretEdits, setSecretEdits] = useState<Record<string, string>>({});
  const [secretsSaving, setSecretsSaving] = useState(false);
  const [secretsMsg, setSecretsMsg] = useState("");
  const [secretTesting, setSecretTesting] = useState(false);

  const fetchSecrets = async () => {
    try {
      const res = await fetch("/api/v1/secrets");
      if (res.ok) {
        const data = await res.json();
        setSecrets(data.secrets || []);
      }
    } catch (e) {}
  };

  const saveSecrets = async () => {
    setSecretsSaving(true);
    try {
      const payload: Record<string, string> = {};
      for (const [k, v] of Object.entries(secretEdits)) {
         if (!v.includes("••••")) payload[k] = v;
      }
      const res = await fetch("/api/v1/secrets", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values: payload })
      });
      if (res.ok) {
        setSecretsMsg("Saved successfully");
        setSecretEdits({});
        fetchSecrets();
        setTimeout(() => setSecretsMsg(""), 3000);
      }
    } catch(e) {}
    setSecretsSaving(false);
  };

  const testSecret = async (target: string) => {
    setSecretTesting(true);
    try {
      await fetch("/api/v1/secrets/test", {
         method: "POST",
         headers: { "Content-Type": "application/json" },
         body: JSON.stringify({ target })
      });
    } catch(e) {}
    setSecretTesting(false);
  };

  useEffect(() => {
    if (activeTab === "settings") {
      fetchSecrets();
    }
  }, [activeTab]);
`;
  s = s.replace(/const \[alpacaConfigured, setAlpacaConfigured\] = useState\(false\);/, 'const [alpacaConfigured, setAlpacaConfigured] = useState(false);\n' + states);
}

const UI = `
                <div className="space-y-6">
                   {secretsMsg && <div className="text-emerald-400 text-xs">{secretsMsg}</div>}
                   {["Broker", "LLM", "Market Data"].map(cat => (
                     <div key={cat} className="space-y-2">
                       <h3 className="text-xs font-mono font-bold text-slate-500 uppercase">{cat}</h3>
                       {secrets.filter(s => s.category === cat).map(sec => (
                         <div key={sec.key} className="flex gap-2 items-center">
                           <span className="w-48 text-xs text-slate-400">{sec.label}</span>
                           <input
                             type="password"
                             className="flex-1 bg-slate-950 border border-slate-800 rounded p-2 text-xs text-slate-200"
                             placeholder={sec.masked || "Empty"}
                             value={secretEdits[sec.key] !== undefined ? secretEdits[sec.key] : ""}
                             onChange={e => setSecretEdits({...secretEdits, [sec.key]: e.target.value})}
                           />
                           <span className="text-[10px] uppercase font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-400">
                             {sec.configured ? "Configured" : "Missing"}
                           </span>
                         </div>
                       ))}
                     </div>
                   ))}
                   <div className="flex gap-4">
                     <button onClick={saveSecrets} disabled={secretsSaving} className="bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 rounded text-xs font-bold font-mono">SAVE</button>
                     <button onClick={() => setSecretEdits({})} className="bg-slate-800 hover:bg-slate-700 text-slate-300 px-4 py-2 rounded text-xs font-bold font-mono">RESET</button>
                   </div>
                   <div className="flex gap-4 border-t border-slate-800 pt-4">
                     <button onClick={() => testSecret('alpaca')} disabled={secretTesting} className="text-indigo-400 border border-indigo-400/30 px-3 py-1 rounded text-xs hover:bg-indigo-400/10">Test Alpaca</button>
                     <button onClick={() => testSecret('llm')} disabled={secretTesting} className="text-blue-400 border border-blue-400/30 px-3 py-1 rounded text-xs hover:bg-blue-400/10">Test LLM</button>
                   </div>
                </div>
`;
s = s.replace(/<p className="text-sm text-slate-300">[\s\S]*?<\/p>/, UI);

fs.writeFileSync(appPath, s);
console.log("App patched with full API Key logic.");
