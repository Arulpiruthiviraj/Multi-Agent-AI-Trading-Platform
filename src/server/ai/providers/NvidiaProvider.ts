import { OpenAICompatibleProvider } from './OpenAICompatibleProvider';
import { networkEndpoints } from '../../config/networkEndpoints';

export class NvidiaProvider extends OpenAICompatibleProvider {
  constructor() {
    super('NVIDIA', networkEndpoints.aiCloud.nvidiaBaseUrl, false);
  }

  /**
   * Real bug, found live: OpenAICompatibleProvider.initialize()'s generic fallback
   * ('gpt-3.5-turbo') is an OpenAI model name - NVIDIA's NIM catalog does not serve it, so every
   * call with no operator-configured defaultModel was guaranteed to 404 (91 real occurrences in
   * one ~5h session). Fail closed instead of guessing a different hardcoded model id (which could
   * just as easily go stale) - leave defaultModel empty and let authenticate() report "not
   * configured" so AIRouter skips this provider via its normal failover path, rather than burning
   * a real network round-trip on a request that can never succeed.
   */
  async initialize(apiKey?: string, defaultModel?: string): Promise<void> {
    this.apiKey = apiKey || '';
    this.defaultModel = defaultModel || '';
  }

  async authenticate(): Promise<boolean> {
    if (!this.defaultModel) return false;
    return super.authenticate();
  }
}
