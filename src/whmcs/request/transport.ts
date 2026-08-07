import axios, { type AxiosInstance } from 'axios';
import https from 'node:https';
import type { WhmcsTransport, WhmcsTransportResponse } from './types.js';

export class AxiosWhmcsTransport implements WhmcsTransport {
  private readonly agent: https.Agent;
  private readonly client: AxiosInstance;

  constructor(endpoint: string) {
    this.agent = new https.Agent({ keepAlive: true });
    this.client = axios.create({
      baseURL: endpoint,
      timeout: 30000,
      httpsAgent: this.agent,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  }

  async post(body: URLSearchParams, signal?: AbortSignal): Promise<WhmcsTransportResponse> {
    const response = await this.client.post('', body, { signal });
    return { status: response.status, data: response.data };
  }

  resetConnections(): void {
    this.agent.destroy();
  }
}
