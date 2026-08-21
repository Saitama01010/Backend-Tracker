import { approvedVosDebugPath } from "../../lib/externalIntegrationPolicy.js";
import { fetchPbxJson, type VosCallRaw } from "../../integrations/pbx/client.js";

type PbxJsonFetcher = <T>(path: string) => Promise<T>;

export class PbxDiagnosticPathError extends Error {
  constructor() {
    super("PBX diagnostic path is not approved.");
    this.name = "PbxDiagnosticPathError";
  }
}

export class PbxDiagnosticsService {
  constructor(private readonly fetchJson: PbxJsonFetcher = fetchPbxJson) {}

  async getCalls(query: Record<string, string>) {
    const encoded = new URLSearchParams(query).toString();
    const data = await this.fetchJson<{ calls: VosCallRaw[]; total: number }>(
      `/api/calls${encoded ? `?${encoded}` : ""}`,
    );
    return { total: data.total, calls: data.calls };
  }

  async proxy(rawPath: unknown) {
    const path = approvedVosDebugPath(rawPath ?? "/api/calls?limit=1");
    if (!path) throw new PbxDiagnosticPathError();
    return this.fetchJson<unknown>(path);
  }
}

export const pbxDiagnosticsService = new PbxDiagnosticsService();
