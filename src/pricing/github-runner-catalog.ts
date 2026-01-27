/**
 * GitHub Actions Runner Pricing Catalog
 * 
 * Updated: January 2026
 * Source: https://docs.github.com/en/enterprise-cloud@latest/billing/reference/actions-runner-pricing
 * 
 * Key Points:
 * - GitHub-hosted runners are ephemeral, providing better security isolation
 * - Public repos: Standard runners are FREE with unlimited minutes
 * - Private repos: Charged per minute after included minutes
 * - Standard runners: Different specs for public (4 CPU) vs private (2 CPU) repos
 * - Larger runners: Available for GitHub Team/Enterprise Cloud plans
 * - ARM runners: Generally 25-35% cheaper than x64 equivalents
 */

export interface RunnerSpec {
  sku: 'linux' | 'windows' | 'macos';
  name: string;
  vcpus: number;
  ramGb: number;
  publicVcpus?: number;
  publicRamGb?: number;
  isLarger: boolean;
  isFreePublic: boolean;
  costPerMinPrivate: number;  // Cost for private repos
  costPerMinPublic: number;   // Cost for public repos (0 for free)
  architecture: 'x64' | 'arm64' | 'apple-silicon';
  storageSsd?: number;        // SSD storage in GB
}

// Canonical free standard runner labels (free on public repos only)
export const FREE_RUNNER_LABELS = new Set([
  'ubuntu-latest', 'ubuntu-24.04', 'ubuntu-22.04',
  'windows-latest', 'windows-2025', 'windows-2022',
  'macos-latest', 'macos-14', 'macos-15',
]);

/**
 * GitHub-Hosted Runner Catalog
 * 
 * IMPORTANT: Standard runner specs differ by repository visibility:
 * - PUBLIC repos: ubuntu/windows-latest = 4 CPU, 16GB RAM (FREE, unlimited)
 * - PRIVATE repos: ubuntu/windows-latest = 2 CPU, 7GB RAM (PAID per minute)
 */
