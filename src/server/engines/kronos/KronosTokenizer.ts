export class KronosTokenizer {
  /**
   * Kronos treats market data as a language. 
   * This class would interface with the Python BPE/quantizer.
   */
  public quantize(ohlcv: any) {
    return { tokenized: true };
  }
}
