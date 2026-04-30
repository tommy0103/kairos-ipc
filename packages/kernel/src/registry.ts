import type { EndpointUri, KernelFrame } from "../../protocol/src/index.ts";

export interface Connection {
  id: string;
  send(frame: KernelFrame): void;
}

export interface RegisterResult {
  ok: boolean;
  error?: string;
}

export class EndpointRegistry {
  private endpoints = new Map<EndpointUri, Connection>();
  private ownedUris = new Map<string, Set<EndpointUri>>();

  register(uri: EndpointUri, connection: Connection): RegisterResult {
    const existing = this.endpoints.get(uri);
    if (existing && existing.id !== connection.id) {
      return { ok: false, error: `endpoint already registered: ${uri}` };
    }

    this.endpoints.set(uri, connection);
    let uris = this.ownedUris.get(connection.id);
    if (!uris) {
      uris = new Set<EndpointUri>();
      this.ownedUris.set(connection.id, uris);
    }
    uris.add(uri);

    return { ok: true };
  }

  get(uri: EndpointUri): Connection | undefined {
    return this.endpoints.get(uri);
  }

  has(uri: EndpointUri): boolean {
    return this.endpoints.has(uri);
  }

  isOwnedBy(uri: EndpointUri, connection: Connection): boolean {
    return this.ownedUris.get(connection.id)?.has(uri) ?? false;
  }

  unregisterConnection(connection: Connection): EndpointUri[] {
    const uris = this.ownedUris.get(connection.id);
    if (!uris) {
      return [];
    }

    const removed = [...uris];
    for (const uri of uris) {
      const existing = this.endpoints.get(uri);
      if (existing?.id === connection.id) {
        this.endpoints.delete(uri);
      }
    }
    this.ownedUris.delete(connection.id);
    return removed;
  }

  list(): EndpointUri[] {
    return [...this.endpoints.keys()].sort();
  }
}
