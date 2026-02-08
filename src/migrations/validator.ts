/**
 * Migration Validator - Validates database migrations against policies
 * 
 * Implements the PolicyEngine interface for regex-based validation.
 * Designed to be swappable with OPA in Phase 2.
 */

import {
  MigrationPolicy,
  MigrationValidationResult,
  PolicyViolation,
  PolicyWarning,
  PolicySuggestion,
  RiskAssessment,
  RiskFactor,
  PolicyEngine,
  ValidationContext,
  MigrationTool,
  DatabaseType,
  DetectedOperation,
} from './types.js';
import { migrationDetector } from './detector.js';

// ============================================
// Default Policy (when no policies are loaded)
// ============================================

const DEFAULT_FORBIDDEN_PATTERNS: Array<{
  pattern: RegExp;
  severity: 'critical' | 'high' | 'medium';
  reason: string;
}> = [
  // Data Destruction
  {
    pattern: /DROP\s+DATABASE/i,
    severity: 'critical',
    reason: 'Database drops must be performed by DBAs with explicit approval',
  },
  {
    pattern: /DROP\s+SCHEMA/i,
    severity: 'critical',
    reason: 'Schema drops require DBA intervention',
  },
  {
    pattern: /TRUNCATE\s+TABLE/i,
    severity: 'high',
    reason: 'TRUNCATE operations require explicit approval',
  },
  {
    pattern: /DELETE\s+FROM\s+\w+\s*(;|$|WHERE\s+1\s*=\s*1)/i,
    severity: 'critical',
    reason: 'Unrestricted DELETE operations are forbidden',
  },
  
  // Privilege Escalation
  {
    pattern: /GRANT\s+.*\s+TO/i,
    severity: 'critical',
    reason: 'Permission grants must be managed by DBAs',
  },
  {
    pattern: /REVOKE\s+.*\s+FROM/i,
    severity: 'critical',
    reason: 'Permission revokes must be managed by DBAs',
  },
  {
    pattern: /CREATE\s+(USER|ROLE|LOGIN)/i,
    severity: 'critical',
    reason: 'User/role creation must be managed by DBAs',
  },
  {
    pattern: /ALTER\s+(USER|ROLE|LOGIN)/i,
    severity: 'critical',
    reason: 'User/role modifications must be managed by DBAs',
  },
  {
    pattern: /DROP\s+(USER|ROLE|LOGIN)/i,
    severity: 'critical',
    reason: 'User/role deletion must be managed by DBAs',
  },
  
  // Dangerous Operations
  {
    pattern: /ALTER\s+SYSTEM/i,
    severity: 'critical',
    reason: 'System-level changes are forbidden in migrations',
  },
  {
    pattern: /xp_cmdshell/i,
    severity: 'critical',
    reason: 'OS command execution is forbidden',
  },
  {
    pattern: /BACKUP\s+DATABASE/i,
    severity: 'high',
    reason: 'Backups should be handled by infrastructure, not migrations',
  },
  {
    pattern: /RESTORE\s+DATABASE/i,
    severity: 'critical',
    reason: 'Restores must be performed by DBAs',
  },
];

const DEFAULT_RESTRICTED_PATTERNS: Array<{
  pattern: RegExp;
  severity: 'critical' | 'high' | 'medium' | 'low';
  message: string;
  database?: DatabaseType;
  suggestion?: string;
}> = [
  {
    pattern: /DROP\s+TABLE/i,
    severity: 'high',
    message: 'Table drops require DBA approval for production',
  },
  {
    pattern: /DROP\s+COLUMN|ALTER\s+TABLE\s+\w+\s+DROP\s+COLUMN/i,
    severity: 'high',
    message: 'Column drops are backwards-incompatible',
  },
  {
    pattern: /ALTER\s+TABLE.*ALTER\s+COLUMN.*TYPE|ALTER\s+TABLE.*MODIFY/i,
    severity: 'medium',
    message: 'Type changes may cause data loss',
  },
  {
    pattern: /CREATE\s+INDEX(?!\s+CONCURRENTLY)/i,
    severity: 'medium',
    message: 'Use CREATE INDEX CONCURRENTLY to avoid table locks',
    database: 'postgresql',
    suggestion: 'CREATE INDEX CONCURRENTLY',
  },
  {
    pattern: /DROP\s+INDEX(?!\s+CONCURRENTLY)/i,
    severity: 'medium',
    message: 'Use DROP INDEX CONCURRENTLY to avoid table locks',
    database: 'postgresql',
    suggestion: 'DROP INDEX CONCURRENTLY',
  },
  {
    pattern: /REINDEX/i,
    severity: 'medium',
    message: 'REINDEX can cause extended locks, schedule during maintenance window',
  },
  {
    pattern: /ADD\s+CONSTRAINT.*FOREIGN\s+KEY/i,
    severity: 'medium',
    message: 'Foreign keys can cause migration failures on invalid data',
  },
  {
    pattern: /ALTER\s+TABLE.*ADD.*NOT\s+NULL(?!\s+DEFAULT)/i,
    severity: 'medium',
    message: 'Adding NOT NULL to existing column requires default value',
  },
];

