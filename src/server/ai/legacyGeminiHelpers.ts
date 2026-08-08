/**
 * Shared helpers for the legacy Gemini-flavored call sites in server.ts
 * (the `/api/v1/signals`, `/api/v1/chaos/*`, `/api/v1/autobot/evolve`, and
 * `/api/v1/llm/*` routes). Extracted structurally only — behavior is unchanged.
 *
 * These calls do not actually touch the Gemini SDK directly: every real request
 * is routed through `AIRouter.getInstance().routeTask('General', ...)`, so the
 * `ai` parameter below is accepted for call-site compatibility but is never read.
 */
import { AIRouter } from "./AIRouter";

/**
 * Executes an AI generation call (via AIRouter) with the semantics of the
 * original "Gemini generateContent with retry" helper: it flattens whatever
 * shape `params.contents` was given (string, array of parts, or a single
 * {role, parts} object) into a single prompt string before routing it.
 *
 * @param ai - Unused; kept for call-site compatibility with the original Gemini-SDK-shaped call sites.
 * @param params - Generation parameters; only `params.contents` is read.
 * @param maxRetries - Accepted for compatibility; retry/backoff itself is handled inside AIRouter, not here.
 */
export async function generateContentWithRetry(
  ai: unknown,
  params: Record<string, unknown> & { contents: unknown },
  maxRetries = 3
): Promise<{ text: string }> {
  let promptText = "";
  if (typeof params.contents === "string") {
    promptText = params.contents;
  } else if (Array.isArray(params.contents)) {
    promptText = params.contents.map((p: any) => p.text || JSON.stringify(p)).join(" ");
  } else if (params.contents && typeof params.contents === "object") {
    const contents = params.contents as { parts?: Array<{ text?: string }>; role?: unknown };
    if (Array.isArray(contents.parts)) {
      promptText = contents.parts.map((p) => p.text).join(" ");
    } else if (contents.role) {
      promptText = JSON.stringify(contents);
    }
  }

  // Uses global AIRouter imported at top
  const res = await AIRouter.getInstance().routeTask("General", promptText, Math.random().toString(36).substring(7));
  return { text: res.content };
}

/**
 * Cleans up markdown code-fence wrapping, trailing commas, and stray comments
 * from an LLM's raw text response so it can be JSON.parse()'d, then parses it.
 * Returns null (never throws) if the text cannot be coerced into valid JSON.
 */
export function cleanAndParseJSON(rawText: string | undefined | null): any {
  if (!rawText) return null;
  let cleaned = rawText.trim();

  // Find first { and last }
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");

  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  } else {
    // Also try finding first [ and last ] in case of arrays
    const firstBracket = cleaned.indexOf("[");
    const lastBracket = cleaned.lastIndexOf("]");
    if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
      cleaned = cleaned.slice(firstBracket, lastBracket + 1);
    }
  }

  // Basic sanity check to remove markdown backticks if any remain
  cleaned = cleaned.replace(/```json/gi, "").replace(/```/g, "").trim();

  // Clean trailing commas in object or array structures
  cleaned = cleaned.replace(/,\s*([}\]])/g, "$1");

  try {
    return JSON.parse(cleaned);
  } catch (err) {
    // Try to strip out inline comments if any are present
    let stripped = cleaned
      .replace(/\/\*[\s\S]*?\*\//g, "") // multi-line comments
      .replace(/(?:^|[^:])\/\/.*$/gm, ""); // single-line comments (ignoring https:// etc)
    try {
      return JSON.parse(stripped.trim());
    } catch (innerErr) {
      console.warn("cleanAndParseJSON failed to parse raw text:", rawText);
      return null;
    }
  }
}