export const GITHUB_RUNNERS: Record<string, RunnerSpec> = {
  // ============================================
  // Standard Hosted Runners (FREE for public repos)
  // ============================================
  
  // Linux Standard
  'ubuntu-latest': {
    sku: 'linux',
    name: 'Ubuntu Standard Runner',
    vcpus: 2,        // Private repo specs
    ramGb: 7,
    publicVcpus: 4,  // Public repo specs
    publicRamGb: 16,
    isLarger: false,
    isFreePublic: true,
    costPerMinPrivate: 0.006,
    costPerMinPublic: 0,
    architecture: 'x64',
    storageSsd: 14,
  },
  'ubuntu-24.04': {
    sku: 'linux',
    name: 'Ubuntu 24.04 Standard Runner',
    vcpus: 2,
    ramGb: 7,
    publicVcpus: 4,
    publicRamGb: 16,
    isLarger: false,
    isFreePublic: true,
    costPerMinPrivate: 0.006,
    costPerMinPublic: 0,
    architecture: 'x64',
    storageSsd: 14,
  },
  'ubuntu-22.04': {
    sku: 'linux',
    name: 'Ubuntu 22.04 Standard Runner',
    vcpus: 2,
    ramGb: 7,
    publicVcpus: 4,
    publicRamGb: 16,
    isLarger: false,
    isFreePublic: true,
    costPerMinPrivate: 0.006,
    costPerMinPublic: 0,
    architecture: 'x64',
    storageSsd: 14,
  },

  // Windows Standard
  'windows-latest': {
    sku: 'windows',
    name: 'Windows Standard Runner',
    vcpus: 2,
    ramGb: 7,
    publicVcpus: 4,
    publicRamGb: 16,
    isLarger: false,
    isFreePublic: true,
    costPerMinPrivate: 0.010,
    costPerMinPublic: 0,
    architecture: 'x64',
    storageSsd: 14,
  },
  'windows-2025': {
    sku: 'windows',
    name: 'Windows 2025 Standard Runner',
    vcpus: 2,
    ramGb: 7,
    publicVcpus: 4,
    publicRamGb: 16,
    isLarger: false,
    isFreePublic: true,
    costPerMinPrivate: 0.010,
    costPerMinPublic: 0,
    architecture: 'x64',
    storageSsd: 14,
  },
  'windows-2022': {
    sku: 'windows',
    name: 'Windows 2022 Standard Runner',
    vcpus: 2,
    ramGb: 7,
    publicVcpus: 4,
    publicRamGb: 16,
    isLarger: false,
    isFreePublic: true,
    costPerMinPrivate: 0.010,
    costPerMinPublic: 0,
    architecture: 'x64',
    storageSsd: 14,
  },

  // macOS Standard (Apple Silicon M1)
  'macos-latest': {
    sku: 'macos',
    name: 'macOS Standard Runner (M1)',
    vcpus: 3,
    ramGb: 7,
    publicVcpus: 3,
    publicRamGb: 7,
    isLarger: false,
    isFreePublic: true,
    costPerMinPrivate: 0.062,
    costPerMinPublic: 0,
    architecture: 'apple-silicon',
    storageSsd: 14,
  },
  'macos-14': {
    sku: 'macos',
    name: 'macOS 14 Standard Runner (M1)',
    vcpus: 3,
    ramGb: 7,
    publicVcpus: 3,
    publicRamGb: 7,
    isLarger: false,
    isFreePublic: true,
    costPerMinPrivate: 0.062,
    costPerMinPublic: 0,
    architecture: 'apple-silicon',
    storageSsd: 14,
  },
  'macos-15': {
    sku: 'macos',
    name: 'macOS 15 Standard Runner (M1)',
    vcpus: 3,
    ramGb: 7,
    publicVcpus: 3,
    publicRamGb: 7,
    isLarger: false,
    isFreePublic: true,
    costPerMinPrivate: 0.062,
    costPerMinPublic: 0,
    architecture: 'apple-silicon',
    storageSsd: 14,
  },

  // ============================================
  // Larger Linux x64 Runners
  // ============================================
  'linux-4-core': {
    sku: 'linux',
    name: 'Linux 4-core Larger Runner',
    vcpus: 4,
    ramGb: 16,
    isLarger: true,
    isFreePublic: false,
    costPerMinPrivate: 0.012,
    costPerMinPublic: 0.012,
    architecture: 'x64',
    storageSsd: 150,
  },
  'linux-8-core': {
    sku: 'linux',
    name: 'Linux 8-core Larger Runner',
    vcpus: 8,
    ramGb: 32,
    isLarger: true,
    isFreePublic: false,
    costPerMinPrivate: 0.022,
    costPerMinPublic: 0.022,
    architecture: 'x64',
    storageSsd: 300,
  },
  'linux-16-core': {
    sku: 'linux',
    name: 'Linux 16-core Larger Runner',
    vcpus: 16,
    ramGb: 64,
    isLarger: true,
    isFreePublic: false,
    costPerMinPrivate: 0.044,
    costPerMinPublic: 0.044,
    architecture: 'x64',
    storageSsd: 600,
  },
  'linux-32-core': {
    sku: 'linux',
    name: 'Linux 32-core Larger Runner',
    vcpus: 32,
    ramGb: 128,
    isLarger: true,
    isFreePublic: false,
    costPerMinPrivate: 0.088,
    costPerMinPublic: 0.088,
    architecture: 'x64',
    storageSsd: 1200,
  },
  'linux-64-core': {
    sku: 'linux',
    name: 'Linux 64-core Larger Runner',
    vcpus: 64,
    ramGb: 208,
    isLarger: true,
    isFreePublic: false,
    costPerMinPrivate: 0.176,
    costPerMinPublic: 0.176,
    architecture: 'x64',
    storageSsd: 2040,
  },

  // ============================================
  // Larger Linux ARM Runners (25-35% cheaper!)
  // ============================================
  'linux-4-core-arm': {
    sku: 'linux',
    name: 'Linux 4-core ARM Larger Runner',
    vcpus: 4,
    ramGb: 16,
    isLarger: true,
    isFreePublic: false,
    costPerMinPrivate: 0.008,
    costPerMinPublic: 0.008,
    architecture: 'arm64',
    storageSsd: 150,
  },
  'linux-8-core-arm': {
    sku: 'linux',
    name: 'Linux 8-core ARM Larger Runner',
    vcpus: 8,
    ramGb: 32,
    isLarger: true,
    isFreePublic: false,
    costPerMinPrivate: 0.014,
    costPerMinPublic: 0.014,
    architecture: 'arm64',
    storageSsd: 300,
  },
  'linux-16-core-arm': {
    sku: 'linux',
    name: 'Linux 16-core ARM Larger Runner',
    vcpus: 16,
    ramGb: 64,
    isLarger: true,
    isFreePublic: false,
    costPerMinPrivate: 0.026,
    costPerMinPublic: 0.026,
    architecture: 'arm64',
    storageSsd: 600,
  },
  'linux-32-core-arm': {
    sku: 'linux',
    name: 'Linux 32-core ARM Larger Runner',
    vcpus: 32,
    ramGb: 128,
    isLarger: true,
    isFreePublic: false,
    costPerMinPrivate: 0.052,
    costPerMinPublic: 0.052,
    architecture: 'arm64',
    storageSsd: 1200,
  },
  'linux-64-core-arm': {
    sku: 'linux',
    name: 'Linux 64-core ARM Larger Runner',
    vcpus: 64,
    ramGb: 208,
    isLarger: true,
    isFreePublic: false,
    costPerMinPrivate: 0.104,
    costPerMinPublic: 0.104,
    architecture: 'arm64',
    storageSsd: 2040,
  },

  // ============================================
  // Larger Windows x64 Runners
  // ============================================
  'windows-4-core': {
    sku: 'windows',
    name: 'Windows 4-core Larger Runner',
    vcpus: 4,
    ramGb: 16,
    isLarger: true,
    isFreePublic: false,
    costPerMinPrivate: 0.022,
    costPerMinPublic: 0.022,
    architecture: 'x64',
    storageSsd: 150,
  },
  'windows-8-core': {
    sku: 'windows',
    name: 'Windows 8-core Larger Runner',
    vcpus: 8,
    ramGb: 32,
    isLarger: true,
    isFreePublic: false,
    costPerMinPrivate: 0.042,
    costPerMinPublic: 0.042,
    architecture: 'x64',
    storageSsd: 300,
  },
  'windows-16-core': {
    sku: 'windows',
    name: 'Windows 16-core Larger Runner',
    vcpus: 16,
    ramGb: 64,
    isLarger: true,
    isFreePublic: false,
    costPerMinPrivate: 0.084,
    costPerMinPublic: 0.084,
    architecture: 'x64',
    storageSsd: 600,
  },
  'windows-32-core': {
    sku: 'windows',
    name: 'Windows 32-core Larger Runner',
    vcpus: 32,
    ramGb: 128,
    isLarger: true,
    isFreePublic: false,
    costPerMinPrivate: 0.168,
    costPerMinPublic: 0.168,
    architecture: 'x64',
    storageSsd: 1200,
  },
  'windows-64-core': {
    sku: 'windows',
    name: 'Windows 64-core Larger Runner',
    vcpus: 64,
    ramGb: 208,
    isLarger: true,
    isFreePublic: false,
    costPerMinPrivate: 0.336,
    costPerMinPublic: 0.336,
    architecture: 'x64',
    storageSsd: 2040,
  },

  // ============================================
  // Larger Windows ARM Runners
  // ============================================
  'windows-4-core-arm': {
    sku: 'windows',
    name: 'Windows 4-core ARM Larger Runner',
    vcpus: 4,
    ramGb: 16,
    isLarger: true,
    isFreePublic: false,
    costPerMinPrivate: 0.014,
    costPerMinPublic: 0.014,
    architecture: 'arm64',
    storageSsd: 150,
  },
  'windows-8-core-arm': {
    sku: 'windows',
    name: 'Windows 8-core ARM Larger Runner',
    vcpus: 8,
    ramGb: 32,
    isLarger: true,
    isFreePublic: false,
    costPerMinPrivate: 0.026,
    costPerMinPublic: 0.026,
    architecture: 'arm64',
    storageSsd: 300,
  },

  // ============================================
  // Larger macOS Intel Runners (Large)
  // ============================================
  'macos-13-large': {
    sku: 'macos',
    name: 'macOS 13 Large Runner (Intel)',
    vcpus: 12,
    ramGb: 30,
    isLarger: true,
    isFreePublic: false,
    costPerMinPrivate: 0.077,
    costPerMinPublic: 0.077,
    architecture: 'x64',
    storageSsd: 14,
  },
  'macos-14-large': {
    sku: 'macos',
    name: 'macOS 14 Large Runner (Intel)',
    vcpus: 12,
    ramGb: 30,
    isLarger: true,
    isFreePublic: false,
    costPerMinPrivate: 0.077,
    costPerMinPublic: 0.077,
    architecture: 'x64',
    storageSsd: 14,
  },
  'macos-15-large': {
    sku: 'macos',
    name: 'macOS 15 Large Runner (Intel)',
    vcpus: 12,
    ramGb: 30,
    isLarger: true,
    isFreePublic: false,
    costPerMinPrivate: 0.077,
    costPerMinPublic: 0.077,
    architecture: 'x64',
    storageSsd: 14,
  },
  'macos-latest-large': {
    sku: 'macos',
    name: 'macOS Large Runner (Intel)',
    vcpus: 12,
    ramGb: 30,
    isLarger: true,
    isFreePublic: false,
    costPerMinPrivate: 0.077,
    costPerMinPublic: 0.077,
    architecture: 'x64',
    storageSsd: 14,
  },

  // ============================================
  // Larger macOS Apple Silicon Runners (XLarge M2 Pro)
  // ============================================
  'macos-13-xlarge': {
    sku: 'macos',
    name: 'macOS 13 XLarge Runner (M2)',
    vcpus: 5,
    ramGb: 14,
    isLarger: true,
    isFreePublic: false,
    costPerMinPrivate: 0.102,
    costPerMinPublic: 0.102,
    architecture: 'apple-silicon',
    storageSsd: 14,
  },
  'macos-14-xlarge': {
    sku: 'macos',
    name: 'macOS 14 XLarge Runner (M2)',
    vcpus: 5,
    ramGb: 14,
    isLarger: true,
    isFreePublic: false,
    costPerMinPrivate: 0.102,
    costPerMinPublic: 0.102,
    architecture: 'apple-silicon',
    storageSsd: 14,
  },
  'macos-15-xlarge': {
    sku: 'macos',
    name: 'macOS 15 XLarge Runner (M2)',
    vcpus: 5,
    ramGb: 14,
    isLarger: true,
    isFreePublic: false,
    costPerMinPrivate: 0.102,
    costPerMinPublic: 0.102,
    architecture: 'apple-silicon',
    storageSsd: 14,
  },
  'macos-latest-xlarge': {
    sku: 'macos',
    name: 'macOS XLarge Runner (M2)',
    vcpus: 5,
    ramGb: 14,
    isLarger: true,
    isFreePublic: false,
    costPerMinPrivate: 0.102,
    costPerMinPublic: 0.102,
    architecture: 'apple-silicon',
    storageSsd: 14,
  },

  // ============================================
  // GPU Runners (Premium)
  // ============================================
  'gpu-linux-4-core': {
    sku: 'linux',
    name: 'Linux GPU Runner (T4)',
    vcpus: 4,
    ramGb: 16,
    isLarger: true,
    isFreePublic: false,
    costPerMinPrivate: 0.070,
    costPerMinPublic: 0.070,
    architecture: 'x64',
    storageSsd: 150,
  },
};