// ============================================
// Migration Validator Class
// ============================================

export class MigrationValidator implements PolicyEngine {
  private policies: MigrationPolicy[] = [];
  private forbiddenPatterns: typeof DEFAULT_FORBIDDEN_PATTERNS = [];
  private restrictedPatterns: typeof DEFAULT_RESTRICTED_PATTERNS = [];

  constructor() {
    // Initialize with default patterns
    this.forbiddenPatterns = [...DEFAULT_FORBIDDEN_PATTERNS];
    this.restrictedPatterns = [...DEFAULT_RESTRICTED_PATTERNS];
  }

  /**
   * Load policies from configuration
   */
  async loadPolicies(policies: MigrationPolicy[]): Promise<void> {
    this.policies = policies;
    
    // Compile patterns from loaded policies
    if (policies.length > 0) {
      this.forbiddenPatterns = [];
      this.restrictedPatterns = [];
      
      for (const policy of policies) {
        // Load forbidden operations
        if (policy.spec.forbidden?.operations) {
          for (const op of policy.spec.forbidden.operations) {
            this.forbiddenPatterns.push({
              pattern: new RegExp(op.pattern, 'gi'),
              severity: op.severity,
              reason: op.reason,
            });
          }
        }
        
        // Load restricted operations
        if (policy.spec.restricted?.operations) {
          for (const op of policy.spec.restricted.operations) {
            this.restrictedPatterns.push({
              pattern: new RegExp(op.pattern, 'gi'),
              severity: op.severity,
              message: op.message,
              database: op.database,
              suggestion: op.autofix,
            });
          }
        }
      }
    }
    
    // Fall back to defaults if no patterns loaded
    if (this.forbiddenPatterns.length === 0) {
      this.forbiddenPatterns = [...DEFAULT_FORBIDDEN_PATTERNS];
    }
    if (this.restrictedPatterns.length === 0) {
      this.restrictedPatterns = [...DEFAULT_RESTRICTED_PATTERNS];
    }
  }

  /**
   * Validate SQL content against loaded policies
   */
  async validateSQL(
    sql: string,
    environment: string,
    context: ValidationContext
  ): Promise<MigrationValidationResult> {
    const violations: PolicyViolation[] = [];
    const warnings: PolicyWarning[] = [];
    const suggestions: PolicySuggestion[] = [];
    
    // Get environment policy
    const envPolicy = this.getEnvironmentPolicy(environment);
    
    // Check forbidden operations
    violations.push(...this.checkForbiddenOperations(sql, environment, envPolicy));
    
    // Check restricted operations
    const restrictedResults = this.checkRestrictedOperations(sql, environment, context.database, envPolicy);
    violations.push(...restrictedResults.violations);
    warnings.push(...restrictedResults.warnings);
    
    // Check requirements (transactions, rollback, naming, etc.)
    const requirementResults = this.checkRequirements(sql, context, envPolicy);
    violations.push(...requirementResults.violations);
    warnings.push(...requirementResults.warnings);
    suggestions.push(...requirementResults.suggestions);
    
    // Generate suggestions based on detected operations
    suggestions.push(...this.generateSuggestions(sql, context));
    
    // Calculate risk assessment
    const operations = migrationDetector.detectSQLOperations(sql);
    const riskAssessment = this.assessRisk(operations, violations, warnings);
    
    return {
      repository: context.repository,
      migrationFile: context.migrationFile,
      isValid: violations.filter(v => v.severity === 'critical').length === 0 && 
               (envPolicy.enforcement !== 'strict' || violations.length === 0),
      environment,
      violations,
      warnings,
      suggestions,
      riskAssessment,
    };
  }

