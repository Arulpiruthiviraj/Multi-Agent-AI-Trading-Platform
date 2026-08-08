const fs = require('fs');
const path = 'src/server/routes/configRoutes.ts';
let content = fs.readFileSync(path, 'utf8');

content = content.replace(/res\.json\(\{ ok: true \}\);\n  \} catch \(e: any\) \{\n    console\.error\(e\);\n    res\.status\(500\)\.json\(\{ error: e\.message \}\);\n  \}\n\}\);\n    res\.json\(\{ ok: true \}\);\n  \} catch \(e: any\) \{\n    console\.error\(e\);\n    res\.status\(500\)\.json\(\{ error: e\.message \}\);\n  \}\n\}\);/g, 'res.json({ ok: true });\n  } catch (e: any) {\n    console.error(e);\n    res.status(500).json({ error: e.message });\n  }\n});');

fs.writeFileSync(path, content, 'utf8');
console.log('Patched configRoutes syntax error');
