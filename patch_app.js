import fs from "fs";
import path from "path";

const appPath = path.join(process.cwd(), "src", "App.tsx");
let s = fs.readFileSync(appPath, "utf-8");

if (!s.includes('"settings"')) {
  s = s.replace(/\| "documentation"/g, '| "documentation" | "settings"');
  
  // Add the tab button
  s = s.replace('id="tab-documentation-btn"\n            onClick={() => setActiveTab("documentation")}', 'id="tab-documentation-btn"\n            onClick={() => setActiveTab("documentation")}');
  
  const tabButton = `
          <button
            id="tab-settings-btn"
            onClick={() => setActiveTab("settings")}
            className={\`whitespace-nowrap px-4 py-3.5 text-[10px] font-mono font-medium border-b-2 transition-all flex items-center gap-2 \${
              activeTab === "settings"
                ? "border-emerald-500 text-emerald-400 bg-emerald-500/[0.02]"
                : "border-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-800"
            }\`}
          >
            <Settings size={14} />
            API KEYS
          </button>
        </nav>`;
  s = s.replace('        </nav>', tabButton);

  const viewBlock = `
        {activeTab === "settings" && (
          <div className="animate-fade-in flex flex-col gap-6" id="settings-view">
             <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
                <h2 className="text-lg font-bold text-white mb-4 flex items-center gap-2 border-b border-slate-800 pb-4">
                  <Settings size={20} className="text-emerald-400" />
                  API Keys & Integrations
                </h2>
                <div className="space-y-6">
                   <p className="text-sm text-slate-300">
                     Manage your broker, LLM, and market data API keys here.
                   </p>
                </div>
             </div>
          </div>
        )}
      </main>`;
  s = s.replace('      </main>', viewBlock);
}

fs.writeFileSync(appPath, s);
console.log("App patched.");
