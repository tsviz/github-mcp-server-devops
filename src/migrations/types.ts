/**
 * Database Migration Types for ActionsPulse MCP Server
 * 
 * These types define the structure for migration detection, validation,
 * and policy enforcement.
 */

// ============================================
// Migration Tool Detection
// ============================================

export type MigrationTool = 
  | 'flyway'
  | 'liquibase'
  | 'alembic'
  | 'prisma'
  | 'knex'
  | 'typeorm'
  | 'sequelize'
  | 'rails'
  | 'django'
  | 'efcore'
  | 'dbup'
  | 'goose'
  | 'unknown';

export type BuildSystem = 
  | 'maven'
  | 'gradle'
  | 'dotnet'
  | 'npm'
  | 'yarn'
  | 'pnpm'
  | 'pip'
  | 'bundler'
  | 'go'
  | 'unknown';

export type DatabaseType = 
  | 'postgresql'
  | 'mysql'
  | 'mariadb'
  | 'sqlserver'
  | 'oracle'
  | 'sqlite'
  | 'mongodb'
  | 'unknown';

// ============================================
// Migration Detection Results
// ============================================

export interface MigrationDetectionResult {
  repository: string;
  hasMigrations: boolean;
  confidence: 'high' | 'medium' | 'low';
  detectionMethods: string[];
  migrationTool: MigrationTool;
  buildSystem: BuildSystem;
  database: DatabaseType;
  migrationFiles: MigrationFile[];
  workflowIntegration: WorkflowMigrationInfo | null;
  buildConfig: BuildConfigInfo | null;
}

export interface MigrationFile {
  path: string;
  name: string;
  version: string | null;
  description: string | null;
  sha: string;
  size: number;
  detectedOperations: DetectedOperation[];
}

export interface DetectedOperation {
  type: 'create' | 'alter' | 'drop' | 'insert' | 'update' | 'delete' | 'grant' | 'other';
  target: string; // table name, index name, etc.
  line: number;
  statement: string;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
}

export interface WorkflowMigrationInfo {
  workflowPath: string;
  jobName: string;
  stepName: string | null;
  command: string;
  stage: 'pre-deploy' | 'deploy' | 'post-deploy' | 'standalone';
  hasApprovalGate: boolean;
  environment: string | null;
}

export interface BuildConfigInfo {
  file: string;
  pluginName: string;
  pluginVersion: string | null;
  migrationPath: string | null;
  configuredDatabase: string | null;
}

// ============================================
// Migration Policy Types
// ============================================

export interface MigrationPolicy {
  apiVersion: string;
  kind: 'MigrationPolicy';
  metadata: MigrationPolicyMetadata;
  spec: MigrationPolicySpec;
}

export interface MigrationPolicyMetadata {
  name: string;
  version: string;
  description?: string;
}

export interface MigrationPolicySpec {
  forbidden: ForbiddenOperations;
  restricted: RestrictedOperations;
  requirements: MigrationRequirements;
  environments: Record<string, EnvironmentPolicy>;
}

export interface ForbiddenOperations {
  operations: ForbiddenOperation[];
}

export interface ForbiddenOperation {
  pattern: string;
  severity: 'critical' | 'high' | 'medium';
  reason: string;
  exceptions?: OperationException[];
}

export interface OperationException {
  context?: string;
  pattern?: string;
  environments?: string[];
}

export interface RestrictedOperations {
  operations: RestrictedOperation[];
}

export interface RestrictedOperation {
  pattern: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  message: string;
  database?: DatabaseType;
  autofix?: string;
  requires?: OperationRequirement;
}

export interface OperationRequirement {
  approval?: string;
  environment?: string[];
  migrationWindow?: boolean;
  maintenanceWindow?: boolean;
  dataValidation?: boolean;
}

export interface MigrationRequirements {
  transactions?: TransactionRequirement;
  rollback?: RollbackRequirement;
  idempotency?: IdempotencyRequirement;
  naming?: NamingRequirement;
  limits?: LimitRequirement;
}

export interface TransactionRequirement {
  enabled: boolean;
  message: string;
  exceptions?: string[];
}

export interface RollbackRequirement {
  required: boolean;
  environments: string[];
  message: string;
}

export interface IdempotencyRequirement {
  required: boolean;
  patterns: string[];
  message: string;
}

export interface NamingRequirement {
  pattern: string;
  message: string;
  examples?: string[];
}

export interface LimitRequirement {
  maxStatementsPerMigration: number;
  maxAffectedTables: number;
  message: string;
}

