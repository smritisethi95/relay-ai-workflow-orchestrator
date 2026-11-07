export interface CatalogParam {
  type: 'string' | 'number' | 'object' | 'boolean';
  required?: boolean;
  enum?: string[];
  templatable?: boolean;
  description?: string;
}

export interface CatalogNode {
  type: string;
  description: string;
  side_effect: boolean;
  requires_approval: boolean;
  params: Record<string, CatalogParam>;
  branches?: string[];
}

export interface CatalogTrigger {
  type: string;
  description: string;
  config: Record<string, CatalogParam>;
}

export interface NodeCatalogData {
  triggers: CatalogTrigger[];
  nodes: CatalogNode[];
}

/** Read-only view over data/node_catalog.json: the boundary for publish validation. */
export class Catalog {
  private readonly nodes: ReadonlyMap<string, CatalogNode>;
  private readonly triggers: ReadonlyMap<string, CatalogTrigger>;

  constructor(data: NodeCatalogData) {
    this.nodes = new Map(data.nodes.map((n) => [n.type, n]));
    this.triggers = new Map(data.triggers.map((t) => [t.type, t]));
  }

  node(type: string): CatalogNode | undefined {
    return this.nodes.get(type);
  }

  trigger(type: string): CatalogTrigger | undefined {
    return this.triggers.get(type);
  }

  nodeTypes(): string[] {
    return [...this.nodes.keys()];
  }

  triggerTypes(): string[] {
    return [...this.triggers.keys()];
  }

  isSideEffect(type: string): boolean {
    return this.nodes.get(type)?.side_effect === true;
  }

  requiresApproval(type: string): boolean {
    return this.nodes.get(type)?.requires_approval === true;
  }

  isBranching(type: string): boolean {
    return (this.nodes.get(type)?.branches?.length ?? 0) > 0;
  }
}
