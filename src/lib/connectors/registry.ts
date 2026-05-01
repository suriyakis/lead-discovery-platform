// Connector registry — maps templateType to its ISourceConnector instance.
//
// Connectors register themselves at module-load time via
// `registerConnector(...)`. The runner looks them up by template type when
// starting a run.

import type { ConnectorTemplateType } from '@/lib/db/schema/connectors';
import type { ISourceConnector } from './types';

const REGISTRY = new Map<ConnectorTemplateType, ISourceConnector>();

export function registerConnector(connector: ISourceConnector): void {
  REGISTRY.set(connector.type, connector);
}

export function getConnector(type: ConnectorTemplateType): ISourceConnector {
  const connector = REGISTRY.get(type);
  if (!connector) {
    throw new Error(`No connector registered for template type "${type}"`);
  }
  return connector;
}

export function listConnectors(): readonly ISourceConnector[] {
  return Array.from(REGISTRY.values());
}

/** For tests — clear the registry between cases. */
export function _resetConnectorRegistry(): void {
  REGISTRY.clear();
}
