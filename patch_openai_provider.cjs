const fs = require('fs');
const path = 'src/server/ai/providers/OpenAICompatibleProvider.ts';
let content = fs.readFileSync(path, 'utf8');

const newChat = `
  async chat(prompt: string, options?: any): Promise<{ content: string, tokens: number }> {
    if (!this.authenticate()) throw new Error(\`\${this.providerName} not authenticated\`);
    
    const headers: Record<string, string> = {
        "Content-Type": "application/json"
    };
    if (this.apiKey) {
        headers["Authorization"] = \`Bearer \${this.apiKey}\`;
    }
    
    // OpenRouter specific headers
    if (this.baseUrl.includes('openrouter.ai')) {
        headers["HTTP-Referer"] = "https://argus.ai";
        headers["X-Title"] = "Argus Trading Terminal";
    }

    let retries = 0;
    const maxRetries = 2;
    let delay = 500;

    while (retries <= maxRetries) {
      try {
        const response = await fetch(\`\${this.baseUrl}/chat/completions\`, {
            method: "POST",
            headers,
            body: JSON.stringify({
                model: options?.model || this.defaultModel,
                messages: [{ role: "user", content: prompt }]
            })
        });
        
        if (!response.ok) {
            if (response.status === 429 || response.status >= 500) {
               if (retries < maxRetries) {
                  retries++;
                  await new Promise(resolve => setTimeout(resolve, delay));
                  delay *= 2;
                  continue;
               }
            }
            throw new Error(\`\${this.providerName} API error: \${response.status} \${response.statusText}\`);
        }
        
        const data = await response.json();
        return {
            content: data.choices[0]?.message?.content || '',
            tokens: data.usage?.total_tokens || 0
        };
      } catch (err: any) {
         if (retries < maxRetries && (err.message.includes('fetch') || err.message.includes('network'))) {
            retries++;
            await new Promise(resolve => setTimeout(resolve, delay));
            delay *= 2;
            continue;
         }
         throw err;
      }
    }
    throw new Error(\`\${this.providerName} failed after retries\`);
  }
`;

content = content.replace(/async chat\(prompt: string, options\?: any\): Promise<\{ content: string, tokens: number \}> \{[\s\S]*?\}\n\}/, newChat.trim() + '\n}');

fs.writeFileSync(path, content, 'utf8');
console.log('Patched OpenAICompatibleProvider.ts');