export interface EnvironmentPolicy {
  enforcement: 'strict' | 'advisory' | 'disabled';
  allowDestructive: boolean;
  requireApproval: boolean;
  requireRollback?: boolean;
  requireMaintenanceWindow?: boolean;
  approvers?: ApproverConfig;
  migrationWindows?: MigrationWindow[];
}

export interface ApproverConfig {
  teams?: string[];
  users?: string[];
}

export interface MigrationWindow {
  days: string[];
  hours: string;
  timezone: string;
}

// ============================================
// Migration Validation Results
// ============================================

export interface MigrationValidationResult {
  repository: string;
  migrationFile: string;
  isValid: boolean;
  environment: string;
  violations: PolicyViolation[];
  warnings: PolicyWarning[];
  suggestions: PolicySuggestion[];
  riskAssessment: RiskAssessment;
}

export interface PolicyViolation {
  rule: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  message: string;
  line?: number;
  statement?: string;
  fix?: string;
}

export interface PolicyWarning {
  rule: string;
  message: string;
  line?: number;
  suggestion?: string;
}

export interface PolicySuggestion {
  type: 'performance' | 'safety' | 'compliance' | 'best-practice';
  message: string;
  codeExample?: string;
}

export interface RiskAssessment {
  level: 'low' | 'medium' | 'high' | 'critical';
  score: number; // 0-100
  factors: RiskFactor[];
}

export interface RiskFactor {
  name: string;
  impact: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  mitigations?: string[];
}

// ============================================
// Migration Metrics
// ============================================

export interface MigrationMetrics {
  repository: string;
  period: string;
  summary: MigrationMetricsSummary;
  byEnvironment: Record<string, EnvironmentMetrics>;
  recentMigrations: RecentMigration[];
  trends: MigrationTrends;
}

export interface MigrationMetricsSummary {
  totalMigrations: number;
  successfulMigrations: number;
  failedMigrations: number;
  rolledBack: number;
  avgDurationSeconds: number;
  p95DurationSeconds: number;
}

export interface EnvironmentMetrics {
  migrations: number;
  successRate: number;
  avgDuration: number;
  pendingApprovals: number;
}

export interface RecentMigration {
  name: string;
  version: string;
  environment: string;
  status: 'success' | 'failed' | 'pending' | 'rolled-back';
  executedAt: Date;
  duration: number;
  appliedBy: string | null;
}

export interface MigrationTrends {
  frequency: TrendData;
  successRate: TrendData;
  avgDuration: TrendData;
}

export interface TrendData {
  current: number;
  previous: number;
  changePercent: number;
  direction: 'up' | 'down' | 'stable';
}

// ============================================
// Policy Engine Interface (for OPA integration)
// ============================================

export interface PolicyEngine {
  /**
   * Validate SQL content against loaded policies
   */
  validateSQL(
    sql: string,
    environment: string,
    context: ValidationContext
  ): Promise<MigrationValidationResult>;

  /**
   * Load policies from configuration
   */
  loadPolicies(policies: MigrationPolicy[]): Promise<void>;

  /**
   * Check if a specific operation is allowed
   */
  isOperationAllowed(
    operation: string,
    environment: string
  ): Promise<{ allowed: boolean; reason?: string }>;
}

export interface ValidationContext {
  repository: string;
  migrationFile: string;
  migrationTool: MigrationTool;
  database: DatabaseType;
  hasRollback: boolean;
  inTransaction: boolean;
  approvedBy?: string[];
}

// ============================================
// Build Tool Detection Patterns
// ============================================

export interface BuildToolPattern {
  tool: MigrationTool;
  buildSystem: BuildSystem;
  configFiles: string[];
  pluginPatterns: PluginPattern[];
  commandPatterns: CommandPattern[];
  migrationPaths: string[];
}

export interface PluginPattern {
  file: string;
  pattern: RegExp;
  groupIdPattern?: string;
  artifactIdPattern?: string;
}

export interface CommandPattern {
  pattern: RegExp;
  buildContext: string[];
}

// ============================================
// AI Advisor Context
// ============================================

export interface MigrationSourceContext {
  organization: string;
  repository: string;
  migrationFile: string;
  migrationTool: MigrationTool;
  database: DatabaseType;
  content: string;
  staticAnalysis: {
    operations: DetectedOperation[];
    violations: PolicyViolation[];
    warnings: PolicyWarning[];
    riskAssessment: RiskAssessment;
  };
}

export interface MigrationInsightResult {
  success: boolean;
  insights: string;
  provider: string;
  model: string;
  cached: boolean;
  error?: string;
}