/**
 * Benefits of GitHub-hosted runners (use in recommendations)
 */
export const GITHUB_HOSTED_BENEFITS = [
  'Ephemeral, isolated VMs for clean, deterministic builds',
  'OS images patched and maintained by GitHub (reduced ops burden)',
  'Scales on demand; no capacity planning or host maintenance',
  'Security-hardened images with regular updates',
  'OIDC support for secure cloud deployments without static credentials',
  'Private networking available for on-prem/private resource access',
  'No infrastructure to manage, patch, or secure',
];

/**
 * When to consider self-hosted runners (rare cases only)
 */
export const SELF_HOSTED_CONSIDERATIONS = [
  'Custom hardware requirements (GPUs beyond T4, specialized ARM chips)',
  'Regulatory requirements mandating on-premises execution',
  'Need to access air-gapped networks with no private networking option',
  'Very specific OS/software configurations not available on GitHub-hosted',
];

/**
 * Calculate cost for a runner over a given duration
 */
export function calculateRunnerCost(
  runnerLabel: string,
  durationMinutes: number,
  isPublicRepo: boolean
): number {
  const spec = GITHUB_RUNNERS[runnerLabel];
  if (!spec) {
    // Unknown runner, assume standard Linux rate
    return durationMinutes * 0.006;
  }
  
  if (isPublicRepo && spec.isFreePublic) {
    return 0;
  }
  
  return durationMinutes * spec.costPerMinPrivate;
}

