import fs from 'fs';
let code = fs.readFileSync('src/components/DigitalTwinVisualizer.tsx', 'utf8');

const useEffectCode = `
  useEffect(() => {
    isMounted = true;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(\`\${protocol}//\${window.location.host}/ws\`);
    
    ws.onmessage = (event) => {
      if (!isPlaying) return;
      try {
        const msg = JSON.parse(event.data);
        const newEvent = {
           id: Math.random().toString(36).substring(7),
           type: msg.type,
           timestamp: new Date().toISOString(),
           payload: msg.data
        };
        setEvents(prev => {
          const updated = [newEvent, ...prev].slice(0, 50);
          updateGraphFromEvents(updated);
          return updated;
        });
      } catch(e) {}
    };

    return () => {
      isMounted = false;
      ws.close();
    };
  }, [isPlaying]);
`;

code = code.replace(/const fetchEvents = async \(\) => {[\s\S]*?}, \[isPlaying\]\);/, useEffectCode);

fs.writeFileSync('src/components/DigitalTwinVisualizer.tsx', code);
