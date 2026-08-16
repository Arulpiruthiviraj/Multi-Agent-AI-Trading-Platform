/** Explicit capital labels. Never confuse these. Never invent broker equity. */

export interface CapitalLabels {
  researchInitialCapital: number;
  paperInitialCapital: number;
  argusAllocationBudget: number;
  brokerEquity: number | null;
  brokerEquityAvailable: boolean;
  defaultMaxTradeSizeDollars: number;
}

export function labeledCapitals(opts: {
  researchInitialCapital: number;
  paperInitialCapital: number;
  argusAllocationBudget: number;
  brokerEquity: number | null;
  defaultMaxTradeSizeDollars: number;
}): CapitalLabels {
  const available = opts.brokerEquity != null && Number.isFinite(opts.brokerEquity);
  return {
    researchInitialCapital: opts.researchInitialCapital,
    paperInitialCapital: opts.paperInitialCapital,
    argusAllocationBudget: opts.argusAllocationBudget,
    brokerEquity: available ? opts.brokerEquity : null,
    brokerEquityAvailable: available,
    defaultMaxTradeSizeDollars: opts.defaultMaxTradeSizeDollars,
  };
}
