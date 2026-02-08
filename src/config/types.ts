/**
 * Configuration Types for ActionsPulse MCP Server
 * 
 * These types define the structure of the central devops-config-repo
 * that provides policies, repository inventories, and workflow standards.
 */

// ============================================
// Main Configuration
// ============================================

export interface DevOpsConfig {
  $schema?: string;
  version: string;
  organization: OrganizationConfig;
  configRepo?: ConfigRepoSettings;
  paths: ConfigPaths;
  defaults: DefaultSettings;
}

export interface OrganizationConfig {
  name: string;
  github_org: string;
  environments?: string[];
  compliance?: string[];
}

export interface ConfigRepoSettings {
  owner: string;
  repo: string;
  branch: string;
  autoReload?: boolean;
  reloadInterval?: string; // e.g., "5m", "1h"
}

export interface ConfigPaths {
  policies: string;
  repositories: string;
  workflows: string;
  dashboards: string;
}

export interface DefaultSettings {
  enforcement: EnforcementLevel;
  autoFix: boolean;
  notifyOnViolation: boolean;
}

export type EnforcementLevel = 'strict' | 'advisory' | 'disabled';

// ============================================
// Workflow Policies
// ============================================

export interface WorkflowPolicy {
  apiVersion: string;
  kind: 'WorkflowPolicy';
  metadata: PolicyMetadata;
  spec: WorkflowPolicySpec;
}

export interface PolicyMetadata {
  name: string;
  version: string;
  description?: string;
}

export interface WorkflowPolicySpec {
  naming?: NamingPolicy;
  requirements?: WorkflowRequirements;
  forbidden?: ForbiddenPatterns;
  requiredSteps?: Record<string, RequiredStep[]>;
}

export interface NamingPolicy {
  pattern: string;
  message: string;
}

export interface WorkflowRequirements {
  timeout?: TimeoutPolicy;
  permissions?: PermissionsPolicy;
  concurrency?: ConcurrencyPolicy;
}

export interface TimeoutPolicy {
  enabled: boolean;
  maxMinutes: number;
  message: string;
}

export interface PermissionsPolicy {
  enabled: boolean;
  requireExplicit: boolean;
  allowed?: Record<string, string[]>;
  forbidden?: string[];
  message: string;
}

export interface ConcurrencyPolicy {
  enabled: boolean;
  requireCancelInProgress: boolean;
  message: string;
}

export interface ForbiddenPatterns {
  actions?: ForbiddenPattern[];
  secrets?: ForbiddenPattern[];
  commands?: ForbiddenPattern[];
}

export interface ForbiddenPattern {
  pattern: string;
  reason: string;
  context?: string;
}

export interface RequiredStep {
  name: string;
  pattern: string;
  environments?: string[];
}

// ============================================
// Repository Inventory
// ============================================

export interface RepositoryInventory {
  apiVersion: string;
  kind: 'RepositoryInventory';
  metadata: PolicyMetadata;
  spec: RepositoryInventorySpec;
}

export interface RepositoryInventorySpec {
  discovery?: DiscoverySettings;
  repositories?: RepositoryEntry[];
  groups?: Record<string, RepositoryGroup>;
}

export interface DiscoverySettings {
  enabled: boolean;
  includeArchived?: boolean;
  includeForked?: boolean;
  minStars?: number;
}

export interface RepositoryEntry {
  name: string;
  team?: string;
  tier?: 'tier-1' | 'tier-2' | 'tier-3';
  compliance?: string[];
  dba_contact?: string;
  infra_contact?: string;
  owner?: string;
  tags?: string[];
}

export interface RepositoryGroup {
  pattern?: string;
  repositories?: string[];
  team?: string;
  tier?: string;
}

// ============================================
// Security Policies
// ============================================

export interface SecurityPolicy {
  apiVersion: string;
  kind: 'SecurityPolicy';
  metadata: PolicyMetadata;
  spec: SecurityPolicySpec;
}

export interface SecurityPolicySpec {
  secrets?: SecretsPolicy;
  dependencies?: DependenciesPolicy;
  codeScanning?: CodeScanningPolicy;
}

export interface SecretsPolicy {
  rotationRequired: boolean;
  rotationDays?: number;
  allowedPatterns?: string[];
  forbiddenPatterns?: string[];
}

export interface DependenciesPolicy {
  autoUpdate: boolean;
  vulnerabilityThreshold: 'critical' | 'high' | 'medium' | 'low';
  allowedLicenses?: string[];
  forbiddenLicenses?: string[];
}

export interface CodeScanningPolicy {
  required: boolean;
  tools?: string[];
  failOnSeverity: 'critical' | 'high' | 'medium' | 'low';
}

// ============================================
// Cost Policies
// ============================================

