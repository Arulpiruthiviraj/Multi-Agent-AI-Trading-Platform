import { OpenAICompatibleProvider } from './OpenAICompatibleProvider';

export class NvidiaProvider extends OpenAICompatibleProvider {
  constructor() {
    super('NVIDIA', 'https://integrate.api.nvidia.com/v1', false);
  }
}