  /**
   * Check if a specific operation is allowed
   */
  async isOperationAllowed(
    operation: string,
    environment: string
  ): Promise<{ allowed: boolean; reason?: string }> {
    const envPolicy = this.getEnvironmentPolicy(environment);
    
    // Check against forbidden patterns
    for (const forbidden of this.forbiddenPatterns) {
      if (forbidden.pattern.test(operation)) {
        return {
          allowed: false,
          reason: forbidden.reason,
        };
      }
    }
    
    // Check restricted patterns in strict environments
    if (envPolicy.enforcement === 'strict') {
      for (const restricted of this.restrictedPatterns) {
        if (restricted.pattern.test(operation)) {
          return {
            allowed: false,
            reason: restricted.message,
          };
        }
      }
    }
    
    return { allowed: true };
  }

  /**
   * Get loaded policies summary
   */
  getPoliciesSummary(): {
    policyCount: number;
    forbiddenCount: number;
    restrictedCount: number;
    policies: Array<{ name: string; version: string; description?: string }>;
  } {
    return {
      policyCount: this.policies.length,
      forbiddenCount: this.forbiddenPatterns.length,
      restrictedCount: this.restrictedPatterns.length,
      policies: this.policies.map(p => ({
        name: p.metadata.name,
        version: p.metadata.version,
        description: p.metadata.description,
      })),
    };
  }

  // ============================================
  // Private Methods
  // ============================================

  private getEnvironmentPolicy(environment: string): {
    enforcement: 'strict' | 'advisory' | 'disabled';
    allowDestructive: boolean;
    requireApproval: boolean;
    requireRollback: boolean;
  } {
    // Check if any policy has environment-specific rules
    for (const policy of this.policies) {
      if (policy.spec.environments?.[environment]) {
        const envPolicy = policy.spec.environments[environment];
        return {
          enforcement: envPolicy.enforcement || 'advisory',
          allowDestructive: envPolicy.allowDestructive ?? true,
          requireApproval: envPolicy.requireApproval ?? false,
          requireRollback: envPolicy.requireRollback ?? false,
        };
      }
    }
    
    // Default environment policies
    const defaults: Record<string, ReturnType<typeof this.getEnvironmentPolicy>> = {
      production: {
        enforcement: 'strict',
        allowDestructive: false,
        requireApproval: true,
        requireRollback: true,
      },
      staging: {
        enforcement: 'advisory',
        allowDestructive: true,
        requireApproval: false,
        requireRollback: true,
      },
      development: {
        enforcement: 'advisory',
        allowDestructive: true,
        requireApproval: false,
        requireRollback: false,
      },
    };
    
    return defaults[environment] || defaults.development;
  }

  private checkForbiddenOperations(
    sql: string,
    environment: string,
    envPolicy: ReturnType<typeof this.getEnvironmentPolicy>
  ): PolicyViolation[] {
    const violations: PolicyViolation[] = [];
    
    for (const forbidden of this.forbiddenPatterns) {
      const regex = new RegExp(forbidden.pattern.source, 'gi');
      let match;
      
      while ((match = regex.exec(sql)) !== null) {
        const lineNumber = sql.slice(0, match.index).split('\n').length;
        
        violations.push({
          rule: 'forbidden-operation',
          severity: forbidden.severity,
          message: forbidden.reason,
          line: lineNumber,
          statement: match[0],
        });
      }
    }
    
    return violations;
  }

