export interface ConfigDoc {
  summary: string;
  source: string;
}

interface ConfigDocRule {
  pathPattern: string;
  doc: ConfigDoc;
}

export interface FixedArraySpec {
  pathPattern: string;
  label: string;
  options: string[];
  unique: boolean;
  allowCustom: boolean;
  source: string;
}

const CONFIG_DOCS: ConfigDocRule[] = [
  {
    pathPattern: 'logger.filter',
    doc: {
      summary: 'Rust log filter directive list used by CKB logger.',
      source: 'CKB configure docs',
    },
  },
  {
    pathPattern: 'rpc.listen_address',
    doc: {
      summary: 'Address for JSON-RPC server binding (host:port).',
      source: 'CKB configure docs',
    },
  },
  {
    pathPattern: 'rpc.max_request_body_size',
    doc: {
      summary: 'Maximum HTTP RPC request body size in bytes.',
      source: 'CKB configure docs',
    },
  },
  {
    pathPattern: 'rpc.modules',
    doc: {
      summary: 'Enabled RPC modules; known defaults plus custom module names if supported.',
      source: 'CKB configure docs',
    },
  },
  {
    pathPattern: 'rpc.modules.#',
    doc: {
      summary: 'One enabled RPC module entry.',
      source: 'CKB configure docs',
    },
  },
  {
    pathPattern: 'network.listen_addresses',
    doc: {
      summary: 'Node P2P listen multiaddr list.',
      source: 'CKB configure docs',
    },
  },
  {
    pathPattern: 'network.listen_addresses.#',
    doc: {
      summary: 'One P2P listen multiaddr entry.',
      source: 'CKB configure docs',
    },
  },
  {
    pathPattern: 'network.bootnodes',
    doc: {
      summary: 'Seed peers used for bootstrap discovery.',
      source: 'CKB configure docs',
    },
  },
  {
    pathPattern: 'network.bootnodes.#',
    doc: {
      summary: 'One bootnode multiaddr entry.',
      source: 'CKB configure docs',
    },
  },
  {
    pathPattern: 'network.max_peers',
    doc: {
      summary: 'Maximum connected peers (inbound + outbound).',
      source: 'CKB configure docs',
    },
  },
  {
    pathPattern: 'network.support_protocols',
    doc: {
      summary: 'Enabled CKB p2p protocols; must include Sync and Identify.',
      source: 'CKB configure docs / CKB protocol definitions',
    },
  },
  {
    pathPattern: 'network.support_protocols.#',
    doc: {
      summary: 'One enabled p2p protocol name.',
      source: 'CKB protocol definitions',
    },
  },
  {
    pathPattern: 'miner.client.rpc_url',
    doc: {
      summary: 'CKB RPC endpoint used by ckb-miner.',
      source: 'CKB miner configure docs',
    },
  },
  {
    pathPattern: 'miner.client.poll_interval',
    doc: {
      summary: 'Polling interval for new block templates (ms).',
      source: 'CKB miner configure docs',
    },
  },
  {
    pathPattern: 'miner.client.block_on_submit',
    doc: {
      summary: 'Wait for submit completion before next loop.',
      source: 'CKB miner configure docs',
    },
  },
];

const FIXED_ARRAY_SPECS: FixedArraySpec[] = [
  {
    pathPattern: 'network.support_protocols',
    label: 'Network Protocols',
    options: [
      'Ping',
      'Discovery',
      'Identify',
      'Feeler',
      'DisconnectMessage',
      'Sync',
      'Relay',
      'Time',
      'Alert',
      'LightClient',
      'Filter',
    ],
    unique: true,
    allowCustom: false,
    source: 'CKB protocol definitions',
  },
  {
    pathPattern: 'rpc.modules',
    label: 'RPC Modules',
    // Keep in sync with the module list in ckb/devnet/ckb.toml; "Terminal"
    // powers ckb-tui's get_overview metrics used by `offckb status`.
    options: [
      'Net',
      'Pool',
      'Miner',
      'Chain',
      'Stats',
      'Experiment',
      'Debug',
      'IntegrationTest',
      'Indexer',
      'RichIndexer',
      'Subscription',
      'Terminal',
    ],
    unique: true,
    allowCustom: true,
    source: 'CKB configure docs',
  },
];

function splitPattern(pattern: string): string[] {
  return pattern.split('.').filter(Boolean);
}

function isNumericSegment(value: string): boolean {
  return /^\d+$/.test(value);
}

function matchPattern(pathSegments: string[], patternSegments: string[]): boolean {
  if (pathSegments.length !== patternSegments.length) {
    return false;
  }

  return patternSegments.every((patternSegment, index) => {
    if (patternSegment === '*') {
      return true;
    }

    if (patternSegment === '#') {
      return isNumericSegment(pathSegments[index]);
    }

    return pathSegments[index] === patternSegment;
  });
}

function wildcardScore(patternSegments: string[]): number {
  return patternSegments.filter((segment) => segment === '*' || segment === '#').length;
}

export function getConfigDoc(pathSegments: string[]): ConfigDoc | null {
  const matches = CONFIG_DOCS.filter((rule) => matchPattern(pathSegments, splitPattern(rule.pathPattern))).sort(
    (a, b) => {
      const aScore = wildcardScore(splitPattern(a.pathPattern));
      const bScore = wildcardScore(splitPattern(b.pathPattern));
      return aScore - bScore;
    },
  );

  if (matches.length === 0) {
    return null;
  }

  return matches[0].doc;
}

export function getFixedArraySpec(pathSegments: string[]): FixedArraySpec | null {
  const match = FIXED_ARRAY_SPECS.find((spec) => matchPattern(pathSegments, splitPattern(spec.pathPattern)));
  return match ?? null;
}

export function getFixedArraySpecFromEntryPath(pathSegments: string[]): FixedArraySpec | null {
  const direct = getFixedArraySpec(pathSegments);
  if (direct != null) {
    return direct;
  }

  if (pathSegments.length === 0) {
    return null;
  }

  const last = pathSegments[pathSegments.length - 1];
  if (!isNumericSegment(last)) {
    return null;
  }

  return getFixedArraySpec(pathSegments.slice(0, -1));
}
