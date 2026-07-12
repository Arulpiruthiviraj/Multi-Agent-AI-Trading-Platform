import re

with open('src/components/DocumentationTab.tsx', 'r') as f:
    content = f.read()

# The engines are inside the `<div className="space-y-4">` that follows `// QUANT ENGINES`
replacement = """          <div className="space-y-4">
            <div className="bg-[#111822] border-l-2 border-emerald-500 p-4 rounded-r-lg group hover:bg-[#151c28] transition-colors">
              <h3 className="text-emerald-400 font-bold mb-2 flex items-center gap-2"><TrendingUp size={16}/> Trend Engine</h3>
              <p className="text-slate-300 text-xs mb-3">Identifies the overarching direction of the market (up, down, or sideways).</p>
            </div>

            <div className="bg-[#111822] border-l-2 border-indigo-500 p-4 rounded-r-lg group hover:bg-[#151c28] transition-colors">
              <h3 className="text-indigo-400 font-bold mb-2 flex items-center gap-2"><Activity size={16}/> Momentum Engine</h3>
              <p className="text-slate-300 text-xs mb-3">Measures the speed and strength of price changes using indicators like RSI and MACD.</p>
            </div>

            <div className="bg-[#111822] border-l-2 border-sky-500 p-4 rounded-r-lg group hover:bg-[#151c28] transition-colors">
              <h3 className="text-sky-400 font-bold mb-2 flex items-center gap-2"><BarChart3 size={16}/> Volume & Smart Money Engine</h3>
              <p className="text-slate-300 text-xs mb-3">Analyzes how much of the stock is being traded and detects large institutional block trades.</p>
            </div>

            <div className="bg-[#111822] border-l-2 border-purple-500 p-4 rounded-r-lg group hover:bg-[#151c28] transition-colors">
              <h3 className="text-purple-400 font-bold mb-2 flex items-center gap-2"><Zap size={16}/> Volatility Engine</h3>
              <p className="text-slate-300 text-xs mb-3">Measures how wild the price swings are. Uses Average True Range (ATR) and Bollinger Bands.</p>
            </div>
            
            <div className="bg-[#111822] border-l-2 border-orange-500 p-4 rounded-r-lg group hover:bg-[#151c28] transition-colors">
              <h3 className="text-orange-400 font-bold mb-2 flex items-center gap-2"><Layers size={16}/> Market Structure & Fibonacci Engine</h3>
              <p className="text-slate-300 text-xs mb-3">Identifies Support/Resistance levels and Fibonacci retracements where price historically bounces or rejects.</p>
            </div>
            
            <div className="bg-[#111822] border-l-2 border-rose-500 p-4 rounded-r-lg group hover:bg-[#151c28] transition-colors">
              <h3 className="text-rose-400 font-bold mb-2 flex items-center gap-2"><BookOpen size={16}/> Candlestick & Chart Pattern Engine</h3>
              <p className="text-slate-300 text-xs mb-3">Uses computer vision and heuristics to identify Head and Shoulders, Bull Flags, and Doji candle formations.</p>
            </div>
            
            <div className="bg-[#111822] border-l-2 border-yellow-500 p-4 rounded-r-lg group hover:bg-[#151c28] transition-colors">
              <h3 className="text-yellow-400 font-bold mb-2 flex items-center gap-2"><Target size={16}/> Options Engine</h3>
              <p className="text-slate-300 text-xs mb-3">Scans the options chain for Gamma Squeezes, unusual put/call ratios, and max pain price points.</p>
            </div>

            <div className="bg-[#111822] border-l-2 border-cyan-500 p-4 rounded-r-lg group hover:bg-[#151c28] transition-colors">
              <h3 className="text-cyan-400 font-bold mb-2 flex items-center gap-2"><Bot size={16}/> News & Sentiment Intelligence Engine</h3>
              <p className="text-slate-300 text-xs mb-3">Scrapes global news feeds and X (Twitter) to determine the overall public fear or greed sentiment.</p>
            </div>

            <div className="bg-[#111822] border-l-2 border-teal-500 p-4 rounded-r-lg group hover:bg-[#151c28] transition-colors">
              <h3 className="text-teal-400 font-bold mb-2 flex items-center gap-2"><Database size={16}/> Fundamental & Earnings Engine</h3>
              <p className="text-slate-300 text-xs mb-3">Evaluates P/E ratios, forward guidance, debt-to-equity, and tracks upcoming earnings calls.</p>
            </div>

            <div className="bg-[#111822] border-l-2 border-slate-500 p-4 rounded-r-lg group hover:bg-[#151c28] transition-colors">
              <h3 className="text-slate-400 font-bold mb-2 flex items-center gap-2"><Network size={16}/> Historical & ML Prediction Engine</h3>
              <p className="text-slate-300 text-xs mb-3">Uses a local Vector Database (Vec Event Memory) to find previous times in history when identical setups occurred, calculating the historical win rate.</p>
            </div>

            <div className="bg-[#111822] border-l-2 border-red-500 p-4 rounded-r-lg group hover:bg-[#151c28] transition-colors">
              <h3 className="text-red-400 font-bold mb-2 flex items-center gap-2"><ShieldCheck size={16}/> Risk & Portfolio Engine</h3>
              <p className="text-slate-300 text-xs mb-3">Acts as the final safeguard. Sizes the position appropriately based on your total account value and current open exposure.</p>
            </div>
          </div>"""

# Find start
start_str = '          <div className="space-y-4">'
# Find end
end_str = '        </div>\n      )\n    },\n\n    // AI COUNCIL'

start_idx = content.find(start_str, content.find('// QUANT ENGINES'))
end_idx = content.find(end_str, start_idx)

if start_idx != -1 and end_idx != -1:
    new_content = content[:start_idx] + replacement + content[end_idx:]
    with open('src/components/DocumentationTab.tsx', 'w') as f:
        f.write(new_content)
    print("Success")
else:
    print("Could not find bounds")
