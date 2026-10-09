/** Control-plane scheduling only. No signal calculation, additional workers or provider calls. */
export class QuantAdmissionQueue {
  private background: string[];
  private admissions: string[] = [];
  private known: Set<string>;
  private attempted = new Set<string>();
  private admissionBurst = 0;
  constructor(symbols: readonly string[], private readonly maxBurst: number) {
    this.background = [...new Set(symbols)];
    this.known = new Set(this.background);
  }
  refresh(active: readonly string[], urgent: readonly string[] = []): void {
    const current = new Set(active);
    // Bound pending work to current active membership; no durable duplicate queue.
    this.background = this.background.filter(s => current.has(s));
    this.admissions = this.admissions.filter(s => current.has(s));
    for (const symbol of current) {
      if (!this.known.has(symbol) && !this.attempted.has(symbol)) this.admissions.push(symbol);
    }
    const promote = new Set(urgent.filter(s => current.has(s) && !this.attempted.has(s)));
    for (const symbol of this.background) if (promote.has(symbol) && !this.admissions.includes(symbol)) this.admissions.push(symbol);
    this.background = this.background.filter(s => !promote.has(s));
    this.known = current;
  }
  take(): string | undefined {
    let symbol: string | undefined;
    if (this.admissions.length && (this.admissionBurst < this.maxBurst || !this.background.length)) {
      symbol = this.admissions.shift();
      this.admissionBurst++;
    } else {
      symbol = this.background.shift();
      this.admissionBurst = 0;
    }
    if (symbol) this.attempted.add(symbol);
    return symbol;
  }
  pending(): string[] { return [...this.admissions, ...this.background]; }
}