/**
 * Find the most cost-effective runner for a given workload
 */
export function findOptimalRunner(
  requiredVcpus: number,
  requiredRamGb: number,
  preferredOs: 'linux' | 'windows' | 'macos' = 'linux',
  isPublicRepo: boolean = false
): { label: string; spec: RunnerSpec; monthlyCost: number } | null {
  const candidates: { label: string; spec: RunnerSpec; cost: number }[] = [];
  
  for (const [label, spec] of Object.entries(GITHUB_RUNNERS)) {
    if (spec.sku !== preferredOs) continue;
    if (spec.vcpus < requiredVcpus) continue;
    if (spec.ramGb < requiredRamGb) continue;
    
    const costPerMin = isPublicRepo && spec.isFreePublic 
      ? 0 
      : spec.costPerMinPrivate;
    
    candidates.push({ label, spec, cost: costPerMin });
  }
  
  if (candidates.length === 0) return null;
  
  // Sort by cost, then by vcpus (prefer smaller when same cost)
  candidates.sort((a, b) => {
    if (a.cost !== b.cost) return a.cost - b.cost;
    return a.spec.vcpus - b.spec.vcpus;
  });
  
  const best = candidates[0];
  // Estimate monthly cost: assume 10 runs/day, 10 min each
  const monthlyMinutes = 10 * 30 * 10;
  
  return {
    label: best.label,
    spec: best.spec,
    monthlyCost: best.cost * monthlyMinutes,
  };
}

