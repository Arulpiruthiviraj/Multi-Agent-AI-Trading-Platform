import fs from 'fs';
let code = fs.readFileSync('src/components/DigitalTwinVisualizer.tsx', 'utf8');

const newInitialNodes = `  const initialNodes: Node[] = [
    { id: 'market-data-worker', type: 'custom', position: { x: 50, y: 50 }, data: { label: 'Market Data', icon: <Activity size={18}/>, description: 'Live Price & Volume', status: 'IDLE' } },
    { id: 'news-agent', type: 'custom', position: { x: 300, y: 50 }, data: { label: 'News Intelligence', icon: <Newspaper size={18}/>, description: 'Sentiment Processing', status: 'IDLE' } },
    { id: 'fundamental-agent', type: 'custom', position: { x: 450, y: 50 }, data: { label: 'Fundamental Agent', icon: <Activity size={18}/>, description: 'Value & EPS', status: 'IDLE' } },
    { id: 'macro-agent', type: 'custom', position: { x: 600, y: 50 }, data: { label: 'Macro Agent', icon: <Activity size={18}/>, description: 'Fed & Inflation', status: 'IDLE' } },
    { id: 'portfolio-monitor', type: 'custom', position: { x: 750, y: 50 }, data: { label: 'Portfolio Manager', icon: <Clock size={18}/>, description: 'Position Checks', status: 'IDLE' } },
    
    { id: 'technical-engine', type: 'custom', position: { x: 50, y: 200 }, data: { label: 'Technical Engine', icon: <TrendingUp size={18}/>, description: 'RSI, MACD, Breakouts', status: 'IDLE' } },
    { id: 'quant-engine', type: 'custom', position: { x: 50, y: 350 }, data: { label: 'Advanced Quant', icon: <Activity size={18}/>, description: 'Multi-TF, Volatility', status: 'IDLE' } },
    
    { id: 'chief-trader', type: 'custom', position: { x: 400, y: 350 }, data: { label: 'Chief Trader (AI)', icon: <UserCheck size={18}/>, description: 'Consensus & Routing', status: 'IDLE' } },
    { id: 'risk-manager', type: 'custom', position: { x: 400, y: 500 }, data: { label: 'Risk Validation', icon: <ShieldCheck size={18}/>, description: 'Sizing & Veto Constraints', status: 'IDLE' } },
    { id: 'order-management', type: 'custom', position: { x: 400, y: 650 }, data: { label: 'Execution Service', icon: <Send size={18}/>, description: 'Broker Routing', status: 'IDLE' } },
    { id: 'learning-engine', type: 'custom', position: { x: 750, y: 650 }, data: { label: 'Reflection Engine', icon: <BookOpen size={18}/>, description: 'Post-trade Learning', status: 'IDLE' } },
  ];`;

const newInitialEdges = `  const initialEdges: Edge[] = [
    { id: 'e-market-tech', source: 'market-data-worker', target: 'technical-engine', animated: false, style: { stroke: '#334155', strokeWidth: 2 } },
    { id: 'e-market-quant', source: 'market-data-worker', target: 'quant-engine', animated: false, style: { stroke: '#334155', strokeWidth: 2 } },
    
    { id: 'e-tech-chief', source: 'technical-engine', target: 'chief-trader', animated: false, style: { stroke: '#334155', strokeWidth: 2 } },
    { id: 'e-quant-chief', source: 'quant-engine', target: 'chief-trader', animated: false, style: { stroke: '#334155', strokeWidth: 2 } },
    { id: 'e-news-chief', source: 'news-agent', target: 'chief-trader', animated: false, style: { stroke: '#334155', strokeWidth: 2 } },
    { id: 'e-fund-chief', source: 'fundamental-agent', target: 'chief-trader', animated: false, style: { stroke: '#334155', strokeWidth: 2 } },
    { id: 'e-macro-chief', source: 'macro-agent', target: 'chief-trader', animated: false, style: { stroke: '#334155', strokeWidth: 2 } },
    { id: 'e-port-chief', source: 'portfolio-monitor', target: 'chief-trader', animated: false, style: { stroke: '#334155', strokeWidth: 2 } },
    
    { id: 'e-chief-risk', source: 'chief-trader', target: 'risk-manager', animated: false, style: { stroke: '#334155', strokeWidth: 2 } },
    { id: 'e-risk-exec', source: 'risk-manager', target: 'order-management', animated: false, style: { stroke: '#334155', strokeWidth: 2 } },
    { id: 'e-exec-learn', source: 'order-management', target: 'learning-engine', animated: false, style: { stroke: '#334155', strokeWidth: 2 } },
  ];`;

