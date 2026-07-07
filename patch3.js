import _fs from "fs";
import _path from "path";

const serverPath = _path.join(process.cwd(), "server.ts");
let s = _fs.readFileSync(serverPath, "utf-8");

if (!s.includes('import fs from "fs"')) {
  s = 'import fs from "fs";\n' + s;
}

// snapshot error at 243: "let portfolioState = (snapshot.portfolioState) || {"
s = s.replace(/snapshot\.portfolioState/, '(global as any).snapshot ? (global as any).snapshot.portfolioState : undefined');

_fs.writeFileSync(serverPath, s);
console.log("Fixed TSC errors.");