  private checkRestrictedOperations(
    sql: string,
    environment: string,
    database: DatabaseType,
    envPolicy: ReturnType<typeof this.getEnvironmentPolicy>
  ): { violations: PolicyViolation[]; warnings: PolicyWarning[] } {
    const violations: PolicyViolation[] = [];
    const warnings: PolicyWarning[] = [];
    
    for (const restricted of this.restrictedPatterns) {
      // Skip if pattern is database-specific and doesn't match
      if (restricted.database && restricted.database !== database) {
        continue;
      }
      
      const regex = new RegExp(restricted.pattern.source, 'gi');
      let match;
      
      while ((match = regex.exec(sql)) !== null) {
        const lineNumber = sql.slice(0, match.index).split('\n').length;
        
        // In strict mode, restricted operations become violations
        if (envPolicy.enforcement === 'strict') {
          violations.push({
            rule: 'restricted-operation',
            severity: restricted.severity,
            message: restricted.message,
            line: lineNumber,
            statement: match[0],
            fix: restricted.suggestion,
          });
        } else {
          warnings.push({
            rule: 'restricted-operation',
            message: restricted.message,
            line: lineNumber,
            suggestion: restricted.suggestion,
          });
        }
      }
    }
    
    return { violations, warnings };
  }

  private checkRequirements(
    sql: string,
    context: ValidationContext,
    envPolicy: ReturnType<typeof this.getEnvironmentPolicy>
  ): { violations: PolicyViolation[]; warnings: PolicyWarning[]; suggestions: PolicySuggestion[] } {
    const violations: PolicyViolation[] = [];
    const warnings: PolicyWarning[] = [];
    const suggestions: PolicySuggestion[] = [];
    
    // Check rollback requirement
    if (envPolicy.requireRollback && !context.hasRollback) {
      if (envPolicy.enforcement === 'strict') {
        violations.push({
          rule: 'require-rollback',
          severity: 'high',
          message: `${context.migrationFile} requires a rollback script for ${context.repository} (environment: production/staging)`,
        });
      } else {
        warnings.push({
          rule: 'require-rollback',
          message: 'Consider adding a rollback script for production deployments',
        });
      }
    }
    
    // Check transaction usage
    const hasTransaction = /BEGIN|START\s+TRANSACTION/i.test(sql) || context.inTransaction;
    if (!hasTransaction) {
      // Some operations cannot be in transactions
      const cannotBeTransactional = /CREATE\s+INDEX\s+CONCURRENTLY|ALTER\s+TYPE/i.test(sql);
      
      if (!cannotBeTransactional) {
        warnings.push({
          rule: 'require-transaction',
          message: 'Migration should be wrapped in a transaction for safety',
          suggestion: 'Add BEGIN/COMMIT around migration statements',
        });
      }
    }
    
    // Check idempotency
    const hasIdempotency = /IF\s+NOT\s+EXISTS|IF\s+EXISTS|CREATE\s+OR\s+REPLACE/i.test(sql);
    if (!hasIdempotency) {
      suggestions.push({
        type: 'best-practice',
        message: 'Consider making migration idempotent using IF EXISTS/IF NOT EXISTS',
        codeExample: 'CREATE TABLE IF NOT EXISTS ...',
      });
    }
    
    // Check for large data modifications without WHERE clause
    const unsafeUpdate = /UPDATE\s+\w+\s+SET(?!.*WHERE)/is.test(sql);
    const unsafeDelete = /DELETE\s+FROM\s+\w+(?!\s+WHERE)/is.test(sql);
    
    if (unsafeUpdate) {
      warnings.push({
        rule: 'unsafe-update',
        message: 'UPDATE without WHERE clause will affect all rows',
        suggestion: 'Add a WHERE clause to limit affected rows',
      });
    }
    
    if (unsafeDelete) {
      warnings.push({
        rule: 'unsafe-delete',
        message: 'DELETE without WHERE clause will remove all rows',
        suggestion: 'Add a WHERE clause or use TRUNCATE if intentional',
      });
    }
    
    return { violations, warnings, suggestions };
  }