/**
 * Get runner recommendations for right-sizing
 */
export function getRunnerRecommendations(
  currentLabel: string,
  avgCpuPercent: number,
  avgMemPercent: number,
  isPublicRepo: boolean
): string[] {
  const recommendations: string[] = [];
  const spec = GITHUB_RUNNERS[currentLabel];
  
  if (!spec) {
    recommendations.push('📊 Unable to identify current runner specifications');
    return recommendations;
  }
  
  // Check for underutilization
  if (avgCpuPercent < 30 && avgMemPercent < 30) {
    recommendations.push('⬇️ **Consider downsizing** - Runner is significantly underutilized');
    
    // Find smaller options in same OS family
    const smallerOptions = Object.entries(GITHUB_RUNNERS)
      .filter(([, s]) => s.sku === spec.sku && s.vcpus < spec.vcpus)
      .sort((a, b) => b[1].vcpus - a[1].vcpus);
    
    if (smallerOptions.length > 0) {
      const [label, smaller] = smallerOptions[0];
      const savings = ((spec.costPerMinPrivate - smaller.costPerMinPrivate) / spec.costPerMinPrivate * 100).toFixed(0);
      recommendations.push(`💡 Try \`${label}\` (${smaller.vcpus} vCPU, ${smaller.ramGb}GB) - ~${savings}% cheaper`);
    }
  }
  
  // Check for overutilization
  if (avgCpuPercent > 85 || avgMemPercent > 85) {
    recommendations.push('⬆️ **Consider upgrading** - Runner may be a bottleneck');
    
    // Find larger options in same OS family
    const largerOptions = Object.entries(GITHUB_RUNNERS)
      .filter(([, s]) => s.sku === spec.sku && s.vcpus > spec.vcpus)
      .sort((a, b) => a[1].vcpus - b[1].vcpus);
    
    if (largerOptions.length > 0) {
      const [label, larger] = largerOptions[0];
      recommendations.push(`💡 Try \`${label}\` (${larger.vcpus} vCPU, ${larger.ramGb}GB) for faster builds`);
    }
  }
  
  // ARM recommendation for Linux/Windows x64
  if (spec.architecture === 'x64' && (spec.sku === 'linux' || spec.sku === 'windows')) {
    const armLabel = currentLabel.includes('-core') 
      ? currentLabel + '-arm'
      : currentLabel.replace('ubuntu', 'linux').replace('windows', 'windows') + '-arm';
    
    if (GITHUB_RUNNERS[armLabel]) {
      const armSpec = GITHUB_RUNNERS[armLabel];
      const savings = ((spec.costPerMinPrivate - armSpec.costPerMinPrivate) / spec.costPerMinPrivate * 100).toFixed(0);
      recommendations.push(`🦾 **ARM Option**: \`${armLabel}\` - ~${savings}% cheaper (if your workload supports ARM)`);
    }
  }
  
  // Public repo optimization
  if (!isPublicRepo && spec.isFreePublic) {
    recommendations.push('🆓 **Tip**: This runner is FREE for public repositories');
  }
  
  return recommendations;
}

