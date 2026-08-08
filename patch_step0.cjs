const fs = require('fs');
const path = 'src/components/SetupWizard.tsx';
let content = fs.readFileSync(path, 'utf8');

const newStep0 = `
          {wizardMode === 'setup' && step === 0 && (
             <div className="flex flex-col items-center text-center h-full justify-center max-w-2xl mx-auto space-y-6 animate-fade-in">
                <div className="w-20 h-20 rounded-full bg-indigo-500/10 border border-indigo-500/30 flex items-center justify-center shadow-[0_0_30px_rgba(99,102,241,0.2)]">
                  <Shield size={40} className="text-indigo-400" />
                </div>
                <h2 className="text-3xl font-bold text-white uppercase tracking-widest">ARGUS INITIAL SETUP</h2>
                
                <div className="bg-[#111822] border border-slate-800 p-6 rounded-lg w-full mt-4 text-left space-y-6">
                  <div>
                    <h3 className="text-sm font-bold text-emerald-400 uppercase tracking-widest mb-3">Required:</h3>
                    <ul className="space-y-2 text-sm text-slate-300">
                      <li className="flex items-center gap-2"><CheckCircle2 size={16} className="text-emerald-500"/> Local SQLite database</li>
                      <li className="flex items-center gap-2"><CheckCircle2 size={16} className="text-emerald-500"/> Initial trading capital</li>
                      <li className="flex items-center gap-2"><CheckCircle2 size={16} className="text-emerald-500"/> Risk limits</li>
                    </ul>
                  </div>
                  
                  <div className="grid grid-cols-2 gap-6">
                    <div>
                      <h3 className="text-sm font-bold text-indigo-400 uppercase tracking-widest mb-3">AI Providers:</h3>
                      <ul className="space-y-2 text-sm text-slate-300">
                        <li className="flex items-center gap-2"><div className="w-4 h-4 rounded-full border border-slate-500"/> Gemini</li>
                        <li className="flex items-center gap-2"><div className="w-4 h-4 rounded-full border border-slate-500"/> OpenAI</li>
                        <li className="flex items-center gap-2"><div className="w-4 h-4 rounded-full border border-slate-500"/> Claude</li>
                        <li className="flex items-center gap-2"><div className="w-4 h-4 rounded-full border border-slate-500"/> Kimi</li>
                        <li className="flex items-center gap-2"><div className="w-4 h-4 rounded-full border border-slate-500"/> Groq</li>
                        <li className="flex items-center gap-2"><div className="w-4 h-4 rounded-full border border-slate-500"/> OpenRouter</li>
                        <li className="flex items-center gap-2"><div className="w-4 h-4 rounded-full border border-slate-500"/> NVIDIA NIM</li>
                        <li className="flex items-center gap-2"><div className="w-4 h-4 rounded-full border border-slate-500"/> Other providers</li>
                      </ul>
                    </div>
                    <div className="space-y-6">
                      <div>
                        <h3 className="text-sm font-bold text-indigo-400 uppercase tracking-widest mb-3">Market Data:</h3>
                        <ul className="space-y-2 text-sm text-slate-300">
                          <li className="flex items-center gap-2"><div className="w-4 h-4 rounded-full border border-slate-500"/> Alpaca</li>
                          <li className="flex items-center gap-2"><div className="w-4 h-4 rounded-full border border-slate-500"/> Polygon</li>
                          <li className="flex items-center gap-2"><div className="w-4 h-4 rounded-full border border-slate-500"/> Interactive Brokers</li>
                          <li className="flex items-center gap-2"><div className="w-4 h-4 rounded-full border border-slate-500"/> Coinbase</li>
                        </ul>
                      </div>
                      <div>
                        <h3 className="text-sm font-bold text-indigo-400 uppercase tracking-widest mb-3">News:</h3>
                        <ul className="space-y-2 text-sm text-slate-300">
                          <li className="flex items-center gap-2"><div className="w-4 h-4 rounded-full border border-slate-500"/> News API</li>
                          <li className="flex items-center gap-2"><div className="w-4 h-4 rounded-full border border-slate-500"/> Other configured news provider</li>
                        </ul>
                      </div>
                    </div>
                  </div>
                  
                  <p className="text-xs text-slate-500 italic">
                    The user can configure multiple providers. Argus should automatically use every valid provider that the user enables.
                  </p>
                </div>
                
                <div className="flex gap-4 mt-8 pt-4">
                  <button onClick={() => setStep(1)} className="px-8 py-3 rounded bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-sm uppercase tracking-widest transition-colors flex items-center gap-2">
                    Begin Setup <ChevronRight size={16} />
                  </button>
                </div>
             </div>
          )}
`;

content = content.replace(/\{wizardMode === 'setup' && step === 0 && \([\s\S]*?\{wizardMode === 'setup' && step === 1 && \(/, newStep0.trim() + '\n\n          {wizardMode === \'setup\' && step === 1 && (');

fs.writeFileSync(path, content, 'utf8');
console.log('Patched SetupWizard step 0');