  private generateSuggestions(sql: string, context: ValidationContext): PolicySuggestion[] {
    const suggestions: PolicySuggestion[] = [];
    
    // PostgreSQL-specific suggestions
    if (context.database === 'postgresql') {
      // Non-concurrent index creation
      if (/CREATE\s+INDEX(?!\s+CONCURRENTLY)/i.test(sql)) {
        suggestions.push({
          type: 'performance',
          message: 'Use CONCURRENTLY for index creation to avoid locking the table',
          codeExample: 'CREATE INDEX CONCURRENTLY idx_name ON table_name (column);',
        });
      }
      
      // VACUUM suggestion after bulk operations
      if (/DELETE\s+FROM|UPDATE.*SET/i.test(sql)) {
        suggestions.push({
          type: 'performance',
          message: 'Consider running VACUUM ANALYZE after bulk data modifications',
          codeExample: 'VACUUM ANALYZE table_name;',
        });
      }
    }
    
    // MySQL-specific suggestions
    if (context.database === 'mysql' || context.database === 'mariadb') {
      // Online DDL hints
      if (/ALTER\s+TABLE/i.test(sql)) {
        suggestions.push({
          type: 'performance',
          message: 'Use ALGORITHM=INPLACE and LOCK=NONE for online schema changes when possible',
          codeExample: 'ALTER TABLE t ADD COLUMN c INT, ALGORITHM=INPLACE, LOCK=NONE;',
        });
      }
    }
    
    // General suggestions
    // Add comment suggestion for complex migrations
    const statementCount = (sql.match(/;/g) || []).length;
    if (statementCount > 5 && !/--.*migration|\/\*.*\*\//i.test(sql)) {
      suggestions.push({
        type: 'best-practice',
        message: 'Add comments to document the purpose of this migration',
        codeExample: '-- Migration: Add user preferences table\n-- Author: team@example.com\n-- Date: 2024-01-15',
      });
    }
    
    return suggestions;
  }

  private assessRisk(
    operations: DetectedOperation[],
    violations: PolicyViolation[],
    warnings: PolicyWarning[]
  ): RiskAssessment {
    const factors: RiskFactor[] = [];
    let score = 0;
    
    // Count critical operations
    const criticalOps = operations.filter(o => o.riskLevel === 'critical');
    if (criticalOps.length > 0) {
      score += 40;
      factors.push({
        name: 'Critical Operations',
        impact: 'critical',
        description: `${criticalOps.length} critical operation(s): ${criticalOps.map(o => o.type).join(', ')}`,
        mitigations: ['Require DBA approval', 'Execute during maintenance window'],
      });
    }
    
    // Count high-risk operations
    const highRiskOps = operations.filter(o => o.riskLevel === 'high');
    if (highRiskOps.length > 0) {
      score += 20;
      factors.push({
        name: 'High-Risk Operations',
        impact: 'high',
        description: `${highRiskOps.length} high-risk operation(s): ${highRiskOps.map(o => o.type).join(', ')}`,
        mitigations: ['Test in staging first', 'Prepare rollback script'],
      });
    }
    
    // Policy violations
    const criticalViolations = violations.filter(v => v.severity === 'critical');
    if (criticalViolations.length > 0) {
      score += 30;
      factors.push({
        name: 'Policy Violations',
        impact: 'critical',
        description: `${criticalViolations.length} critical policy violation(s)`,
        mitigations: ['Review and fix violations before deployment'],
      });
    }
    
    // Data modification scope
    const hasUnboundedDML = operations.some(o => 
      (o.type === 'update' || o.type === 'delete') && 
      !o.statement.toLowerCase().includes('where')
    );
    if (hasUnboundedDML) {
      score += 25;
      factors.push({
        name: 'Unbounded Data Modification',
        impact: 'high',
        description: 'UPDATE or DELETE without WHERE clause',
        mitigations: ['Add WHERE clause', 'Verify intent', 'Take backup first'],
      });
    }
    
    // Schema changes count
    const schemaChanges = operations.filter(o => 
      ['create', 'alter', 'drop'].includes(o.type)
    ).length;
    if (schemaChanges > 5) {
      score += 10;
      factors.push({
        name: 'Complex Migration',
        impact: 'medium',
        description: `${schemaChanges} schema changes in single migration`,
        mitigations: ['Consider splitting into smaller migrations'],
      });
    }
    
    // Determine risk level
    let level: RiskAssessment['level'];
    if (score >= 60) level = 'critical';
    else if (score >= 40) level = 'high';
    else if (score >= 20) level = 'medium';
    else level = 'low';
    
    return {
      level,
      score: Math.min(score, 100),
      factors,
    };
  }
}

// Export singleton instance
export const migrationValidator = new MigrationValidator();
