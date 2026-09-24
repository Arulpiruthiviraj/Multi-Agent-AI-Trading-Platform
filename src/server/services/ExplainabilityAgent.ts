/**
 * ==========================================================
 * Module:
 * ExplainabilityAgent.ts
 *
 * Purpose:
 * Core implementation and logic for the ExplainabilityAgent.ts module within the Argus Trading Terminal.
 *
 * Responsibilities:
 * - State management and logic execution for ExplainabilityAgent
 * - Interface with backend APIs and EventBus
 * - Render UI components (if React)
 *
 * Inputs:
 * - Module dependencies and injected props
 *
 * Outputs:
 * - Formatted data or React Elements
 *
 * Emits:
 * - Relevant system events
 *
 * Dependencies:
 * - Standard Argus architecture layers
 *
 * Called By:
 * - Argus Routing / Parent Components
 *
 * Never:
 * - Mutate global state directly without EventBus
 * - Call AI providers directly (Must use AIRouter)
 *
 * ==========================================================
 */

import { eventBus } from '../core/EventBus';
import { tradeTraces } from '../core/EventStore';
import { db } from '../db';
import { explainabilityReports } from '../db/schema';
import { AIRouter } from '../ai/AIRouter';



export class ExplainabilityAgent {
  constructor() {
    eventBus.on('ORDER_EXECUTED', async (order) => {
      this.generateReport(order.traceId, order.symbol, order.side, "EXECUTED");
    });
    
    eventBus.on('RISK_ASSESSMENT_COMPLETED', async (assessment) => {
      if (!assessment.approved) {
         this.generateReport(assessment.traceId, assessment.symbol, assessment.side, "VETOED");
      }
    });
  }

  async generateReport(traceId: string, symbol: string, decision: string, outcome: string) {
    if (!traceId || !process.env.GEMINI_API_KEY) return;
    
    const events = tradeTraces[traceId];
    if (!events || events.length === 0) return;

    try {
      const traceSummary = events.map(e => `[${e.type}] ${JSON.stringify(e.payload)}`).join('\n');
      
      const prompt = `You are the Lead Quantitative Analyst for the Argus Autonomous Trading Platform.
A trade decision was just finalized. Outcome: ${outcome}. Symbol: ${symbol}. Decision: ${decision}.

Here is the raw system trace log for this entire decision lifecycle:
${traceSummary}

Write a comprehensive "Human Explainability Report" answering:
1. Why this stock?
2. Which indicators agreed?
3. Which AI agents supported it and which opposed it?
4. What risks were identified?
5. Why was the position size chosen (if executed) or why was it vetoed?

Use Markdown formatting. Make it sound professional, analytical, and objective.`;

      const res = await AIRouter.getInstance().routeTask('ExplainabilityAgent', prompt, Math.random().toString(36).substring(7));
          const response = { text: res.content };

      const reportText = response.text || "No report generated.";
      
      // traceId is the primary key (schema.ts:568). ORDER_EXECUTED/RISK_ASSESSMENT_COMPLETED can
      // both legitimately fire more than once for the same traceId (e.g. a duplicate EventBus
      // emission, or a partial-fill sequence that re-triggers ORDER_EXECUTED) - a plain insert
      // then throws a UNIQUE constraint violation that was previously silently swallowed by the
      // catch block below (console.log only), so the caller had no way to know report generation
      // "failed" that way vs. any other reason. First report for a given decision lifecycle is
      // kept: it was generated closest to the actual RISK_ASSESSMENT_COMPLETED/ORDER_EXECUTED
      // event with the freshest trace data available at the time, and a later duplicate call is a
      // re-fire of the same underlying event rather than new information that should overwrite it.
      await db.insert(explainabilityReports).values({
         traceId,
         symbol,
         decision: `${decision} - ${outcome}`,
         reportText,
         timestamp: new Date().toISOString()
      }).onConflictDoNothing();
      
      console.log(`[ExplainabilityAgent] Generated report for ${traceId} (${symbol})`);
      
    } catch (e) {
      console.log(`[ExplainabilityAgent] Failed to generate report for ${traceId}: ${e}`);
    }
  }
}

export const explainabilityAgent = new ExplainabilityAgent();
