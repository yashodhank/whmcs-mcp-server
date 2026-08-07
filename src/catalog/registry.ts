import type { CatalogMachineOperation, CatalogMachineView, OperationDefinition } from './types.js';
import { DECLARED_WHMCS_CAPABILITIES } from './declaredCapabilities.js';
import { z } from 'zod';

const DECLARED_READ_ACTIONS = new Set(
  DECLARED_WHMCS_CAPABILITIES.map((declaration) => declaration.action)
);

export class CatalogValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogValidationError';
  }
}

function requireNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) throw new CatalogValidationError(`${label} must not be empty`);
}

function validateDefinition(definition: OperationDefinition, globalMaxPageSize: number): void {
  requireNonEmpty(definition.id, 'operation id');
  requireNonEmpty(definition.publicName, `${definition.id} publicName`);
  requireNonEmpty(definition.domain, `${definition.id} domain`);
  if (!Number.isInteger(definition.version) || definition.version < 1) {
    throw new CatalogValidationError(`${definition.id} version must be a positive integer`);
  }

  const readLike = definition.effects === 'pure' || definition.effects === 'read';
  if (readLike && definition.annotations.readOnlyHint !== true) {
    throw new CatalogValidationError(
      `${definition.id} read-like effects require readOnlyHint=true`
    );
  }
  if (readLike && definition.annotations.destructiveHint === true) {
    throw new CatalogValidationError(`${definition.id} read-like effects cannot be destructive`);
  }
  if (!readLike && definition.annotations.readOnlyHint === true) {
    throw new CatalogValidationError(`${definition.id} mutation effects cannot be read-only`);
  }
  if (
    !readLike &&
    definition.annotations.destructiveHint !== true &&
    definition.annotations.destructiveHint !== false
  ) {
    throw new CatalogValidationError(
      `${definition.id} draft/write operations require an explicit destructiveHint boolean`
    );
  }

  if (definition.effects === 'write' || definition.effects === 'draft') {
    if (definition.governance.scope === null || definition.governance.scope.trim().length === 0) {
      throw new CatalogValidationError(
        `${definition.id} draft/write operations require a governed scope`
      );
    }
    if (definition.riskTier !== 'medium' && definition.riskTier !== 'high') {
      throw new CatalogValidationError(
        `${definition.id} draft/write operations require medium or high risk`
      );
    }
  }

  if (definition.effects === 'read') {
    if (definition.whmcsActions.length === 0 || definition.capability.mode !== 'all') {
      throw new CatalogValidationError(
        `${definition.id} reads require WHMCS actions and an all-actions capability gate`
      );
    }
    if (definition.capability.probe === 'none') {
      throw new CatalogValidationError(`${definition.id} reads require explicit probe behavior`);
    }
    for (const action of definition.whmcsActions) {
      if (!DECLARED_READ_ACTIONS.has(action)) {
        throw new CatalogValidationError(
          `${definition.id} declares an unknown read action: ${action}`
        );
      }
    }
    if (new Set(definition.whmcsActions).size !== definition.whmcsActions.length) {
      throw new CatalogValidationError(`${definition.id} declares duplicate WHMCS actions`);
    }
  }
  if (definition.effects === 'pure' && definition.whmcsActions.length > 0) {
    throw new CatalogValidationError(
      `${definition.id} pure operations cannot declare WHMCS actions`
    );
  }
  if (definition.capability.probe !== 'none' && definition.cache.mode !== 'none') {
    throw new CatalogValidationError(`${definition.id} probes cannot use operation result caching`);
  }
  if (
    (definition.effects === 'write' || definition.effects === 'draft') &&
    definition.cache.mode !== 'none'
  ) {
    throw new CatalogValidationError(`${definition.id} draft/write operations cannot be cached`);
  }
  if (definition.cache.mode === 'ttl' && definition.cache.ttlMs <= 0) {
    throw new CatalogValidationError(`${definition.id} cache ttlMs must be positive`);
  }
  if (definition.governance.rawWhmcsOutput && definition.governance.output === 'none') {
    throw new CatalogValidationError(
      `${definition.id} raw WHMCS output requires output governance`
    );
  }
  if (definition.cost.maxWhmcsCalls < 0 || definition.cost.maxItems < 0) {
    throw new CatalogValidationError(`${definition.id} cost bounds cannot be negative`);
  }
  if (definition.cost.kind === 'bounded_fanout') {
    if (definition.cost.maxWhmcsCalls < 1 || definition.cost.maxConcurrency < 1) {
      throw new CatalogValidationError(`${definition.id} fan-out cost must be explicitly bounded`);
    }
  }
  if (definition.pagination !== null) {
    const { defaultLimit, maxLimit } = definition.pagination;
    if (
      !Number.isInteger(defaultLimit) ||
      !Number.isInteger(maxLimit) ||
      defaultLimit < 1 ||
      maxLimit < defaultLimit ||
      maxLimit > globalMaxPageSize
    ) {
      throw new CatalogValidationError(
        `${definition.id} pagination must be positive and within the global page cap`
      );
    }
    if (!Object.prototype.hasOwnProperty.call(definition.inputSchema, 'limit')) {
      throw new CatalogValidationError(`${definition.id} pagination requires a limit input schema`);
    }
    const limitSchema = definition.inputSchema.limit;
    const parsedDefault = z.safeParse(limitSchema, undefined);
    if (!parsedDefault.success || parsedDefault.data !== defaultLimit) {
      throw new CatalogValidationError(
        `${definition.id} limit schema default must match pagination.defaultLimit`
      );
    }
    if (z.safeParse(limitSchema, maxLimit + 1).success) {
      throw new CatalogValidationError(
        `${definition.id} limit schema permits values above pagination.maxLimit`
      );
    }
  }
}

