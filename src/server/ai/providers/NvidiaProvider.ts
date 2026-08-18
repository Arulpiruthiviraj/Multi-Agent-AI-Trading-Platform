import { OpenAICompatibleProvider } from './OpenAICompatibleProvider';
import { networkEndpoints } from '../../config/networkEndpoints';

export class NvidiaProvider extends OpenAICompatibleProvider {
  constructor() {
    super('NVIDIA', networkEndpoints.aiCloud.nvidiaBaseUrl, false);
  }
}
