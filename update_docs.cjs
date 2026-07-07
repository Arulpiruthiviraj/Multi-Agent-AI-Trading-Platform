const fs = require('fs');

let content = fs.readFileSync('src/components/DocumentationTab.tsx', 'utf-8');

const newSectionsStr = `    // GETTING STARTED
    {
      id: "introduction",
      category: "Getting Started",
      title: "Introduction to Argus",
      icon: <BookOpen size={18} />,
      keywords: ["overview", "introduction", "getting started", "what is argus"],
      content: (
        <div className="space-y-6 animate-fade-in">
          <p className="text-slate-300 leading-relaxed text-sm">
            Welcome to the <strong>Argus Autonomous Trading Terminal</strong>. Argus is a high-fidelity, multi-agent AI protocol designed for institutional-grade market analysis and execution. Unlike traditional algorithmic trading systems that rely solely on quantitative price data, Argus leverages a "Swarm Consensus" model combining specialized Large Language Model (LLM) agents.
          </p>
          <div className="bg-indigo-500/10 border border-indigo-500/30 p-5 rounded-lg flex gap-4">
            <Info size={24} className="text-indigo-400 shrink-0" />
            <div>
              <h4 className="text-indigo-300 font-bold mb-1">Mission Statement</h4>
              <p className="text-slate-400 text-xs leading-relaxed">
                Argus aims to eliminate human emotional bias from trading by deploying a swarm of specialized AI personas that collaborate and compete simultaneously. By evaluating geopolitics, macroeconomic shifts, and localized sentiment alongside price action, Argus identifies hidden Alpha before it is priced in by the broader market.
              </p>
            </div>
          </div>
          <h3 className="text-white font-bold text-lg mt-8 mb-4 border-b border-slate-800 pb-2">Core Philosophy</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-[#111822] p-5 rounded-lg border border-slate-800">
              <h4 className="text-emerald-400 font-bold mb-2">Cross-Dimensional Synthesis</h4>
              <p className="text-xs text-slate-400">While human traders focus on a narrow set of technicals, the Argus swarm evaluates global macroeconomics, breaking news, and sentiment simultaneously to find outsized opportunities.</p>
            </div>
            <div className="bg-[#111822] p-5 rounded-lg border border-slate-800">
              <h4 className="text-amber-400 font-bold mb-2">Adversarial Risk Management</h4>
              <p className="text-xs text-slate-400">Proposer agents are naturally optimistic, seeking gains. Argus counters this with an adversarial Risk Manager agent that acts as an absolute veto authority, protecting capital at all costs.</p>
            </div>
          </div>
        </div>
      )
    },
    {
      id: "installation",
      category: "Getting Started",
      title: "Local Setup & Installation",
      icon: <Terminal size={18} />,
      keywords: ["setup", "install", "api keys", "configuration", "env", "run", "first time", "start"],
      content: (
        <div className="space-y-6 animate-fade-in">
          <p className="text-slate-300 leading-relaxed text-sm">
            Argus is designed to be deployed locally or via secure cloud containers. It utilizes a Node.js Express backend and a React/Vite frontend. Follow these instructions to launch your terminal.
          </p>
          
          <div className="space-y-4">
            <h4 className="text-white font-bold border-b border-slate-800 pb-2">1. System Requirements</h4>
            <ul className="list-disc pl-5 text-sm text-slate-400 space-y-2">
              <li>Node.js version 18.0 or higher.</li>
              <li>NPM or Yarn package manager.</li>
              <li>Active API Keys for Google Gemini (and optionally Alpaca Markets).</li>
            </ul>
          </div>

          <div className="space-y-4 mt-6">
            <h4 className="text-white font-bold border-b border-slate-800 pb-2">2. Installation Steps</h4>
            <div className="bg-[#111822] p-5 rounded-lg border border-slate-800 font-mono text-xs text-slate-300 space-y-4">
              <div>
                <p className="text-slate-400 mb-2"># Clone the repository and install dependencies</p>
                <code className="bg-slate-900 block p-3 rounded text-emerald-400">npm install</code>
              </div>
              <div>
                <p className="text-slate-400 mb-2"># Configure your environment variables</p>
                <code className="bg-slate-900 block p-3 rounded text-indigo-400 whitespace-pre">
{\`cp .env.example .env

# Edit .env with your credentials:
GEMINI_API_KEY=your_gemini_key_here
ALPACA_API_KEY=your_alpaca_key_here (optional)
ALPACA_API_SECRET=your_alpaca_secret_here (optional)\`}
                </code>
              </div>
              <div>
                <p className="text-slate-400 mb-2"># Launch the development server</p>
                <code className="bg-slate-900 block p-3 rounded text-emerald-400">npm run dev</code>
              </div>
            </div>
          </div>
        </div>
      )
    },

    // DATABASE & STATE
    {
      id: "database-setup",
      category: "Database & State",
      title: "Database Requirements & Setup",
      icon: <Database size={18} />,
      keywords: ["database", "db", "sql", "postgres", "redis", "memory", "setup", "persistence"],
      content: (
        <div className="space-y-6 animate-fade-in">
          <p className="text-slate-300 leading-relaxed text-sm">
            Argus utilizes an abstracted persistence layer, meaning it can operate entirely in-memory for testing, or connect to a robust relational database (like PostgreSQL via Cloud SQL) and a caching layer (like Redis) for production.
          </p>

          <div className="bg-indigo-500/10 border border-indigo-500/30 p-5 rounded-lg flex gap-4">
            <Database size={24} className="text-indigo-400 shrink-0" />
            <div>
              <h4 className="text-indigo-300 font-bold mb-1">Current State: In-Memory / Simulated Local DB</h4>
              <p className="text-slate-400 text-xs leading-relaxed">
                By default, out-of-the-box, the backend server (\`server.ts\`) maintains the autonomous bot state, transaction logs, and learned rules within an \`autoBotState\` object in memory. This is perfect for local testing and simulations. Data is reset upon server restart. To persist data across sessions in a production environment, you must connect a database.
              </p>
            </div>
          </div>

          <div className="space-y-4 mt-6">
            <h4 className="text-white font-bold border-b border-slate-800 pb-2">Production Database Setup (PostgreSQL)</h4>
            <p className="text-sm text-slate-400">To migrate to a durable PostgreSQL database (e.g., Google Cloud SQL, Supabase, AWS RDS):</p>
            
            <ol className="list-decimal pl-5 text-sm text-slate-300 space-y-4">
              <li>
                <strong>Provision the Database:</strong> Create a PostgreSQL database instance. Ensure you have the connection URI string.
              </li>
              <li>
                <strong>Environment Variable:</strong> Add your database URI to the \`.env\` file.
                <code className="bg-[#111822] border border-slate-800 block p-3 rounded mt-2 text-indigo-400 font-mono text-xs">DATABASE_URL="postgres://user:password@host:port/dbname"</code>
              </li>
              <li>
                <strong>Install ORM/Driver:</strong> Install the required database packages (e.g., Prisma or Drizzle ORM).
                <code className="bg-[#111822] border border-slate-800 block p-3 rounded mt-2 text-emerald-400 font-mono text-xs">npm install drizzle-orm pg<br/>npm install -D drizzle-kit @types/pg</code>
              </li>
              <li>
                <strong>Initialize Schema:</strong> Create the schema for \`Portfolios\`, \`Trades\`, \`MemoryRules\`, and \`AuditLogs\`.
              </li>
            </ol>
          </div>
        </div>
      )
    },
    {
      id: "db-parameters",
      category: "Database & State",
      title: "Updating Database Parameters",
      icon: <Settings size={18} />,
      keywords: ["db", "parameters", "configuration", "tuning", "max connections", "pool", "timeout"],
      content: (
        <div className="space-y-6 animate-fade-in">
          <p className="text-slate-300 leading-relaxed text-sm">
            When operating with a persistent database, the high-frequency nature of the autonomous agent loops requires specific parameter tuning to prevent connection exhaustion.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-[#111822] p-5 rounded-lg border border-slate-800">
              <h5 className="text-emerald-400 font-bold mb-2">Connection Pooling</h5>
              <p className="text-xs text-slate-400 mb-2">Because the autonomous bot loop (\`setInterval\`) can trigger dozens of asynchronous LLM calls and state updates simultaneously, you must configure a robust connection pool (e.g., using PgBouncer or the \`pg.Pool\` class).</p>
              <code className="text-[10px] text-slate-500 font-mono">DB_POOL_MAX=50</code>
            </div>
            <div className="bg-[#111822] p-5 rounded-lg border border-slate-800">
              <h5 className="text-amber-400 font-bold mb-2">Timeouts & Retries</h5>
              <p className="text-xs text-slate-400 mb-2">Database queries must have strict timeouts. If a database lock occurs during a rapidly changing market simulation, the bot must fail gracefully rather than hanging the event loop.</p>
              <code className="text-[10px] text-slate-500 font-mono">DB_IDLE_TIMEOUT_MS=10000</code>
            </div>
          </div>

          <div className="space-y-4 mt-6">
            <h4 className="text-white font-bold border-b border-slate-800 pb-2">State Synchronization</h4>
            <p className="text-sm text-slate-400">
              To minimize database writes, the backend caches the \`autoBotState\` in memory and performs bulk updates (upserts) to the database every X seconds, rather than writing to the database on every micro-tick of the simulation.
              <br/><br/>
              When modifying risk parameters (like Max Position Size) via the UI, the frontend issues a \`POST /api/autobot/toggle\` or parameter update endpoint. The backend updates the in-memory cache immediately, applies it to the next tick, and asynchronously flushes the change to the persistent DB.
            </p>
          </div>
        </div>
      )
    },

    // CORE CONCEPTS
    {
      id: "architecture",
      category: "Core Concepts",
      title: "System Architecture",
      icon: <Layers size={18} />,
      keywords: ["architecture", "deep dive", "layer", "how it works", "components"],
      content: (
        <div className="space-y-6 animate-fade-in">
          <p className="text-slate-300 text-sm leading-relaxed mb-4">
            Argus is built on a <strong>5-Layer Hierarchical Architecture</strong> separating data ingress, AI analysis, mathematical weighting, consensus decision-making, and hard risk management.
          </p>
          
          <div className="space-y-6">
            <div className="bg-[#111822] p-5 rounded-lg border border-slate-800 border-l-4 border-l-slate-500">
              <h5 className="text-white font-bold mb-1">Layer 1: Data Ingress</h5>
              <p className="text-xs text-slate-400 leading-relaxed">Responsible for collecting and streaming market data, news events, macro indicators, and geopolitical shifts. This acts as the sensory input for the AI swarm.</p>
            </div>
            <div className="bg-[#111822] p-5 rounded-lg border border-slate-800 border-l-4 border-l-indigo-500">
              <h5 className="text-white font-bold mb-1">Layer 2: Intelligence (LLM Swarm)</h5>
              <p className="text-xs text-slate-400 leading-relaxed">Uses Google Gemini models to process unstructured qualitative data. Consists of specialized personas (Macro, Tech, News, Geopolitics) that translate real-world context into quantitative directional scores (-1.0 to 1.0).</p>
            </div>
            <div className="bg-[#111822] p-5 rounded-lg border border-slate-800 border-l-4 border-l-sky-500">
              <h5 className="text-white font-bold mb-1">Layer 3: Quantitative & Performance</h5>
              <p className="text-xs text-slate-400 leading-relaxed">Evaluates agent performance mathematically. Tracks win rates, max drawdown, and Sharpe ratios for each agent, dynamically calibrating their "voting weight" based on real-time historical accuracy (Adaptive Performance Tracking).</p>
            </div>
            <div className="bg-[#111822] p-5 rounded-lg border border-slate-800 border-l-4 border-l-amber-500">
              <h5 className="text-white font-bold mb-1">Layer 4: Decision Consensus</h5>
              <p className="text-xs text-slate-400 leading-relaxed">Aggregates the weighted signals from the Intelligence layer. A master Consensus Agent evaluates the aggregate votes to produce a final unified trade action (BUY/SELL/HOLD) alongside a confidence index.</p>
            </div>
            <div className="bg-[#111822] p-5 rounded-lg border border-slate-800 border-l-4 border-l-rose-500">
              <h5 className="text-white font-bold mb-1">Layer 5: Sovereign Risk Authority</h5>
              <p className="text-xs text-slate-400 leading-relaxed">The ultimate veto authority. Operates completely independently from the consensus. It vetos trades if allocation limits are exceeded or halts all operations if daily/weekly loss thresholds are breached.</p>
            </div>
          </div>
        </div>
      )
    },
    {
      id: "swarm-dynamics",
      category: "Core Concepts",
      title: "Agent Swarm Dynamics",
      icon: <Target size={18} />,
      keywords: ["agents", "swarm", "evolution", "weights", "correlation"],
      content: (
        <div className="space-y-6 animate-fade-in">
          <p className="text-slate-300 text-sm leading-relaxed mb-4">
            The core engine of Argus is its multi-agent swarm. By compartmentalizing logic into distinct LLM prompts, the system mimics a high-functioning quantitative trading floor.
          </p>
          
          <h4 className="text-white font-bold border-b border-slate-800 pb-2 mt-8 mb-4">The Active Roster</h4>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-[#111822] p-4 rounded-lg border border-slate-800">
              <h5 className="text-sky-400 font-bold mb-1 flex items-center gap-2"><AlignLeft size={14} /> Macro Agent</h5>
              <p className="text-xs text-slate-400">Analyzes interest rates, inflation data, and broad economic cycles. Has high weight during Federal Reserve announcements.</p>
            </div>
            <div className="bg-[#111822] p-4 rounded-lg border border-slate-800">
              <h5 className="text-emerald-400 font-bold mb-1 flex items-center gap-2"><LineChart size={14} /> Tech Agent</h5>
              <p className="text-xs text-slate-400">Focuses purely on price action, moving averages, RSI, and momentum divergence. The quantitative anchor of the swarm.</p>
            </div>
            <div className="bg-[#111822] p-4 rounded-lg border border-slate-800">
              <h5 className="text-amber-400 font-bold mb-1 flex items-center gap-2"><Activity size={14} /> Sentiment Agent</h5>
              <p className="text-xs text-slate-400">Scans social media velocity, news headlines, and retail fervor to detect short-term irrational market moves.</p>
            </div>
            <div className="bg-[#111822] p-4 rounded-lg border border-slate-800">
              <h5 className="text-purple-400 font-bold mb-1 flex items-center gap-2"><Target size={14} /> Geopol Agent</h5>
              <p className="text-xs text-slate-400">Monitors global conflicts, supply chain disruptions, and sovereign policy shifts for structural tail risks.</p>
            </div>
          </div>

          <div className="bg-emerald-500/10 border border-emerald-500/30 p-5 rounded-lg mt-6">
            <h4 className="text-emerald-400 font-bold mb-2">Evolutionary Weighting (Survival of the Fittest)</h4>
            <p className="text-xs text-slate-300 leading-relaxed">
              Agents do not have equal votes. Argus continuously tracks the Win Rate and Sharpe Ratio of every agent. If the Tech Agent begins losing trades in a choppy bear market, the Quantitative Layer automatically strips its voting power and redistributes it to the Geopol Agent (if it is performing better). This self-correcting swarm intelligence ensures the system adapts to shifting market regimes without human intervention.
            </p>
          </div>
        </div>
      )
    },
    {
      id: "risk-protocol",
      category: "Core Concepts",
      title: "Risk Management Protocol",
      icon: <ShieldCheck size={18} />,
      keywords: ["risk", "veto", "circuit breaker", "exposure", "guardrails"],
      content: (
        <div className="space-y-6 animate-fade-in">
          <p className="text-slate-300 text-sm leading-relaxed mb-4">
            Trading via autonomous agents involves significant risk. The Argus Terminal implements a "Sovereign Risk Authority" that cannot be overridden by the Proposer swarm.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
            <div className="border border-rose-500/20 bg-rose-500/5 p-5 rounded-lg flex flex-col h-full">
              <h5 className="text-rose-400 font-bold mb-2">Circuit Breakers</h5>
              <p className="text-xs text-slate-400 flex-1">Automatically halts all trading logic if portfolio equity drops below a daily or weekly maximum drawdown threshold. Requires manual human restart.</p>
            </div>
            <div className="border border-emerald-500/20 bg-emerald-500/5 p-5 rounded-lg flex flex-col h-full">
              <h5 className="text-emerald-400 font-bold mb-2">Sector Exposure Caps</h5>
              <p className="text-xs text-slate-400 flex-1">Caps maximum allocation per sector (e.g., max 30% in Technology) to prevent catastrophic over-concentration in a single asset class.</p>
            </div>
            <div className="border border-indigo-500/20 bg-indigo-500/5 p-5 rounded-lg flex flex-col h-full">
              <h5 className="text-indigo-400 font-bold mb-2">The Final Veto</h5>
              <p className="text-xs text-slate-400 flex-1">Even if the AI swarm achieves 100% unanimous consensus to buy an asset, the Risk Manager will VETO the trade if it violates any active guardrail.</p>
            </div>
          </div>
          
          <div className="bg-[#111822] p-5 rounded-lg border border-slate-800">
            <h4 className="text-white font-bold mb-2">Configuring Guardrails</h4>
            <p className="text-xs text-slate-400 mb-4">Risk parameters are configured in the <strong>Command Center</strong> tab under the <strong>Guardrails Panel</strong>. Changes take effect immediately on the next bot cycle.</p>
            <ul className="list-disc pl-5 text-xs text-slate-500 space-y-1">
              <li>Max Position Size (Default: 5% of Portfolio)</li>
              <li>Max Daily Drawdown (Default: -3.5%)</li>
              <li>Required Agent Confidence Threshold (Default: 75%)</li>
            </ul>
          </div>
        </div>
      )
    },

    // MODULES & FEATURES
    {
      id: "trading-arena",
      category: "Modules & Features",
      title: "Trading Arena (Dashboard)",
      icon: <Layers size={18} />,
      keywords: ["arena", "dashboard", "manual", "consensus", "ui", "charts"],
      content: (
        <div className="space-y-6 animate-fade-in">
          <p className="text-slate-300 text-sm leading-relaxed">
            The Trading Arena is the central hub for manual execution, observation, and macro simulations. It visualizes the pulse of the agent swarm in real-time.
          </p>
          
          <div className="space-y-4">
            <div className="bg-[#111822] p-5 rounded-lg border border-slate-800">
              <h5 className="text-indigo-400 font-bold mb-2">Target Asset & News Ticker</h5>
              <p className="text-xs text-slate-400 leading-relaxed">Select specific ticker symbols (e.g., AAPL, NVDA) and provide context headlines to simulate incoming market data. This is where you manually trigger the swarm.</p>
            </div>
            
            <div className="bg-[#111822] p-5 rounded-lg border border-slate-800">
              <h5 className="text-indigo-400 font-bold mb-2">Multi-Agent Dialogue Graph</h5>
              <p className="text-xs text-slate-400 leading-relaxed">A visual network graph showing the active LLM nodes discussing the current asset. Lines pulse rapidly when data is being processed, visually representing the swarm consensus building.</p>
            </div>
            
            <div className="bg-[#111822] p-5 rounded-lg border border-slate-800">
              <h5 className="text-indigo-400 font-bold mb-2">Strategy Synergy Matrix</h5>
              <p className="text-xs text-slate-400 leading-relaxed">A heatmap visualizing the correlation coefficient between different agents when proposing trades. It reveals if agents are acting redundantly (High Sync / Green) or acting as structural hedges (Inverse Correlation / Red).</p>
            </div>
            
            <div className="bg-[#111822] p-5 rounded-lg border border-slate-800">
              <h5 className="text-indigo-400 font-bold mb-2">Execution vs. Veto Ledgers</h5>
              <p className="text-xs text-slate-400 leading-relaxed">Two side-by-side tables. The left shows trades that were successfully booked to the portfolio. The right displays trades that were mercilessly blocked by the Risk Manager, explaining exactly *why* they were vetoed.</p>
            </div>
          </div>
        </div>
      )
    },
    {
      id: "holdings",
      category: "Modules & Features",
      title: "Holdings & Positions",
      icon: <Wallet size={18} />,
      keywords: ["portfolio", "holdings", "assets", "unrealized", "pnl", "treemap"],
      content: (
        <div className="space-y-6 animate-fade-in">
          <p className="text-slate-300 text-sm leading-relaxed">
            The Holdings module acts as your simulated (or connected) brokerage account view, tracking the ongoing performance of the swarm's deployed capital.
          </p>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-4">
            <div className="bg-[#111822] p-5 rounded-lg border border-slate-800">
              <div className="flex items-center gap-2 mb-3">
                <Wallet size={16} className="text-sky-400" />
                <h5 className="text-white font-bold">Active Portfolio Ledger</h5>
              </div>
              <p className="text-xs text-slate-400">Lists all currently held assets. Tracks exact allocation percentage, entry cost basis, current market price, and live Unrealized Profit/Loss. Use this view to manually override the bot and liquidate positions.</p>
            </div>
            <div className="bg-[#111822] p-5 rounded-lg border border-slate-800">
              <div className="flex items-center gap-2 mb-3">
                <BarChart3 size={16} className="text-sky-400" />
                <h5 className="text-white font-bold">Risk Attribution Treemap</h5>
              </div>
              <p className="text-xs text-slate-400">A dense, hierarchical map showing capital deployment clustered across different market sectors. Essential for rapid visualization of concentration risk (e.g., noticing the bot has deployed 60% of capital into Semiconductors).</p>
            </div>
          </div>
        </div>
      )
    },
    {
      id: "command-center",
      category: "Modules & Features",
      title: "Autonomous Command Center",
      icon: <Bot size={18} />,
      keywords: ["bot", "auto", "command", "autonomous", "settings", "telemetry"],
      content: (
        <div className="space-y-6 animate-fade-in">
          <p className="text-slate-300 text-sm leading-relaxed">
            The Command Center is mission control for the algorithmic "Black Box" bot. Once activated, the bot runs a continuous loop on the Node.js backend entirely independent of the browser.
          </p>

          <div className="bg-amber-500/10 border border-amber-500/30 p-5 rounded-lg flex gap-4">
            <Zap size={24} className="text-amber-400 shrink-0" />
            <div>
              <h4 className="text-amber-300 font-bold mb-1">The Autonomous Loop</h4>
              <p className="text-slate-400 text-xs leading-relaxed">
                When toggled ON, the backend begins a \`setInterval\` loop. It randomly selects assets from the universe, generates synthetic or real market data, runs the full 5-Layer Swarm Evaluation, and executes trades without human input. The UI simply polls the backend to display telemetry.
              </p>
            </div>
          </div>

          <div className="space-y-4">
            <div className="bg-[#111822] p-5 rounded-lg border border-slate-800">
              <h5 className="text-amber-400 font-bold mb-2">Live Bot Telemetry</h5>
              <p className="text-xs text-slate-400 leading-relaxed">A matrix of terminal-like readouts showing the Bot's exact internal state: Operational Status, Simulated CPU/Memory Utilization, Network Latency, and the timestamp of the last executed cycle.</p>
            </div>
            <div className="bg-[#111822] p-5 rounded-lg border border-slate-800">
              <h5 className="text-amber-400 font-bold mb-2">Strategy Bias Knobs</h5>
              <p className="text-xs text-slate-400 leading-relaxed">Adjust the bot's overarching personality. Shift the focus between Momentum, Value, or Mean Reversion. Adjust the baseline risk tolerance from Conservative to Highly Aggressive, which modifies the required agent confidence threshold.</p>
            </div>
            <div className="bg-[#111822] p-5 rounded-lg border border-slate-800">
              <h5 className="text-rose-400 font-bold mb-2">Master Kill-Switch</h5>
              <p className="text-xs text-slate-400 leading-relaxed">Instantly halts the backend \`setInterval\` loop. Immediately stops all future evaluations and trade proposals. Does NOT automatically liquidate current holdings.</p>
            </div>
          </div>
        </div>
      )
    },
    {
      id: "learning-reflection",
      category: "Modules & Features",
      title: "Learning & Context Memory",
      icon: <BrainCircuit size={18} />,
      keywords: ["learning", "memory", "reflection", "rules", "context engineering"],
      content: (
        <div className="space-y-6 animate-fade-in">
          <p className="text-slate-300 text-sm leading-relaxed mb-4">
            The most advanced feature of the Argus Terminal is its ability to learn from its mistakes via automated Context Memory Engineering.
          </p>
          
          <div className="bg-[#111822] p-6 rounded-lg border border-slate-800 relative overflow-hidden">
            <div className="absolute top-0 right-0 p-4 opacity-10"><BrainCircuit size={100} /></div>
            <h4 className="text-rose-400 font-bold mb-3 relative z-10">The Reflection Engine Workflow</h4>
            <ol className="list-decimal pl-5 space-y-4 text-xs text-slate-300 relative z-10">
              <li><strong>Loss Detection:</strong> The system continuously monitors closed trades. When a trade is closed at a significant loss, it triggers the Reflection Protocol.</li>
              <li><strong>Post-Mortem Analysis:</strong> An independent LLM agent reviews the exact rationale that led the swarm to take the losing trade, comparing it to the actual market outcome.</li>
              <li><strong>Rule Generation:</strong> The agent extracts a concrete lesson and generates a strict "Rule" (e.g., <em>"Do not buy semiconductors immediately following an inverted yield curve flash, regardless of RSI."</em>).</li>
              <li><strong>Context Injection:</strong> This new rule is saved to the persistent \`memoryRules\` database. In all future trades involving similar assets, this rule is dynamically injected directly into the system prompt of the Proposer agents.</li>
            </ol>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-6">
            <div className="bg-[#111822] p-4 rounded-lg border border-slate-800">
              <h5 className="text-indigo-400 font-bold mb-2">Semantic Event Memory</h5>
              <p className="text-xs text-slate-400">A vector search interface. Users can search for historical macro shocks (e.g., "2008 Housing Crisis") to see how the system correlates historical lessons to current market conditions.</p>
            </div>
            <div className="bg-[#111822] p-4 rounded-lg border border-slate-800">
              <h5 className="text-indigo-400 font-bold mb-2">Trade Replay Modal</h5>
              <p className="text-xs text-slate-400">Click any closed trade in the history ledger to open a full breakdown. See exactly which agents voted YES or NO, read their original rationale, and add manual human journaling notes.</p>
            </div>
          </div>
        </div>
      )
    }`;

content = content.replace(/const sections: DocSection\[\] = \[[\s\S]*?\];/, `const sections: DocSection[] = [\n${newSectionsStr}\n  ];`);

fs.writeFileSync('src/components/DocumentationTab.tsx', content);