/**
 * Format runner catalog for display
 */
export function formatRunnerCatalog(osFilter?: 'linux' | 'windows' | 'macos'): string {
  let output = `## 🖥️ GitHub-Hosted Runner Catalog\n\n`;
  
  const groups: Record<string, { label: string; spec: RunnerSpec }[]> = {
    'Standard (FREE for public repos)': [],
    'Larger Linux x64': [],
    'Larger Linux ARM (25-35% cheaper!)': [],
    'Larger Windows x64': [],
    'Larger Windows ARM': [],
    'Larger macOS Intel': [],
    'Larger macOS Apple Silicon': [],
  };
  
  for (const [label, spec] of Object.entries(GITHUB_RUNNERS)) {
    if (osFilter && spec.sku !== osFilter) continue;
    
    if (spec.isFreePublic) {
      groups['Standard (FREE for public repos)'].push({ label, spec });
    } else if (spec.sku === 'linux' && spec.architecture === 'x64') {
      groups['Larger Linux x64'].push({ label, spec });
    } else if (spec.sku === 'linux' && spec.architecture === 'arm64') {
      groups['Larger Linux ARM (25-35% cheaper!)'].push({ label, spec });
    } else if (spec.sku === 'windows' && spec.architecture === 'x64') {
      groups['Larger Windows x64'].push({ label, spec });
    } else if (spec.sku === 'windows' && spec.architecture === 'arm64') {
      groups['Larger Windows ARM'].push({ label, spec });
    } else if (spec.sku === 'macos' && spec.architecture === 'x64') {
      groups['Larger macOS Intel'].push({ label, spec });
    } else if (spec.sku === 'macos' && spec.architecture === 'apple-silicon') {
      groups['Larger macOS Apple Silicon'].push({ label, spec });
    }
  }
  
  for (const [groupName, runners] of Object.entries(groups)) {
    if (runners.length === 0) continue;
    
    output += `### ${groupName}\n\n`;
    output += `| Runner Label | vCPUs | RAM | $/min (Private) | Architecture |\n`;
    output += `|:-------------|------:|----:|----------------:|:-------------|\n`;
    
    for (const { label, spec } of runners) {
      const cost = spec.isFreePublic ? 'FREE (public) / $' + spec.costPerMinPrivate.toFixed(3) : '$' + spec.costPerMinPrivate.toFixed(3);
      output += `| \`${label}\` | ${spec.vcpus} | ${spec.ramGb}GB | ${cost} | ${spec.architecture} |\n`;
    }
    output += '\n';
  }
  
  output += `\n---\n`;
  output += `📚 [Full Pricing Documentation](https://docs.github.com/en/enterprise-cloud@latest/billing/reference/actions-runner-pricing)\n`;
  
  return output;
}

/**
 * Hosted Runner Specs from GitHub API
 * Represents the machine_size_details returned by the hosted runners API
 */
export interface HostedRunnerMachineSpecs {
  id: string;          // e.g., "4-core", "8-core"
  cpu_cores: number;
  memory_gb: number;
  storage_gb: number;
}