function freezeDefinition(definition: OperationDefinition): OperationDefinition {
  return Object.freeze({
    ...definition,
    inputSchema: Object.freeze({ ...definition.inputSchema }),
    outputSchema:
      definition.outputSchema instanceof z.ZodType
        ? definition.outputSchema
        : Object.freeze({ ...definition.outputSchema }),
    annotations: Object.freeze({ ...definition.annotations }),
    whmcsActions: Object.freeze([...definition.whmcsActions]),
    capability: Object.freeze({ ...definition.capability }),
    governance: Object.freeze({ ...definition.governance }),
    cache: Object.freeze({ ...definition.cache }),
    cost: Object.freeze({ ...definition.cost }),
    auth: Object.freeze({ ...definition.auth }),
    pagination: definition.pagination === null ? null : Object.freeze({ ...definition.pagination }),
    prerequisites: Object.freeze([...definition.prerequisites]),
    fallbacks: Object.freeze([...definition.fallbacks]),
    protocolFeatures: Object.freeze([...definition.protocolFeatures]),
  });
}

function machineOperation(definition: OperationDefinition): CatalogMachineOperation {
  return {
    id: definition.id,
    public_name: definition.publicName,
    domain: definition.domain,
    description: definition.description,
    effects: definition.effects,
    risk_tier: definition.riskTier,
    whmcs_actions: definition.whmcsActions,
    capability: definition.capability,
    governance: definition.governance,
    cache: definition.cache,
    cost: definition.cost,
    auth: definition.auth,
    pagination: definition.pagination,
    prerequisites: definition.prerequisites,
    fallbacks: definition.fallbacks,
    protocol_features: definition.protocolFeatures,
    version: definition.version,
  };
}

export class OperationCatalog {
  readonly #definitions: readonly OperationDefinition[];
  readonly #byId: ReadonlyMap<string, OperationDefinition>;
  readonly #byPublicName: ReadonlyMap<string, OperationDefinition>;

  constructor(
    definitions: readonly OperationDefinition[],
    readonly version: number,
    globalMaxPageSize: number
  ) {
    if (!Number.isInteger(version) || version < 1) {
      throw new CatalogValidationError('catalog version must be a positive integer');
    }
    const byId = new Map<string, OperationDefinition>();
    const byPublicName = new Map<string, OperationDefinition>();
    const frozen = definitions.map((candidate) => {
      validateDefinition(candidate, globalMaxPageSize);
      if (byId.has(candidate.id)) {
        throw new CatalogValidationError(`duplicate operation id: ${candidate.id}`);
      }
      if (byPublicName.has(candidate.publicName)) {
        throw new CatalogValidationError(
          `duplicate public operation name: ${candidate.publicName}`
        );
      }
      const definition = freezeDefinition(candidate);
      byId.set(definition.id, definition);
      byPublicName.set(definition.publicName, definition);
      return definition;
    });
    this.#definitions = Object.freeze(frozen);
    this.#byId = byId;
    this.#byPublicName = byPublicName;
  }

  definitions(): readonly OperationDefinition[] {
    return this.#definitions;
  }

  getById(id: string): OperationDefinition | undefined {
    return this.#byId.get(id);
  }

  getByPublicName(name: string): OperationDefinition | undefined {
    return this.#byPublicName.get(name);
  }

  machineView(): CatalogMachineView {
    return {
      schema_version: 1,
      catalog_version: this.version,
      operations: this.#definitions
        .map(machineOperation)
        .sort((left, right) => left.id.localeCompare(right.id)),
    };
  }
}
