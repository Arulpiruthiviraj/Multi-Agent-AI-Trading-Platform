const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

const targetStr = `            if (qData.quotes && qData.quotes[symbol]) {
              px_base = qData.quotes[symbol].bp; // Bid price baseline
              isRealPrice = true;
            console.log(\`Fetched real Alpaca quote for \${symbol}: $\${px_base}\`);
          }
        }
      } catch (e: any) {
        console.warn(
          "Could not fetch real Alpaca quote, falling back",
          e.message,
        );
      }
    }`;

const replaceStr = `            if (qData.quotes && qData.quotes[symbol]) {
              px_base = qData.quotes[symbol].bp; // Bid price baseline
              isRealPrice = true;
            }
            console.log(\`Fetched real Alpaca quote for \${symbol}: $\${px_base}\`);
          }
        } catch (e: any) {
          console.warn(
            "Could not fetch real Alpaca quote, falling back",
            e.message,
          );
        }
      }
    }`;

if (code.includes(targetStr)) {
  code = code.replace(targetStr, replaceStr);
  fs.writeFileSync('server.ts', code);
  console.log("Braces fixed.");
} else {
  console.log("Target not found");
}