export interface CostPolicy {
  apiVersion: string;
  kind: 'CostPolicy';
  metadata: PolicyMetadata;
  spec: CostPolicySpec;
}

export interface CostPolicySpec {
  budgets?: BudgetPolicy[];
  alerts?: CostAlert[];
  optimization?: OptimizationSettings;
}

export interface BudgetPolicy {
  name: string;
  scope: 'organization' | 'team' | 'repository';
  target?: string;
  monthlyLimit: number;
  currency: string;
}

export interface CostAlert {
  threshold: number; // percentage
  action: 'notify' | 'warn' | 'block';
  recipients?: string[];
}

export interface OptimizationSettings {
  autoScale: boolean;
  idleTimeout: number; // minutes
  spotInstances: boolean;
}

// ============================================
// Dashboard Configuration
// ============================================

export interface DashboardConfig {
  apiVersion: string;
  kind: 'DashboardConfig';
  metadata: PolicyMetadata;
  spec: DashboardSpec;
}

export interface DashboardSpec {
  role: 'executive' | 'devops' | 'developer' | 'dba' | 'infrastructure';
  widgets: DashboardWidget[];
  refreshInterval?: string;
}

export interface DashboardWidget {
  id: string;
  type: 'metrics' | 'chart' | 'table' | 'status';
  title: string;
  tool: string;
  params?: Record<string, any>;
  size?: 'small' | 'medium' | 'large';
}

// ============================================
// Migration Policies (imported from migrations module)
// ============================================

export interface MigrationPolicy {
  apiVersion: string;
  kind: 'MigrationPolicy';
  metadata: PolicyMetadata;
  spec: MigrationPolicySpec;
}

export interface MigrationPolicySpec {
  forbidden?: MigrationForbiddenOperations;
  restricted?: MigrationRestrictedOperations;
  requirements?: MigrationRequirements;
  environments?: Record<string, MigrationEnvironmentPolicy>;
}

export interface MigrationForbiddenOperations {
  operations: MigrationForbiddenOperation[];
}

export interface MigrationForbiddenOperation {
  pattern: string;
  severity: 'critical' | 'high' | 'medium';
  reason: string;
  exceptions?: Array<{
    context?: string;
    pattern?: string;
    environments?: string[];
  }>;
}

export interface MigrationRestrictedOperations {
  operations: MigrationRestrictedOperation[];
}

export interface MigrationRestrictedOperation {
  pattern: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  message: string;
  database?: string;
  autofix?: string;
  requires?: {
    approval?: string;
    environment?: string[];
    migrationWindow?: boolean;
    maintenanceWindow?: boolean;
    dataValidation?: boolean;
  };
}

export interface MigrationRequirements {
  transactions?: {
    enabled: boolean;
    message: string;
    exceptions?: string[];
  };
  rollback?: {
    required: boolean;
    environments: string[];
    message: string;
  };
  idempotency?: {
    required: boolean;
    patterns: string[];
    message: string;
  };
  naming?: {
    pattern: string;
    message: string;
    examples?: string[];
  };
  limits?: {
    maxStatementsPerMigration: number;
    maxAffectedTables: number;
    message: string;
  };
}

export interface MigrationEnvironmentPolicy {
  enforcement: 'strict' | 'advisory' | 'disabled';
  allowDestructive: boolean;
  requireApproval: boolean;
  requireRollback?: boolean;
  requireMaintenanceWindow?: boolean;
  approvers?: {
    teams?: string[];
    users?: string[];
  };
  migrationWindows?: Array<{
    days: string[];
    hours: string;
    timezone: string;
  }>;
}

// ============================================
// Loaded Configuration State
// ============================================

export interface LoadedConfig {
  main: DevOpsConfig;
  workflowPolicies: WorkflowPolicy[];
  securityPolicies: SecurityPolicy[];
  costPolicies: CostPolicy[];
  migrationPolicies: MigrationPolicy[];
  repositoryInventory: RepositoryInventory | null;
  dashboards: DashboardConfig[];
  loadedAt: Date;
  source: 'remote' | 'local' | 'default';
  errors: ConfigError[];
}

export interface ConfigError {
  file: string;
  message: string;
  severity: 'error' | 'warning';
}

// ============================================
// Config Loader Options
// ============================================

export interface ConfigLoaderOptions {
  /** GitHub token for API access */
  token?: string;
  
  /** Organization name */
  org?: string;
  
  /** Config repository name (default: devops-config) */
  configRepo?: string;
  
  /** Branch to read from (default: main) */
  branch?: string;
  
  /** Local path override (for development) */
  localPath?: string;
  
  /** Enable auto-reload */
  autoReload?: boolean;
  
  /** Reload interval in milliseconds */
  reloadIntervalMs?: number;
}