const newUpdateGraphFromEvents = `  const updateGraphFromEvents = (latestEvents: any[]) => {
    // Only look at events from the last 3 seconds for animation
    const now = Date.now();
    const recent = latestEvents.filter(e => (now - new Date(e.timestamp).getTime()) < 3500);
    
    const newActiveNodes = new Set<string>();
    const newActiveEdges = new Set<string>();

    recent.forEach((evt) => {
      if (evt.type === 'MARKET_DATA') {
        newActiveNodes.add('market-data-worker');
        newActiveEdges.add('e-market-tech');
        newActiveEdges.add('e-market-quant');
      } else if (evt.type === 'QUANT_ENGINE_OUTPUT') {
        newActiveNodes.add('quant-engine');
        newActiveEdges.add('e-quant-chief');
      } else if (evt.type === 'TRADE_IDEA_GENERATED') {
        if (evt.payload.agent === 'TechnicalAgent') {
           newActiveNodes.add('technical-engine');
           newActiveEdges.add('e-tech-chief');
        }
        if (evt.payload.agent === 'NewsAgent') {
           newActiveNodes.add('news-agent');
           newActiveEdges.add('e-news-chief');
        }
        if (evt.payload.agent === 'FundamentalAgent') {
           newActiveNodes.add('fundamental-agent');
           newActiveEdges.add('e-fund-chief');
        }
        if (evt.payload.agent === 'MacroAgent') {
           newActiveNodes.add('macro-agent');
           newActiveEdges.add('e-macro-chief');
        }
        if (evt.payload.agent === 'PortfolioManager') {
           newActiveNodes.add('portfolio-monitor');
           newActiveEdges.add('e-port-chief');
        }
        newActiveNodes.add('chief-trader');
      } else if (evt.type === 'CHIEF_APPROVED_IDEA') {
        newActiveNodes.add('chief-trader');
        newActiveEdges.add('e-chief-risk');
        newActiveNodes.add('risk-manager');
      } else if (evt.type === 'RISK_ASSESSMENT_COMPLETED') {
        newActiveNodes.add('risk-manager');
        if (evt.payload.approved) {
           newActiveEdges.add('e-risk-exec');
           newActiveNodes.add('order-management');
        }
      } else if (evt.type === 'ORDER_EXECUTED') {
        newActiveNodes.add('order-management');
        newActiveEdges.add('e-exec-learn');
        newActiveNodes.add('learning-engine');
      } else if (evt.type === 'LEARNED_NEW_RULE') {
        newActiveNodes.add('learning-engine');
      }
    });

    setActiveNodes(newActiveNodes);
    setActiveEdges(newActiveEdges);
  };`;

code = code.replace(/const initialNodes: Node\[\] = \[[\s\S]*?\];/, newInitialNodes);
code = code.replace(/const initialEdges: Edge\[\] = \[[\s\S]*?\];/, newInitialEdges);
code = code.replace(/const updateGraphFromEvents = \([\s\S]*?};/, newUpdateGraphFromEvents);
code = code.replace(/} else if \(evt\.type === 'NEW_RULE_LEARNED'\) {[\s\S]*?newActiveNodes\.add\('learning-engine'\);[\s\S]*?}/, ''); 
code = code.replace(/let interval: NodeJS\.Timeout;/, '');
code = code.replace(/useEffect\(\(\) => {\s*let isMounted = true;\s*}\s*\[\]\);/g, ''); 
code = code.replace(/useEffect\(\(\) => {[\s]*let isMounted = true;[\s]*useEffect/g, 'useEffect');

fs.writeFileSync('src/components/DigitalTwinVisualizer.tsx', code);
