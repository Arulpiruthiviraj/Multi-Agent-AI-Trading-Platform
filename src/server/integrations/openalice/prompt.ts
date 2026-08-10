import type { VerificationRequest } from './types';

/**
 * Builds the OpenAlice issue "what" field. This is the ONLY channel of instruction the
 * OpenAlice-side agent gets - it must state, in the same message, both the research task
 * and the exact reply format, since Argus has to parse whatever comes back out of a free-text
 * inbox entry (no shared schema enforcement across two separate codebases/orgs).
 *
 * BLIND_RESEARCH deliberately omits Argus's own side/confidence/reasoning so OpenAlice's
 * read is not anchored on Argus's conclusion.
 */
export function buildVerificationPrompt(request: VerificationRequest): string {
  const task = describeTask(request);
  return `${task}

Reply by pushing a single message to my inbox. In that message, include exactly one fenced
json code block (\`\`\`json ... \`\`\`) with this shape, and nothing else inside the fence:

{
  "direction": "AGREE" | "DISAGREE" | "NO_OPINION",
  "confidence": <number 0-1>,
  "thesis": "<one paragraph, your independent conclusion>",
  "supportingEvidence": ["<short factual point>", ...],
  "contradictingEvidence": ["<short factual point>", ...]
}

Use your own independent research (market data, news, filings) - do not assume any conclusion
I have not stated here. If you cannot form a view, use "NO_OPINION" rather than guessing.`;
}

function describeTask(request: VerificationRequest): string {
  switch (request.mode) {
    case 'BLIND_RESEARCH':
      return `Independently research ${request.symbol} right now and form your own view on whether ` +
        `it is a good BUY, a good SELL, or neither, over the next few trading days. Do not assume any ` +
        `stance from me - I am deliberately not telling you mine.`;
    case 'TRADE_VERIFICATION':
      return `A separate automated trading system is proposing to ${request.side} ${request.symbol}, ` +
        `citing this reasoning: "${request.argusReasoning}" (stated confidence ${(request.argusConfidence * 100).toFixed(0)}%). ` +
        `Independently verify this using your own research. Agree only if your own analysis actually ` +
        `supports the same conclusion - do not defer to the stated reasoning.`;
    case 'ADVERSARIAL_REVIEW':
      return `A separate automated trading system is proposing to ${request.side} ${request.symbol}, ` +
        `citing this reasoning: "${request.argusReasoning}". Actively try to find the strongest case ` +
        `AGAINST this trade using your own independent research, then give an honest overall verdict ` +
        `(you may still conclude AGREE if you genuinely cannot find a case against it).`;
  }
}