export interface HostedRunnerInfo {
  id: number;
  name: string;        // Custom name like "tsvi-linux8cores" or "runner1"
  platform: string;    // e.g., "linux-x64", "win-x64"
  machine_size_details: HostedRunnerMachineSpecs;
  status: string;
}

/**
 * Cache for hosted runner specs lookup
 * Maps runner name -> specs for quick lookup during cost calculation
 */
export interface HostedRunnerLookup {
  [runnerName: string]: {
    cpuCores: number;
    memoryGb: number;
    storageGb: number;
    platform: string;
    costPerMin: number;
  };
}

/**
 * Infer runner specs from CPU cores and platform
 * Maps (cpuCores, platform) -> matching catalog entry
 */
export function inferRunnerFromSpecs(
  cpuCores: number,
  platform: string,
  memoryGb?: number
): { label: string; spec: RunnerSpec; costPerMin: number } | null {
  const isWindows = platform.toLowerCase().includes('win');
  const isMacOS = platform.toLowerCase().includes('mac') || platform.toLowerCase().includes('osx');
  const isArm = platform.toLowerCase().includes('arm');
  
  const targetSku: 'linux' | 'windows' | 'macos' = isMacOS ? 'macos' : isWindows ? 'windows' : 'linux';
  const targetArch: 'x64' | 'arm64' | 'apple-silicon' = isMacOS ? 'apple-silicon' : isArm ? 'arm64' : 'x64';
  
  // Find matching runner in catalog by CPU cores and specs
  let bestMatch: { label: string; spec: RunnerSpec } | null = null;
  let bestScore = -1;
  
  for (const [label, spec] of Object.entries(GITHUB_RUNNERS)) {
    if (spec.sku !== targetSku) continue;
    if (spec.architecture !== targetArch && !(isMacOS && spec.architecture === 'apple-silicon')) continue;
    
    // Score based on CPU match (exact match preferred)
    let score = 0;
    if (spec.vcpus === cpuCores) {
      score += 100;
    } else if (spec.vcpus >= cpuCores) {
      score += 50 - Math.abs(spec.vcpus - cpuCores);
    }
    
    // Bonus for memory match if provided
    if (memoryGb && spec.ramGb === memoryGb) {
      score += 50;
    }
    
    if (score > bestScore) {
      bestScore = score;
      bestMatch = { label, spec };
    }
  }
  
  if (bestMatch) {
    return {
      label: bestMatch.label,
      spec: bestMatch.spec,
      costPerMin: bestMatch.spec.costPerMinPrivate,
    };
  }
  
  return null;
}

/**
 * Detect runner type from job labels using pattern matching
 * Handles standard labels like "ubuntu-latest", "linux-8-core", and custom patterns
 */
export function detectRunnerFromLabels(
  labels: string[]
): { label: string; spec: RunnerSpec; costPerMin: number } | null {
  if (!labels || labels.length === 0) return null;
  
  // First, check for exact matches in the catalog
  for (const label of labels) {
    const normalizedLabel = label.toLowerCase();
    if (GITHUB_RUNNERS[normalizedLabel]) {
      const spec = GITHUB_RUNNERS[normalizedLabel];
      return { label: normalizedLabel, spec, costPerMin: spec.costPerMinPrivate };
    }
    // Check with exact case
    if (GITHUB_RUNNERS[label]) {
      const spec = GITHUB_RUNNERS[label];
      return { label, spec, costPerMin: spec.costPerMinPrivate };
    }
  }
  
  // Check for standard GitHub larger runner patterns
  const largerRunnerPatterns = [
    /^linux-(\d+)-core$/i,
    /^linux-(\d+)-core-arm$/i,
    /^windows-(\d+)-core$/i,
    /^windows-(\d+)-core-arm$/i,
    /^macos-(\d+)-core$/i,
    /^macos-large$/i,
    /^macos-xlarge$/i,
  ];
  
  for (const label of labels) {
    for (const pattern of largerRunnerPatterns) {
      if (pattern.test(label)) {
        const normalizedLabel = label.toLowerCase();
        if (GITHUB_RUNNERS[normalizedLabel]) {
          const spec = GITHUB_RUNNERS[normalizedLabel];
          return { label: normalizedLabel, spec, costPerMin: spec.costPerMinPrivate };
        }
      }
    }
  }
  
  // Try to infer from custom labels containing core count hints
  // Patterns like "8core", "8-core", "linux8cores", etc.
  for (const label of labels) {
    const coreMatch = label.match(/(\d+)[-_]?core/i);
    if (coreMatch) {
      const cores = parseInt(coreMatch[1], 10);
      const isWindows = labels.some(l => l.toLowerCase().includes('windows'));
      const isMacOS = labels.some(l => l.toLowerCase().includes('macos'));
      const isArm = labels.some(l => l.toLowerCase().includes('arm'));
      
      const platform = isMacOS ? 'macos' : isWindows ? 'windows' : 'linux';
      const suffix = isArm ? '-arm' : '';
      const catalogLabel = `${platform}-${cores}-core${suffix}`;
      
      if (GITHUB_RUNNERS[catalogLabel]) {
        const spec = GITHUB_RUNNERS[catalogLabel];
        return { label: catalogLabel, spec, costPerMin: spec.costPerMinPrivate };
      }
    }
  }
  
  return null;
}

/**
 * Calculate cost for a runner based on available information
 * Priority: 1) Hosted runner specs lookup, 2) Label detection, 3) Default OS pricing
 */
export function calculateRunnerCostAdvanced(
  runnerName: string,
  labels: string[],
  durationMinutes: number,
  isPublicRepo: boolean,
  hostedRunnerLookup?: HostedRunnerLookup
): { cost: number; detectedType: string; method: 'api' | 'label' | 'default' } {
  // 1. Try hosted runner lookup (most accurate for custom-named larger runners)
  if (hostedRunnerLookup && hostedRunnerLookup[runnerName]) {
    const runnerInfo = hostedRunnerLookup[runnerName];
    const cost = isPublicRepo ? 0 : durationMinutes * runnerInfo.costPerMin;
    return {
      cost,
      detectedType: `${runnerInfo.cpuCores}-core (${runnerInfo.platform})`,
      method: 'api',
    };
  }
  
  // 2. Try label-based detection
  const labelMatch = detectRunnerFromLabels(labels);
  if (labelMatch) {
    const cost = isPublicRepo && labelMatch.spec.isFreePublic 
      ? 0 
      : durationMinutes * labelMatch.costPerMin;
    return {
      cost,
      detectedType: labelMatch.label,
      method: 'label',
    };
  }
  
  // 3. Fall back to default OS-based pricing
  const osLabel = labels.find(l => 
    ['ubuntu', 'windows', 'macos', 'linux'].some(os => l.toLowerCase().includes(os))
  ) || 'linux';
  
  const defaultPricing: Record<string, number> = {
    'ubuntu': 0.008,
    'linux': 0.008,
    'windows': 0.016,
    'macos': 0.08,
  };
  
  const osKey = osLabel.toLowerCase().includes('windows') ? 'windows' 
    : osLabel.toLowerCase().includes('macos') ? 'macos' 
    : 'linux';
  
  const pricePerMin = defaultPricing[osKey] || 0.008;
  const isFreeStandard = FREE_RUNNER_LABELS.has(osLabel.toLowerCase());
  const cost = isPublicRepo && isFreeStandard ? 0 : durationMinutes * pricePerMin;
  
  return {
    cost,
    detectedType: `${osLabel} (standard)`,
    method: 'default',
  };
}

/**
 * Build hosted runner lookup from API response
 */
export function buildHostedRunnerLookup(
  hostedRunners: HostedRunnerInfo[]
): HostedRunnerLookup {
  const lookup: HostedRunnerLookup = {};
  
  for (const runner of hostedRunners) {
    const specs = runner.machine_size_details;
    const platform = runner.platform;
    
    // Infer cost from specs
    const inferredRunner = inferRunnerFromSpecs(specs.cpu_cores, platform, specs.memory_gb);
    const costPerMin = inferredRunner?.costPerMin || 0.008; // Default to standard Linux
    
    lookup[runner.name] = {
      cpuCores: specs.cpu_cores,
      memoryGb: specs.memory_gb,
      storageGb: specs.storage_gb,
      platform,
      costPerMin,
    };
  }
  
  return lookup;
}
