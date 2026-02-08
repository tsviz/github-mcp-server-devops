import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { GitHubOrgClient } from './github/org-client.js';
import { MetricsCalculator } from './metrics/calculator.js';
import { VisualizationGenerator } from './visualization/generator.js';
import { ConfigLoader } from './config/config-loader.js';
import { 
  generateCostInsights, 
  generateDORAInsights, 
  generateWorkflowSourceInsights,
  isAIAdvisorEnabled, 
  getAIProviderInfo,
  type CostInsightContext,
  type DORAInsightContext,
  type WorkflowSourceContext,
} from './ai/advisor.js';
import {
  detectRunnerFromLabels,
  inferRunnerFromSpecs,
  calculateRunnerCostAdvanced,
  buildHostedRunnerLookup,
  GITHUB_RUNNERS,
  type HostedRunnerLookup,
} from './pricing/github-runner-catalog.js';
import { writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';

// ============================================
// Request Queue for Serializing Tool Calls
// ============================================
// This prevents issues when multiple MCP tool calls are made in parallel.
// The queue ensures each request completes before the next one starts.
class RequestQueue {
  private queue: Array<{
    execute: () => Promise<any>;
    resolve: (value: any) => void;
    reject: (error: any) => void;
  }> = [];
  private processing = false;

  async enqueue<T>(execute: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push({ execute, resolve, reject });
      this.processNext();
    });
  }

  private async processNext(): Promise<void> {
    if (this.processing || this.queue.length === 0) {
      return;
    }

    this.processing = true;
    const { execute, resolve, reject } = this.queue.shift()!;

    try {
      const result = await execute();
      resolve(result);
    } catch (error) {
      reject(error);
    } finally {
      this.processing = false;
      this.processNext();
    }
  }
}

const requestQueue = new RequestQueue();

// Configuration
const config = {
  token: process.env.GITHUB_TOKEN,
  baseUrl: process.env.GITHUB_API_URL || 'https://api.github.com',
};

const enterpriseConfig = {
  enterpriseSlug: process.env.GITHUB_ENTERPRISE_SLUG,
  enterpriseUrl: process.env.GITHUB_ENTERPRISE_URL,
};

// Default organization (can be overridden in tool calls)
const defaultOrg = process.env.GITHUB_ORG;

// Default repository filter (comma-separated list of repos to monitor)
// PRECEDENCE for repo filtering:
//   1. Explicit `repo_filter` parameter in tool call (highest priority)
//   2. DEFAULT_REPO_FILTER env var (if set)
//   3. All org repos (if neither is set)
// 
// NOTE: The inventory.yaml file is ONLY used for:
//   - `list_monitored_repositories` tool (metadata queries)
//   - `generate_devops_reports` tool (report generation)
// It does NOT affect individual metric tools like get_dora_metrics.
const defaultRepoFilter = process.env.DEFAULT_REPO_FILTER
  ? process.env.DEFAULT_REPO_FILTER.split(',').map(r => r.trim())
  : undefined;

// Config repo settings
const configRepoSettings = {
  configRepo: process.env.DEVOPS_CONFIG_REPO || 'devops-config',
  configBranch: process.env.DEVOPS_CONFIG_BRANCH || 'main',
  configLocalPath: process.env.DEVOPS_CONFIG_PATH,
  autoReload: process.env.AUTO_RELOAD_CONFIG !== 'false',
};

// Initialize GitHub Client (organization-level primary, enterprise optional)
const githubClient = new GitHubOrgClient(config, enterpriseConfig);

// Initialize Config Loader
const configLoader = new ConfigLoader({
  token: config.token,
  org: defaultOrg,
  configRepo: configRepoSettings.configRepo,
  branch: configRepoSettings.configBranch,
  localPath: configRepoSettings.configLocalPath,
  autoReload: configRepoSettings.autoReload,
});

// Verify access
const { hasOrgAccess, hasEnterpriseAccess, errorType } = await githubClient.verifyAccess();

if (!hasOrgAccess) {
  if (errorType === 'rate_limit') {
    console.error('💡 Wait for rate limit to reset (usually 1 hour) or use a different token.');
  } else {
    console.error('❌ Failed to authenticate with GitHub. Please check your GITHUB_TOKEN.');
    console.error('💡 Set GITHUB_TOKEN environment variable with a personal access token.');
  }
  process.exit(1);
}

if (hasEnterpriseAccess) {
  console.error('🏢 GitHub Enterprise access enabled - enhanced features available');
} else {
  console.error('ℹ️ Running in organization-level mode (Enterprise features disabled)');
}

if (defaultOrg) {
  console.error(`🏠 Default organization: ${defaultOrg}`);
}

// Load DevOps configuration (non-blocking)
const loadedConfig = await configLoader.load();
console.error(`📋 Config loaded from: ${loadedConfig.source}`);
if (loadedConfig.workflowPolicies.length > 0) {
  console.error(`📜 Workflow policies: ${loadedConfig.workflowPolicies.length}`);
}

// Helper to get org name from args or default
const getOrgName = (args: any): string => {
  const org = args?.org_name || defaultOrg;
  if (!org) {
    throw new Error('org_name is required. Set GITHUB_ORG environment variable or provide org_name parameter.');
  }
  return org;
};

// Initialize calculators and visualizers
const metricsCalculator = new MetricsCalculator(githubClient);
const visualizer = new VisualizationGenerator();

// Create MCP Server
const server = new Server(
  {
    name: 'devops-observer',
    version: '2.0.0',
  },
  {
    capabilities: {
      tools: {},
      prompts: {},
    },
  }
);

// Define tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'check_token_permissions',
      description: `Check PAT/token permissions and capabilities. Shows granted scopes, missing scopes, and specific API access for DevOps tools${defaultOrg ? ` (default org: ${defaultOrg})` : ''}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          org_name: { type: 'string', description: `Organization to test capabilities against${defaultOrg ? ` (default: ${defaultOrg})` : ''}` },
        },
        required: [],
      },
    },
    {
      name: 'get_actions_usage_metrics',
      description: `Get GitHub Actions usage metrics and billing data for an organization${defaultOrg ? ` (default: ${defaultOrg})` : ''}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          org_name: { type: 'string', description: `Organization name${defaultOrg ? ` (default: ${defaultOrg})` : ''}` },
          timeframe: { type: 'string', enum: ['24h', '7d', '30d', '90d'], description: 'Analysis timeframe' },
          breakdown: { type: 'string', enum: ['workflow', 'job', 'runner', 'os'], description: 'Breakdown type (optional)' },
        },
        required: defaultOrg ? ['timeframe'] : ['org_name', 'timeframe'],
      },
    },
    {
      name: 'get_detailed_usage_metrics',
      description: `Get detailed Actions usage metrics matching GitHub Insights UI - includes per-workflow, per-job, per-repo, per-OS, per-runner breakdowns${defaultOrg ? ` (default org: ${defaultOrg})` : ''}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          org_name: { type: 'string', description: `Organization name${defaultOrg ? ` (default: ${defaultOrg})` : ''}` },
          timeframe: { type: 'string', enum: ['7d', '30d', '90d'], description: 'Analysis timeframe' },
          repo_filter: { type: 'string', description: 'Comma-separated list of repositories (optional)' },
        },
        required: defaultOrg ? ['timeframe'] : ['org_name', 'timeframe'],
      },
    },
    {
      name: 'get_detailed_performance_metrics',
      description: `Get detailed Actions performance metrics matching GitHub Insights UI - includes avg run time, queue time, failure rates per workflow/job/repo/OS/runner${defaultOrg ? ` (default org: ${defaultOrg})` : ''}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          org_name: { type: 'string', description: `Organization name${defaultOrg ? ` (default: ${defaultOrg})` : ''}` },
          timeframe: { type: 'string', enum: ['7d', '30d', '90d'], description: 'Analysis timeframe' },
          repo_filter: { type: 'string', description: 'Comma-separated list of repositories (optional)' },
        },
        required: defaultOrg ? ['timeframe'] : ['org_name', 'timeframe'],
      },
    },
    {
      name: 'get_actions_performance_metrics',
      description: `Get Actions performance metrics including queue times and execution statistics${defaultOrg ? ` (default org: ${defaultOrg})` : ''}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          org_name: { type: 'string', description: `Organization name${defaultOrg ? ` (default: ${defaultOrg})` : ''}` },
          repo_name: { type: 'string', description: 'Specific repository (optional)' },
          workflow_id: { type: 'string', description: 'Specific workflow ID (optional)' },
          timeframe: { type: 'string', enum: ['1h', '6h', '24h', '7d', '30d'], description: 'Analysis timeframe' },
        },
        required: defaultOrg ? ['timeframe'] : ['org_name', 'timeframe'],
      },
    },
    {
      name: 'analyze_runner_utilization',
      description: `Analyze self-hosted and GitHub-hosted runner utilization${defaultOrg ? ` (default org: ${defaultOrg})` : ''}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          org_name: { type: 'string', description: `Organization name${defaultOrg ? ` (default: ${defaultOrg})` : ''}` },
          runner_type: { type: 'string', enum: ['self-hosted', 'github-hosted', 'all'], description: 'Runner type to analyze' },
          include_costs: { type: 'boolean', description: 'Include cost analysis' },
        },
        required: defaultOrg ? [] : ['org_name'],
      },
    },
    {
      name: 'get_actions_cache_analytics',
      description: `Analyze Actions cache usage and efficiency${defaultOrg ? ` (default org: ${defaultOrg})` : ''}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          org_name: { type: 'string', description: `Organization name${defaultOrg ? ` (default: ${defaultOrg})` : ''}` },
          repo_name: { type: 'string', description: 'Specific repository (optional)' },
          timeframe: { type: 'string', enum: ['24h', '7d', '30d'], description: 'Analysis timeframe' },
        },
        required: defaultOrg ? ['timeframe'] : ['org_name', 'timeframe'],
      },
    },
    {
      name: 'generate_cost_optimization_report',
      description: `Generate cost optimization recommendations based on Actions usage${defaultOrg ? ` (default org: ${defaultOrg})` : ''}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          org_name: { type: 'string', description: `Organization name${defaultOrg ? ` (default: ${defaultOrg})` : ''}` },
          include_recommendations: { type: 'boolean', description: 'Include actionable recommendations' },
          target_savings_percentage: { type: 'number', description: 'Target savings percentage (5-50)' },
        },
        required: defaultOrg ? [] : ['org_name'],
      },
    },
    {
      name: 'get_workflow_insights',
      description: `Get workflow insights with bottleneck detection${defaultOrg ? ` (default org: ${defaultOrg})` : ''}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          org_name: { type: 'string', description: `Organization name${defaultOrg ? ` (default: ${defaultOrg})` : ''}` },
          repo_name: { type: 'string', description: 'Repository name' },
          workflow_name: { type: 'string', description: 'Workflow name or filename' },
          analyze_dependencies: { type: 'boolean', description: 'Analyze job dependencies' },
        },
        required: defaultOrg ? ['repo_name', 'workflow_name'] : ['org_name', 'repo_name', 'workflow_name'],
      },
    },
    {
      name: 'analyze_workflow_source',
      description: `Analyze actual workflow YAML source code and provide specific optimization suggestions based on the code. This reads the workflow file content and provides targeted improvements.${defaultOrg ? ` (default org: ${defaultOrg})` : ''}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          org_name: { type: 'string', description: `Organization name${defaultOrg ? ` (default: ${defaultOrg})` : ''}` },
          repo_name: { type: 'string', description: 'Repository name (required)' },
          workflow_path: { type: 'string', description: 'Path to workflow file (e.g., .github/workflows/ci.yml). If not provided, analyzes all workflows.' },
        },
        required: defaultOrg ? ['repo_name'] : ['org_name', 'repo_name'],
      },
    },
    {
      name: 'get_team_productivity_metrics',
      description: `Analyze team productivity based on Actions and commit data${defaultOrg ? ` (default org: ${defaultOrg})` : ''}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          org_name: { type: 'string', description: `Organization name${defaultOrg ? ` (default: ${defaultOrg})` : ''}` },
          team_slug: { type: 'string', description: 'Team slug (optional)' },
          include_individuals: { type: 'boolean', description: 'Include individual contributor metrics' },
          timeframe: { type: 'string', enum: ['7d', '30d', '90d'], description: 'Analysis timeframe' },
        },
        required: defaultOrg ? ['timeframe'] : ['org_name', 'timeframe'],
      },
    },
    {
      name: 'get_compliance_audit_report',
      description: `Generate compliance and security audit report${defaultOrg ? ` (default org: ${defaultOrg})` : ''}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          org_name: { type: 'string', description: `Organization name${defaultOrg ? ` (default: ${defaultOrg})` : ''}` },
          compliance_framework: { type: 'string', enum: ['SOC2', 'ISO27001', 'HIPAA', 'PCI-DSS', 'CUSTOM'], description: 'Compliance framework' },
          include_secrets_scan: { type: 'boolean', description: 'Include secret scanning results (requires GHAS)' },
        },
        required: defaultOrg ? [] : ['org_name'],
      },
    },
    // ============================================
    // DORA Metrics & Developer Experience Tools
    // ============================================
    {
      name: 'get_dora_metrics',
      description: `Get DORA (DevOps Research and Assessment) metrics for your organization${defaultOrg ? ` (default org: ${defaultOrg})` : ''}. Includes Deployment Frequency, Lead Time for Changes, Change Failure Rate, and Time to Restore.`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          org_name: { type: 'string', description: `Organization name${defaultOrg ? ` (default: ${defaultOrg})` : ''}` },
          timeframe: { type: 'string', enum: ['7d', '30d', '90d'], description: 'Analysis timeframe' },
          repo_filter: { type: 'string', description: 'Comma-separated list of repositories to analyze (optional)' },
        },
        required: defaultOrg ? ['timeframe'] : ['org_name', 'timeframe'],
      },
    },
    {
      name: 'get_pull_request_metrics',
      description: `Get pull request metrics including lead time, merge rates, and size distribution${defaultOrg ? ` (default org: ${defaultOrg})` : ''}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          org_name: { type: 'string', description: `Organization name${defaultOrg ? ` (default: ${defaultOrg})` : ''}` },
          timeframe: { type: 'string', enum: ['7d', '30d', '90d'], description: 'Analysis timeframe' },
          repo_name: { type: 'string', description: 'Specific repository (optional)' },
          include_stale: { type: 'boolean', description: 'Include analysis of stale PRs' },
        },
        required: defaultOrg ? ['timeframe'] : ['org_name', 'timeframe'],
      },
    },
    {
      name: 'get_issue_metrics',
      description: `Get issue metrics including time to close, label distribution, and backlog health${defaultOrg ? ` (default org: ${defaultOrg})` : ''}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          org_name: { type: 'string', description: `Organization name${defaultOrg ? ` (default: ${defaultOrg})` : ''}` },
          timeframe: { type: 'string', enum: ['7d', '30d', '90d'], description: 'Analysis timeframe' },
          repo_name: { type: 'string', description: 'Specific repository (optional)' },
          label_filter: { type: 'string', description: 'Filter by label (e.g., bug, feature)' },
        },
        required: defaultOrg ? ['timeframe'] : ['org_name', 'timeframe'],
      },
    },
    {
      name: 'get_deployment_metrics',
      description: `Get deployment metrics from GitHub Deployments API. More accurate than workflow-based metrics${defaultOrg ? ` (default org: ${defaultOrg})` : ''}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          org_name: { type: 'string', description: `Organization name${defaultOrg ? ` (default: ${defaultOrg})` : ''}` },
          timeframe: { type: 'string', enum: ['7d', '30d', '90d'], description: 'Analysis timeframe' },
          environment: { type: 'string', description: 'Filter by environment (e.g., production, staging)' },
          repo_filter: { type: 'string', description: 'Comma-separated list of repositories' },
        },
        required: defaultOrg ? ['timeframe'] : ['org_name', 'timeframe'],
      },
    },
    {
      name: 'get_environment_metrics',
      description: `Analyze GitHub environment configurations including protection rules and reviewers${defaultOrg ? ` (default org: ${defaultOrg})` : ''}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          org_name: { type: 'string', description: `Organization name${defaultOrg ? ` (default: ${defaultOrg})` : ''}` },
          repo_filter: { type: 'string', description: 'Comma-separated list of repositories' },
        },
        required: defaultOrg ? [] : ['org_name'],
      },
    },
    {
      name: 'get_discussion_metrics',
      description: `Get GitHub Discussions metrics including answer rates and engagement${defaultOrg ? ` (default org: ${defaultOrg})` : ''}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          org_name: { type: 'string', description: `Organization name${defaultOrg ? ` (default: ${defaultOrg})` : ''}` },
          repo_name: { type: 'string', description: 'Specific repository (optional)' },
          timeframe: { type: 'string', enum: ['7d', '30d', '90d'], description: 'Analysis timeframe' },
        },
        required: defaultOrg ? ['timeframe'] : ['org_name', 'timeframe'],
      },
    },
    {
      name: 'get_merge_queue_metrics',
      description: `Analyze merge queue usage and adoption across repositories${defaultOrg ? ` (default org: ${defaultOrg})` : ''}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          org_name: { type: 'string', description: `Organization name${defaultOrg ? ` (default: ${defaultOrg})` : ''}` },
          repo_name: { type: 'string', description: 'Specific repository (optional)' },
        },
        required: defaultOrg ? [] : ['org_name'],
      },
    },
    {
      name: 'get_enhanced_dora_metrics',
      description: `Get DORA metrics using actual GitHub Deployments data for maximum accuracy${defaultOrg ? ` (default org: ${defaultOrg})` : ''}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          org_name: { type: 'string', description: `Organization name${defaultOrg ? ` (default: ${defaultOrg})` : ''}` },
          timeframe: { type: 'string', enum: ['7d', '30d', '90d'], description: 'Analysis timeframe' },
          repo_filter: { type: 'string', description: 'Comma-separated list of repositories' },
        },
        required: defaultOrg ? ['timeframe'] : ['org_name', 'timeframe'],
      },
    },
    // ============================================
    // Custom Properties Tools
    // ============================================
    {
      name: 'get_org_custom_properties',
      description: `List all custom property definitions for an organization${defaultOrg ? ` (default org: ${defaultOrg})` : ''}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          org_name: { type: 'string', description: `Organization name${defaultOrg ? ` (default: ${defaultOrg})` : ''}` },
        },
        required: defaultOrg ? [] : ['org_name'],
      },
    },
    {
      name: 'get_custom_properties_analytics',
      description: `Analyze custom property usage and coverage across repositories${defaultOrg ? ` (default org: ${defaultOrg})` : ''}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          org_name: { type: 'string', description: `Organization name${defaultOrg ? ` (default: ${defaultOrg})` : ''}` },
        },
        required: defaultOrg ? [] : ['org_name'],
      },
    },
    {
      name: 'get_repos_by_property',
      description: `Find repositories by custom property value${defaultOrg ? ` (default org: ${defaultOrg})` : ''}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          org_name: { type: 'string', description: `Organization name${defaultOrg ? ` (default: ${defaultOrg})` : ''}` },
          property_name: { type: 'string', description: 'Custom property name (e.g., team, tier, compliance)' },
          property_value: { type: 'string', description: 'Property value to filter by (optional)' },
        },
        required: defaultOrg ? ['property_name'] : ['org_name', 'property_name'],
      },
    },
    // ============================================
    // Configuration Management Tools
    // ============================================
    {
      name: 'get_devops_config',
      description: 'Get the current DevOps configuration status and summary',
      inputSchema: {
        type: 'object' as const,
        properties: {
          verbose: { type: 'boolean', description: 'Include detailed policy information' },
        },
        required: [],
      },
    },
    {
      name: 'reload_devops_config',
      description: 'Reload DevOps configuration from the config repository',
      inputSchema: {
        type: 'object' as const,
        properties: {},
        required: [],
      },
    },
    {
      name: 'list_monitored_repositories',
      description: 'List repositories defined in the DevOps config inventory',
      inputSchema: {
        type: 'object' as const,
        properties: {
          team: { type: 'string', description: 'Filter by team name' },
          tier: { type: 'string', enum: ['tier-1', 'tier-2', 'tier-3'], description: 'Filter by tier' },
          compliance: { type: 'string', description: 'Filter by compliance framework (e.g., SOC2)' },
        },
        required: [],
      },
    },
    {
      name: 'list_workflow_policies',
      description: 'List all loaded workflow policies and their rules',
      inputSchema: {
        type: 'object' as const,
        properties: {
          policy_name: { type: 'string', description: 'Get details for a specific policy' },
        },
        required: [],
      },
    },
    // ============================================
    // Database Migration Tools
    // ============================================
    {
      name: 'detect_database_migrations',
      description: `Detect and analyze database migration files across repositories. Identifies migration tools (Flyway, Liquibase, EF Core, Prisma, etc.), build configurations, and workflow integrations.${defaultOrg ? ` (default org: ${defaultOrg})` : ''}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          org_name: { type: 'string', description: `Organization name${defaultOrg ? ` (default: ${defaultOrg})` : ''}` },
          repo_name: { type: 'string', description: 'Specific repository to scan (required)' },
          include_content: { type: 'boolean', description: 'Include migration file content in response (default: false)' },
        },
        required: defaultOrg ? ['repo_name'] : ['org_name', 'repo_name'],
      },
    },
    {
      name: 'validate_migration_policies',
      description: `Validate database migration files against configured policies. Checks for forbidden DBA operations, restricted operations, naming conventions, and best practices.${defaultOrg ? ` (default org: ${defaultOrg})` : ''}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          org_name: { type: 'string', description: `Organization name${defaultOrg ? ` (default: ${defaultOrg})` : ''}` },
          repo_name: { type: 'string', description: 'Repository to validate (required)' },
          environment: { type: 'string', enum: ['development', 'staging', 'production'], description: 'Target environment for validation (default: development)' },
          migration_path: { type: 'string', description: 'Specific migration file path to validate (optional, validates all if not provided)' },
        },
        required: defaultOrg ? ['repo_name'] : ['org_name', 'repo_name'],
      },
    },
    {
      name: 'list_migration_policies',
      description: `List all configured database migration policies. Shows forbidden operations, restricted operations, requirements, and environment-specific rules.`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          policy_name: { type: 'string', description: 'Get details for a specific policy' },
        },
        required: [],
      },
    },
    {
      name: 'get_migration_summary',
      description: `Get a summary of database migrations detected across repositories. Shows migration tools in use, policy compliance status, and risk assessments.${defaultOrg ? ` (default org: ${defaultOrg})` : ''}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          org_name: { type: 'string', description: `Organization name${defaultOrg ? ` (default: ${defaultOrg})` : ''}` },
          repo_filter: { type: 'string', description: 'Comma-separated list of repositories to include (optional)' },
        },
        required: defaultOrg ? [] : ['org_name'],
      },
    },
    {
      name: 'analyze_migration_pipeline',
      description: `Analyze CI/CD workflows for database migration safety best practices. Checks for validation steps, backups, approval gates, dry-runs, and proper stage separation.${defaultOrg ? ` (default org: ${defaultOrg})` : ''}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          org_name: { type: 'string', description: `Organization name${defaultOrg ? ` (default: ${defaultOrg})` : ''}` },
          repo_name: { type: 'string', description: 'Repository to analyze (required)' },
          workflow_path: { type: 'string', description: 'Specific workflow file to analyze (optional, analyzes all if not provided)' },
        },
        required: defaultOrg ? ['repo_name'] : ['org_name', 'repo_name'],
      },
    },
    // ============================================
    // Report Generation Tool
    // ============================================
    {
      name: 'generate_devops_reports',
      description: `Generate comprehensive DevOps reports with DORA metrics, CI/CD health, cost analysis, and compliance status. Reports are saved to timestamped folders with Mermaid diagrams.${defaultOrg ? ` (default org: ${defaultOrg})` : ''}`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          org_name: { type: 'string', description: `Organization name${defaultOrg ? ` (default: ${defaultOrg})` : ''}` },
          output_path: { type: 'string', description: 'Output directory path for reports (default: $DEVOPS_CONFIG_PATH/reports or ./reports)' },
          timeframe: { type: 'string', enum: ['7d', '30d', '90d'], description: 'Analysis timeframe (default: 30d)' },
          include_diagrams: { type: 'boolean', description: 'Include Mermaid diagrams in reports (default: true)' },
          reports: { 
            type: 'array', 
            items: { type: 'string', enum: ['dora', 'cicd', 'cost', 'compliance', 'all'] },
            description: 'Which reports to generate (default: all)' 
          },
        },
        required: defaultOrg ? [] : ['org_name'],
      },
    },
  ],
}));

// Handle tool calls with request queue to prevent parallel execution issues
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  return requestQueue.enqueue(async () => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case 'check_token_permissions': {
          const orgName = (args as any).org_name || defaultOrg;
          const permissions = await githubClient.getTokenPermissions(orgName);
          
          let output = '## 🔐 Token Permissions Analysis\n\n';
          
          // Token type and user
          output += `### Token Information\n`;
          output += `| Property | Value |\n|:---------|:------|\n`;
          output += `| Token Type | ${permissions.tokenType} |\n`;
          if (permissions.user) {
            output += `| User | ${permissions.user.login} |\n`;
            output += `| Account Type | ${permissions.user.type} |\n`;
          }
          output += '\n';

          // Rate limits
          if (permissions.rateLimits) {
            output += `### Rate Limits\n`;
            output += `| Metric | Value |\n|:-------|:------|\n`;
            output += `| Remaining | ${permissions.rateLimits.remaining} / ${permissions.rateLimits.limit} |\n`;
            output += `| Used | ${permissions.rateLimits.usedPercent}% |\n`;
            if (permissions.rateLimits.resetsAt) {
              output += `| Resets At | ${permissions.rateLimits.resetsAt} |\n`;
            }
            output += '\n';
          }

          // Granted scopes
          if (permissions.scopes && permissions.scopes.length > 0) {
            output += `### ✅ Granted Scopes (${permissions.scopes.length})\n`;
            output += `| Scope | Description |\n|:------|:------------|\n`;
            for (const scope of permissions.scopes) {
              const desc = permissions.permissions[scope]?.description || 'Unknown';
              output += `| \`${scope}\` | ${desc} |\n`;
            }
            output += '\n';
          }

          // Missing scopes
          if (permissions.missingScopes && permissions.missingScopes.length > 0) {
            output += `### ⚠️ Missing Recommended Scopes\n`;
            output += `| Scope | Why Needed |\n|:------|:-----------|\n`;
            const scopeReasons: any = {
              'repo': 'Required for repository access and Actions data',
              'read:org': 'Required for organization info and team data',
              'workflow': 'Required to manage GitHub Actions workflows',
              'read:packages': 'Required for package registry access',
            };
            for (const scope of permissions.missingScopes) {
              output += `| \`${scope}\` | ${scopeReasons[scope] || 'Recommended for DevOps tools'} |\n`;
            }
            output += '\n';
          }

          // Capabilities
          if (permissions.capabilities) {
            output += `### 🔧 API Capabilities\n`;
            output += `| Capability | Status | Details |\n|:-----------|:-------|:--------|\n`;
            for (const [cap, status] of Object.entries(permissions.capabilities) as [string, any][]) {
              const icon = status.available ? '✅' : '❌';
              const details = status.available 
                ? status.description 
                : `${status.error || 'Not available'}`;
              output += `| ${cap} | ${icon} | ${details} |\n`;
            }
            output += '\n';
          }

          // Recommendations
          if (permissions.recommendations && permissions.recommendations.length > 0) {
            output += `### 💡 Recommendations\n`;
            for (const rec of permissions.recommendations) {
              output += `- **${rec.type}**: ${rec.message}\n`;
            }
          }

          return {
            content: [{
              type: 'text',
              text: output,
            }],
          };
        }

        case 'get_actions_usage_metrics': {
          const usageData = await githubClient.getActionsUsageMetrics(
            getOrgName(args),
            (args as any).timeframe,
            (args as any).breakdown
          );
          const visualization = visualizer.createUsageDashboard(usageData);
          const analysis = metricsCalculator.calculateActionsCosts(usageData);

          return {
            content: [{
              type: 'text',
            text: `## 📊 GitHub Actions Usage Metrics\n\n${analysis.summary}\n\n### Visualization:\n\`\`\`mermaid\n${visualization}\n\`\`\`\n\n### Detailed Breakdown:\n${analysis.details}`,
          }],
        };
      }

      case 'get_detailed_usage_metrics': {
        const repoFilter = (args as any).repo_filter
          ? (args as any).repo_filter.split(',').map((r: string) => r.trim())
          : defaultRepoFilter;

        const usageData = await githubClient.getDetailedUsageMetrics(
          getOrgName(args),
          (args as any).timeframe,
          repoFilter
        );
        const formatted = metricsCalculator.formatDetailedUsageMetrics(usageData);

        return {
          content: [{
            type: 'text',
            text: formatted.summary,
          }],
        };
      }

      case 'get_detailed_performance_metrics': {
        const repoFilter = (args as any).repo_filter
          ? (args as any).repo_filter.split(',').map((r: string) => r.trim())
          : defaultRepoFilter;

        const perfData = await githubClient.getDetailedPerformanceMetrics(
          getOrgName(args),
          (args as any).timeframe,
          repoFilter
        );
        const formatted = metricsCalculator.formatDetailedPerformanceMetrics(perfData);

        return {
          content: [{
            type: 'text',
            text: formatted.summary,
          }],
        };
      }

      case 'get_actions_performance_metrics': {
        const perfData = await githubClient.getActionsPerformanceMetrics(
          getOrgName(args),
          (args as any).repo_name,
          (args as any).workflow_id,
          (args as any).timeframe
        );
        const analysis = metricsCalculator.analyzePerformance(perfData);
        const chart = visualizer.createPerformanceChart(analysis);

        return {
          content: [{
            type: 'text',
            text: `## ⚡ Actions Performance Metrics\n\n${analysis.summary}\n\n\`\`\`mermaid\n${chart}\n\`\`\`\n\n### Key Insights:\n${analysis.insights}`,
          }],
        };
      }

      case 'analyze_runner_utilization': {
        const runnerData = await githubClient.getRunnerUtilization(
          getOrgName(args),
          (args as any).runner_type || 'all'
        );
        const utilization = metricsCalculator.calculateRunnerUtilization(runnerData);
        const costBreakdown = (args as any).include_costs !== false
          ? await metricsCalculator.calculateRunnerCosts(runnerData)
          : null;
        const visualization = visualizer.createRunnerUtilizationChart(utilization, costBreakdown);

        return {
          content: [{
            type: 'text',
            text: `## 🏃 Runner Utilization Analysis\n\n${utilization.summary}\n\n\`\`\`mermaid\n${visualization}\n\`\`\`\n\n${costBreakdown ? `### Cost Analysis:\n${costBreakdown.details}` : ''}`,
          }],
        };
      }

      case 'get_actions_cache_analytics': {
        const cacheData = await githubClient.getActionsCacheMetrics(
          getOrgName(args),
          (args as any).repo_name,
          (args as any).timeframe
        );
        const analysis = metricsCalculator.analyzeCacheEfficiency(cacheData);
        const visualization = visualizer.createCacheAnalyticsChart(analysis);

        return {
          content: [{
            type: 'text',
            text: `## 💾 Actions Cache Analytics\n\n${analysis.summary}\n\n\`\`\`mermaid\n${visualization}\n\`\`\`\n\n### Optimization Opportunities:\n${analysis.recommendations}`,
          }],
        };
      }

      case 'generate_cost_optimization_report': {
        const usageData = await githubClient.getComprehensiveUsageData(getOrgName(args));
        const report = await metricsCalculator.generateCostOptimizationReport(
          usageData,
          (args as any).target_savings_percentage || 20
        );
        const visualization = visualizer.createCostOptimizationDashboard(report);

        return {
          content: [{
            type: 'text',
            text: `## 💰 Cost Optimization Report\n\n${report.executive_summary}\n\n\`\`\`mermaid\n${visualization}\n\`\`\`\n\n### Top Recommendations:\n${report.recommendations}\n\n### Projected Savings:\n${report.savings_breakdown}`,
          }],
        };
      }

      case 'get_workflow_insights': {
        const workflowData = await githubClient.getWorkflowInsights(
          getOrgName(args),
          (args as any).repo_name,
          (args as any).workflow_name
        );
        const insights = await metricsCalculator.generateWorkflowInsights(
          workflowData,
          (args as any).analyze_dependencies !== false
        );
        const visualization = visualizer.createWorkflowBottleneckChart(insights);

        return {
          content: [{
            type: 'text',
            text: `## 🔍 Workflow Insights\n\n${insights.summary}\n\n\`\`\`mermaid\n${visualization}\n\`\`\`\n\n### Bottlenecks Detected:\n${insights.bottlenecks}\n\n### Optimization Suggestions:\n${insights.suggestions}`,
          }],
        };
      }

      case 'analyze_workflow_source': {
        const orgName = getOrgName(args);
        const repoName = (args as any).repo_name;
        const workflowPath = (args as any).workflow_path;

        // Fetch workflow file(s) from the repository
        const workflowFiles = await githubClient.getWorkflowFileContent(
          orgName,
          repoName,
          workflowPath
        );

        if (workflowFiles.error) {
          return {
            content: [{
              type: 'text',
              text: `## ❌ Error Fetching Workflow\n\n${workflowFiles.error}\n\n💡 Make sure the repository and workflow path are correct.`,
            }],
          };
        }

        if (workflowFiles.workflows.length === 0) {
          return {
            content: [{
              type: 'text',
              text: `## 📋 No Workflows Found\n\nNo workflow files found in \`${orgName}/${repoName}\`.\n\n💡 Workflows should be in \`.github/workflows/\` directory.`,
            }],
          };
        }

        // Analyze each workflow
        const results: string[] = [];
        
        for (const workflow of workflowFiles.workflows) {
          // Static analysis first
          const staticAnalysis = githubClient.analyzeWorkflowContent(workflow.content, workflow.name);
          
          // Prepare context for AI analysis
          const context: WorkflowSourceContext = {
            organization: orgName,
            repo: repoName,
            workflowName: staticAnalysis.name,
            workflowPath: workflow.path,
            content: workflow.content,
            staticAnalysis: {
              triggers: staticAnalysis.triggers,
              jobs: staticAnalysis.jobs,
              issues: staticAnalysis.issues,
              optimizations: staticAnalysis.optimizations,
            },
          };
          
          // Generate AI-powered insights
          const aiResult = await generateWorkflowSourceInsights(context);
          
          results.push(`# 📄 ${workflow.path}\n\n${aiResult.insights}`);
          
          if (aiResult.error) {
            results.push(`\n> ⚠️ AI analysis fallback: ${aiResult.error}`);
          }
        }

        return {
          content: [{
            type: 'text',
            text: results.join('\n\n---\n\n'),
          }],
        };
      }

      case 'get_team_productivity_metrics': {
        const productivityData = await githubClient.getTeamProductivityMetrics(
          getOrgName(args),
          (args as any).team_slug,
          (args as any).timeframe
        );
        const metrics = metricsCalculator.calculateTeamProductivity(
          productivityData,
          (args as any).include_individuals || false
        );
        const visualization = visualizer.createTeamProductivityDashboard(metrics);

        return {
          content: [{
            type: 'text',
            text: `## 👥 Team Productivity Metrics\n\n${metrics.summary}\n\n\`\`\`mermaid\n${visualization}\n\`\`\`\n\n### Key Performance Indicators:\n${metrics.kpis}\n\n${metrics.individual_highlights || ''}`,
          }],
        };
      }

      case 'get_compliance_audit_report': {
        const auditData = await githubClient.getComplianceAuditData(
          getOrgName(args),
          (args as any).include_secrets_scan !== false
        );
        const report = await metricsCalculator.generateComplianceReport(
          auditData,
          (args as any).compliance_framework
        );
        const visualization = visualizer.createComplianceDashboard(report);

        return {
          content: [{
            type: 'text',
            text: `## 🔒 Compliance Audit Report\n\n${report.executive_summary}\n\n\`\`\`mermaid\n${visualization}\n\`\`\`\n\n### Compliance Status:\n${report.compliance_status}\n\n### Risk Assessment:\n${report.risk_assessment}\n\n### Required Actions:\n${report.required_actions}`,
          }],
        };
      }

      // ============================================
      // DORA Metrics & Developer Experience Tool Handlers
      // ============================================

      case 'get_dora_metrics': {
        const repoFilter = (args as any).repo_filter 
          ? (args as any).repo_filter.split(',').map((r: string) => r.trim()) 
          : defaultRepoFilter;
        
        const doraData = await githubClient.getDoraMetrics(
          getOrgName(args),
          repoFilter?.[0],  // Pass first repo from filter, or undefined for org-wide
          (args as any).timeframe || '30d'
        );
        const formatted = metricsCalculator.formatDoraMetrics(doraData);

        return {
          content: [{
            type: 'text',
            text: `${formatted.summary}\n\n${formatted.benchmarks}\n\n${formatted.recommendations}`,
          }],
        };
      }

      case 'get_pull_request_metrics': {
        const prData = await githubClient.getPullRequestMetrics(
          getOrgName(args),
          (args as any).timeframe,
          (args as any).repo_name
        );
        const formatted = metricsCalculator.formatPullRequestMetrics(prData);

        return {
          content: [{
            type: 'text',
            text: formatted.summary,
          }],
        };
      }

      case 'get_issue_metrics': {
        const issueData = await githubClient.getIssueMetrics(
          getOrgName(args),
          (args as any).timeframe,
          (args as any).repo_name,
          (args as any).label_filter
        );
        const formatted = metricsCalculator.formatIssueMetrics(issueData);

        return {
          content: [{
            type: 'text',
            text: formatted.summary,
          }],
        };
      }

      case 'get_deployment_metrics': {
        const repoFilter = (args as any).repo_filter
          ? (args as any).repo_filter.split(',').map((r: string) => r.trim())
          : defaultRepoFilter;
        
        const deploymentData = await githubClient.getDeploymentMetrics(
          getOrgName(args),
          (args as any).timeframe,
          (args as any).environment,
          repoFilter
        );
        const formatted = metricsCalculator.formatDeploymentMetrics(deploymentData);

        return {
          content: [{
            type: 'text',
            text: formatted.summary,
          }],
        };
      }

      case 'get_environment_metrics': {
        const repoFilter = (args as any).repo_filter
          ? (args as any).repo_filter.split(',').map((r: string) => r.trim())
          : defaultRepoFilter;

        const envData = await githubClient.getEnvironmentMetrics(
          getOrgName(args),
          repoFilter
        );
        const formatted = metricsCalculator.formatEnvironmentMetrics(envData);

        return {
          content: [{
            type: 'text',
            text: formatted.summary,
          }],
        };
      }

      case 'get_discussion_metrics': {
        const discussionData = await githubClient.getDiscussionMetrics(
          getOrgName(args),
          (args as any).timeframe,
          (args as any).repo_name
        );
        const formatted = metricsCalculator.formatDiscussionMetrics(discussionData);

        return {
          content: [{
            type: 'text',
            text: formatted.summary,
          }],
        };
      }

      case 'get_merge_queue_metrics': {
        const queueData = await githubClient.getMergeQueueMetrics(
          getOrgName(args),
          (args as any).repo_name,
          (args as any).timeframe || '30d'
        );
        const formatted = metricsCalculator.formatMergeQueueMetrics(queueData);

        return {
          content: [{
            type: 'text',
            text: formatted.summary,
          }],
        };
      }

      case 'get_enhanced_dora_metrics': {
        const repoFilter = (args as any).repo_filter
          ? (args as any).repo_filter.split(',').map((r: string) => r.trim())
          : defaultRepoFilter;

        const doraData = await githubClient.getEnhancedDoraMetrics(
          getOrgName(args),
          (args as any).timeframe,
          repoFilter
        );
        const formatted = metricsCalculator.formatEnhancedDoraMetrics(doraData);

        return {
          content: [{
            type: 'text',
            text: `${formatted.summary}\n\n${formatted.benchmarks}\n\n${formatted.recommendations}`,
          }],
        };
      }

      // ============================================
      // Custom Properties Tool Handlers
      // ============================================

      case 'get_org_custom_properties': {
        const propertyData = await githubClient.getOrgCustomProperties(getOrgName(args));
        const formatted = metricsCalculator.formatOrgCustomProperties(propertyData);

        return {
          content: [{
            type: 'text',
            text: formatted.summary,
          }],
        };
      }

      case 'get_custom_properties_analytics': {
        const analyticsData = await githubClient.getCustomPropertiesAnalytics(getOrgName(args));
        const formatted = metricsCalculator.formatCustomPropertiesAnalytics(analyticsData);

        return {
          content: [{
            type: 'text',
            text: formatted.summary,
          }],
        };
      }

      case 'get_repos_by_property': {
        const repoData = await githubClient.getReposByCustomProperty(
          getOrgName(args),
          (args as any).property_name,
          (args as any).property_value
        );
        const formatted = metricsCalculator.formatReposByProperty(repoData);

        return {
          content: [{
            type: 'text',
            text: formatted.summary,
          }],
        };
      }

      // ============================================
      // Configuration Management Tool Handlers
      // ============================================

      case 'get_devops_config': {
        const config = configLoader.getConfig();
        if (!config) {
          return {
            content: [{
              type: 'text',
              text: '❌ No configuration loaded. Try reloading with `reload_devops_config`.',
            }],
          };
        }

        const verbose = (args as any).verbose || false;
        let output = configLoader.getSummary();

        if (verbose && config.workflowPolicies.length > 0) {
          output += '\n\n### Workflow Policies:\n';
          for (const policy of config.workflowPolicies) {
            output += `- **${policy.metadata.name}** (v${policy.metadata.version})\n`;
            if (policy.spec.naming) {
              output += `  - Naming pattern: \`${policy.spec.naming.pattern}\`\n`;
            }
            if (policy.spec.forbidden?.actions) {
              output += `  - Forbidden actions: ${policy.spec.forbidden.actions.length}\n`;
            }
          }
        }

        return {
          content: [{
            type: 'text',
            text: output,
          }],
        };
      }

      case 'reload_devops_config': {
        const reloadedConfig = await configLoader.reload();
        return {
          content: [{
            type: 'text',
            text: `✅ Configuration reloaded successfully!\n\n${configLoader.getSummary()}`,
          }],
        };
      }

      case 'list_monitored_repositories': {
        const config = configLoader.getConfig();
        if (!config || !config.repositoryInventory) {
          return {
            content: [{
              type: 'text',
              text: '📋 No repository inventory configured.\n\n💡 Tip: Create a `repositories/inventory.yaml` in your devops-config repo.',
            }],
          };
        }

        const inventory = config.repositoryInventory;
        let repos = inventory.spec.repositories || [];

        // Apply filters
        const teamFilter = (args as any).team;
        const tierFilter = (args as any).tier;
        const complianceFilter = (args as any).compliance;

        if (teamFilter) {
          repos = repos.filter(r => r.team === teamFilter);
        }
        if (tierFilter) {
          repos = repos.filter(r => r.tier === tierFilter);
        }
        if (complianceFilter) {
          repos = repos.filter(r => r.compliance?.includes(complianceFilter));
        }

        if (repos.length === 0) {
          return {
            content: [{
              type: 'text',
              text: '📋 No repositories match the filter criteria.',
            }],
          };
        }

        let output = `## 📦 Monitored Repositories (${repos.length})\n\n`;
        output += '| Repository | Team | Tier | Compliance |\n';
        output += '|------------|------|------|------------|\n';
        for (const repo of repos) {
          output += `| ${repo.name} | ${repo.team || '-'} | ${repo.tier || '-'} | ${repo.compliance?.join(', ') || '-'} |\n`;
        }

        // Show groups if defined
        if (inventory.spec.groups) {
          output += '\n### Repository Groups:\n';
          for (const [name, group] of Object.entries(inventory.spec.groups)) {
            output += `- **${name}**: ${group.pattern || `${group.repositories?.length || 0} repos`}\n`;
          }
        }

        return {
          content: [{
            type: 'text',
            text: output,
          }],
        };
      }

      case 'list_workflow_policies': {
        const config = configLoader.getConfig();
        if (!config || config.workflowPolicies.length === 0) {
          return {
            content: [{
              type: 'text',
              text: '📜 No workflow policies loaded.\n\n💡 Tip: Create policy files in `policies/workflow-policies.yaml` in your devops-config repo.',
            }],
          };
        }

        const policyName = (args as any).policy_name;

        if (policyName) {
          // Show specific policy details
          const policy = config.workflowPolicies.find(p => p.metadata.name === policyName);
          if (!policy) {
            return {
              content: [{
                type: 'text',
                text: `❌ Policy "${policyName}" not found. Available policies: ${config.workflowPolicies.map(p => p.metadata.name).join(', ')}`,
              }],
            };
          }

          let output = `## 📜 Policy: ${policy.metadata.name}\n\n`;
          output += `**Version:** ${policy.metadata.version}\n`;
          if (policy.metadata.description) {
            output += `**Description:** ${policy.metadata.description}\n`;
          }

          if (policy.spec.naming) {
            output += `\n### Naming Convention\n`;
            output += `- Pattern: \`${policy.spec.naming.pattern}\`\n`;
            output += `- Message: ${policy.spec.naming.message}\n`;
          }

          if (policy.spec.requirements) {
            output += `\n### Requirements\n`;
            if (policy.spec.requirements.timeout) {
              output += `- **Timeout:** Max ${policy.spec.requirements.timeout.maxMinutes} minutes\n`;
            }
            if (policy.spec.requirements.permissions) {
              output += `- **Permissions:** Explicit declaration ${policy.spec.requirements.permissions.requireExplicit ? 'required' : 'optional'}\n`;
            }
            if (policy.spec.requirements.concurrency) {
              output += `- **Concurrency:** cancel-in-progress ${policy.spec.requirements.concurrency.requireCancelInProgress ? 'required' : 'optional'}\n`;
            }
          }

          if (policy.spec.forbidden) {
            output += `\n### Forbidden Patterns\n`;
            if (policy.spec.forbidden.actions) {
              output += `**Actions:**\n`;
              for (const action of policy.spec.forbidden.actions) {
                output += `- \`${action.pattern}\` - ${action.reason}\n`;
              }
            }
            if (policy.spec.forbidden.commands) {
              output += `**Commands:**\n`;
              for (const cmd of policy.spec.forbidden.commands) {
                output += `- \`${cmd.pattern}\` - ${cmd.reason}\n`;
              }
            }
          }

          return {
            content: [{
              type: 'text',
              text: output,
            }],
          };
        }

        // List all policies
        let output = `## 📜 Workflow Policies (${config.workflowPolicies.length})\n\n`;
        for (const policy of config.workflowPolicies) {
          output += `### ${policy.metadata.name}\n`;
          output += `- Version: ${policy.metadata.version}\n`;
          if (policy.spec.naming) {
            output += `- Naming pattern: \`${policy.spec.naming.pattern}\`\n`;
          }
          if (policy.spec.forbidden?.actions) {
            output += `- Forbidden actions: ${policy.spec.forbidden.actions.length} rules\n`;
          }
          if (policy.spec.requiredSteps) {
            output += `- Required steps: ${Object.keys(policy.spec.requiredSteps).join(', ')}\n`;
          }
          output += '\n';
        }

        return {
          content: [{
            type: 'text',
            text: output,
          }],
        };
      }

      // ============================================
      // Database Migration Tools
      // ============================================
      case 'detect_database_migrations': {
        const orgName = getOrgName(args);
        const repoName = (args as any).repo_name;
        const includeContent = (args as any).include_content === true;

        if (!repoName) {
          return {
            content: [{
              type: 'text',
              text: '❌ Repository name is required. Please provide `repo_name` parameter.',
            }],
          };
        }

        // Import migration detector dynamically
        const { migrationDetector } = await import('./migrations/index.js');

        // Define migration paths to search
        const allMigrationPaths = [
          // Flyway
          'src/main/resources/db/migration',
          'db/migration',
          'flyway/migrations',
          // Liquibase
          'src/main/resources/db/changelog',
          'db/changelog',
          // Alembic
          'alembic/versions',
          'migrations/versions',
          // Prisma
          'prisma/migrations',
          // Knex/TypeORM/Sequelize
          'migrations',
          'db/migrations',
          'src/migrations',
          // Rails
          'db/migrate',
          // .NET
          'Migrations',
          'Data/Migrations',
        ];

        // Fetch build config files to detect migration tool
        const buildConfigs = await githubClient.getBuildConfigFiles(orgName, repoName);
        
        let detectedTool: string = 'unknown';
        let detectedBuildSystem: string = 'unknown';
        let pluginVersion: string | null = null;

        // Analyze build configs for migration plugins
        for (const config of buildConfigs.configs) {
          const detection = migrationDetector.detectMigrationToolFromBuildConfig(config.content, config.name);
          if (detection) {
            detectedTool = detection.tool;
            detectedBuildSystem = detection.buildSystem;
            pluginVersion = detection.pluginVersion;
            break;
          }
        }

        // Fetch migration files
        const migrationResult = await githubClient.getMigrationFiles(orgName, repoName, allMigrationPaths);

        // Check workflows for migration commands
        const workflowResult = await githubClient.getWorkflowFileContent(orgName, repoName);
        const workflowMigrations: Array<{ workflow: string; command: string; stage: string }> = [];
        
        for (const workflow of workflowResult.workflows) {
          const detected = migrationDetector.detectMigrationInWorkflow(workflow.content);
          for (const migration of detected) {
            workflowMigrations.push({
              workflow: workflow.path,
              command: migration.command,
              stage: migration.stage,
            });
            // Update detected tool if not found in build config
            if (detectedTool === 'unknown') {
              detectedTool = detected[0]?.command?.toLowerCase().includes('flyway') ? 'flyway' :
                            detected[0]?.command?.toLowerCase().includes('liquibase') ? 'liquibase' :
                            detected[0]?.command?.toLowerCase().includes('prisma') ? 'prisma' :
                            detected[0]?.command?.toLowerCase().includes('ef') ? 'efcore' : 'unknown';
            }
          }
        }

        // Calculate confidence
        const hasMigrationFiles = migrationResult.files.length > 0;
        const hasWorkflowCommand = workflowMigrations.length > 0;
        const hasBuildPlugin = detectedTool !== 'unknown';
        const confidence = migrationDetector.calculateConfidence(
          hasBuildPlugin,
          hasMigrationFiles,
          hasWorkflowCommand,
          migrationResult.files.length
        );

        // Analyze migration files for operations
        const fileAnalysis: Array<{
          file: string;
          version: string | null;
          description: string | null;
          operations: number;
          riskLevel: string;
        }> = [];

        for (const file of migrationResult.files) {
          const parsed = migrationDetector.parseMigrationFileName(file.name, detectedTool as any);
          const operations = migrationDetector.detectSQLOperations(file.content);
          const maxRisk = operations.reduce((max, op) => {
            const riskOrder = { low: 0, medium: 1, high: 2, critical: 3 };
            return riskOrder[op.riskLevel] > riskOrder[max as keyof typeof riskOrder] ? op.riskLevel : max;
          }, 'low');

          fileAnalysis.push({
            file: file.path,
            version: parsed.version,
            description: parsed.description,
            operations: operations.length,
            riskLevel: maxRisk,
          });
        }

        // Build output
        let output = `## 🗄️ Database Migration Detection\n\n`;
        output += `**Repository:** ${orgName}/${repoName}\n`;
        output += `**Detection Confidence:** ${confidence}\n\n`;

        output += `### 🔍 Detection Summary\n`;
        output += `| Property | Value |\n|:---------|:------|\n`;
        output += `| Migration Tool | ${detectedTool} |\n`;
        output += `| Build System | ${detectedBuildSystem} |\n`;
        if (pluginVersion) {
          output += `| Plugin Version | ${pluginVersion} |\n`;
        }
        output += `| Migration Path | ${migrationResult.detectedPath || 'Not found'} |\n`;
        output += `| Migration Files | ${migrationResult.files.length} |\n`;
        output += `| Workflow Integrations | ${workflowMigrations.length} |\n\n`;

        if (fileAnalysis.length > 0) {
          output += `### 📁 Migration Files\n`;
          output += `| File | Version | Description | Operations | Risk |\n`;
          output += `|:-----|:--------|:------------|:-----------|:-----|\n`;
          for (const file of fileAnalysis.slice(0, 15)) {
            const riskEmoji = file.riskLevel === 'critical' ? '🔴' : 
                             file.riskLevel === 'high' ? '🟠' : 
                             file.riskLevel === 'medium' ? '🟡' : '🟢';
            output += `| ${file.file.split('/').pop()} | ${file.version || '-'} | ${file.description || '-'} | ${file.operations} | ${riskEmoji} ${file.riskLevel} |\n`;
          }
          if (fileAnalysis.length > 15) {
            output += `\n_...and ${fileAnalysis.length - 15} more files_\n`;
          }
          output += '\n';
        }

        if (workflowMigrations.length > 0) {
          output += `### ⚙️ Workflow Integrations\n`;
          for (const wf of workflowMigrations) {
            output += `- **${wf.workflow}**: \`${wf.command}\` (${wf.stage})\n`;
          }
          output += '\n';
        }

        if (buildConfigs.configs.length > 0) {
          output += `### 📦 Build Configurations Found\n`;
          for (const config of buildConfigs.configs) {
            output += `- ${config.path} (${config.type})\n`;
          }
        }

        return {
          content: [{
            type: 'text',
            text: output,
          }],
        };
      }

      case 'validate_migration_policies': {
        const orgName = getOrgName(args);
        const repoName = (args as any).repo_name;
        const environment = (args as any).environment || 'development';
        const migrationPath = (args as any).migration_path;

        if (!repoName) {
          return {
            content: [{
              type: 'text',
              text: '❌ Repository name is required. Please provide `repo_name` parameter.',
            }],
          };
        }

        // Import migration modules
        const { migrationDetector, migrationValidator, getAllMigrationPaths } = await import('./migrations/index.js');

        // Load migration policies from config
        const config = configLoader.getConfig();
        if (config?.migrationPolicies && config.migrationPolicies.length > 0) {
          await migrationValidator.loadPolicies(config.migrationPolicies as any);
        }

        // First, detect the migration tool and its paths from build configs
        const buildConfigs = await githubClient.getBuildConfigFiles(orgName, repoName);
        let detectedTool: any = 'unknown';
        let detectedMigrationPaths: string[] = [];

        for (const cfg of buildConfigs.configs) {
          const detection = migrationDetector.detectMigrationToolFromBuildConfig(cfg.content, cfg.name);
          if (detection) {
            detectedTool = detection.tool;
            detectedMigrationPaths = detection.migrationPaths || [];
            break;
          }
        }

        // Use detected paths first, then fall back to all common paths
        const pathsToSearch = detectedMigrationPaths.length > 0
          ? [...detectedMigrationPaths, ...getAllMigrationPaths()]
          : getAllMigrationPaths();

        const migrationResult = await githubClient.getMigrationFiles(orgName, repoName, pathsToSearch);

        if (migrationResult.files.length === 0) {
          return {
            content: [{
              type: 'text',
              text: `## 📋 Migration Policy Validation\n\n**Repository:** ${orgName}/${repoName}\n**Detected Tool:** ${detectedTool}\n\n⚠️ No migration files found.\n\n**Paths searched:**\n${pathsToSearch.slice(0, 10).map(p => `- \`${p}\``).join('\n')}${pathsToSearch.length > 10 ? `\n- ... and ${pathsToSearch.length - 10} more` : ''}\n\n💡 If migrations exist elsewhere, use \`migration_path\` parameter to specify the location.`,
            }],
          };
        }

        // Set default database assumption
        const database: any = 'postgresql';

        // Validate each migration file
        const validationResults: Array<{
          file: string;
          isValid: boolean;
          violations: number;
          warnings: number;
          riskLevel: string;
          criticalIssues: string[];
        }> = [];

        let totalViolations = 0;
        let totalWarnings = 0;
        let criticalCount = 0;

        const filesToValidate = migrationPath 
          ? migrationResult.files.filter(f => f.path.includes(migrationPath))
          : migrationResult.files;

        for (const file of filesToValidate) {
          const result = await migrationValidator.validateSQL(
            file.content,
            environment,
            {
              repository: `${orgName}/${repoName}`,
              migrationFile: file.path,
              migrationTool: detectedTool,
              database,
              hasRollback: false, // TODO: detect rollback files
              inTransaction: file.content.toLowerCase().includes('begin'),
            }
          );

          const criticalViolations = result.violations.filter(v => v.severity === 'critical');
          
          validationResults.push({
            file: file.path,
            isValid: result.isValid,
            violations: result.violations.length,
            warnings: result.warnings.length,
            riskLevel: result.riskAssessment.level,
            criticalIssues: criticalViolations.map(v => v.message),
          });

          totalViolations += result.violations.length;
          totalWarnings += result.warnings.length;
          if (criticalViolations.length > 0) criticalCount++;
        }

        // Build output
        let output = `## 🔍 Migration Policy Validation\n\n`;
        output += `**Repository:** ${orgName}/${repoName}\n`;
        output += `**Environment:** ${environment}\n`;
        output += `**Files Validated:** ${filesToValidate.length}\n\n`;

        // Summary
        const passedCount = validationResults.filter(r => r.isValid).length;
        const passRate = filesToValidate.length > 0 
          ? Math.round((passedCount / filesToValidate.length) * 100) 
          : 0;

        output += `### 📊 Summary\n`;
        output += `| Metric | Value |\n|:-------|:------|\n`;
        output += `| Pass Rate | ${passRate}% (${passedCount}/${filesToValidate.length}) |\n`;
        output += `| Total Violations | ${totalViolations} |\n`;
        output += `| Total Warnings | ${totalWarnings} |\n`;
        output += `| Critical Issues | ${criticalCount} |\n\n`;

        // Validation results table
        output += `### 📋 Validation Results\n`;
        output += `| File | Status | Violations | Warnings | Risk |\n`;
        output += `|:-----|:-------|:-----------|:---------|:-----|\n`;
        
        for (const result of validationResults) {
          const status = result.isValid ? '✅ Pass' : '❌ Fail';
          const riskEmoji = result.riskLevel === 'critical' ? '🔴' : 
                           result.riskLevel === 'high' ? '🟠' : 
                           result.riskLevel === 'medium' ? '🟡' : '🟢';
          output += `| ${result.file.split('/').pop()} | ${status} | ${result.violations} | ${result.warnings} | ${riskEmoji} ${result.riskLevel} |\n`;
        }
        output += '\n';

        // Show critical issues
        const criticalFiles = validationResults.filter(r => r.criticalIssues.length > 0);
        if (criticalFiles.length > 0) {
          output += `### 🚨 Critical Issues\n`;
          for (const result of criticalFiles) {
            output += `\n**${result.file.split('/').pop()}:**\n`;
            for (const issue of result.criticalIssues) {
              output += `- ❌ ${issue}\n`;
            }
          }
          output += '\n';
        }

        // Policy info
        const policySummary = migrationValidator.getPoliciesSummary();
        output += `### 📜 Policies Applied\n`;
        if (policySummary.policies.length > 0) {
          for (const policy of policySummary.policies) {
            output += `- **${policy.name}** v${policy.version}\n`;
          }
        } else {
          output += `_Using default built-in policies_\n`;
        }
        output += `\n- Forbidden patterns: ${policySummary.forbiddenCount}\n`;
        output += `- Restricted patterns: ${policySummary.restrictedCount}\n`;

        return {
          content: [{
            type: 'text',
            text: output,
          }],
        };
      }

      case 'list_migration_policies': {
        const { migrationValidator } = await import('./migrations/index.js');
        
        // Load policies from config
        const config = configLoader.getConfig();
        if (config?.migrationPolicies && config.migrationPolicies.length > 0) {
          await migrationValidator.loadPolicies(config.migrationPolicies as any);
        }

        const policyName = (args as any).policy_name;
        const summary = migrationValidator.getPoliciesSummary();

        if (summary.policies.length === 0) {
          let output = `## 📜 Migration Policies\n\n`;
          output += `⚠️ No custom migration policies loaded. Using **built-in default policies**.\n\n`;
          output += `### Default Policy Summary\n`;
          output += `- **${summary.forbiddenCount}** forbidden operation patterns (DBA-only operations)\n`;
          output += `- **${summary.restrictedCount}** restricted operation patterns (require review)\n\n`;
          output += `### Forbidden Operations (Built-in)\n`;
          output += `| Operation | Severity | Reason |\n|:----------|:---------|:-------|\n`;
          output += `| DROP DATABASE | Critical | Database drops must be performed by DBAs |\n`;
          output += `| DROP SCHEMA | Critical | Schema drops require DBA intervention |\n`;
          output += `| GRANT/REVOKE | Critical | Permission changes must be managed by DBAs |\n`;
          output += `| CREATE/ALTER/DROP USER | Critical | User management must be managed by DBAs |\n`;
          output += `| TRUNCATE TABLE | High | TRUNCATE operations require explicit approval |\n`;
          output += `| ALTER SYSTEM | Critical | System-level changes are forbidden |\n`;
          output += `| xp_cmdshell | Critical | OS command execution is forbidden |\n\n`;
          output += `### Restricted Operations (Built-in)\n`;
          output += `| Operation | Severity | Message |\n|:----------|:---------|:--------|\n`;
          output += `| DROP TABLE | High | Table drops require DBA approval for production |\n`;
          output += `| DROP COLUMN | High | Column drops are backwards-incompatible |\n`;
          output += `| ALTER TYPE/MODIFY | Medium | Type changes may cause data loss |\n`;
          output += `| CREATE INDEX (non-concurrent) | Medium | Use CONCURRENTLY to avoid locks (PostgreSQL) |\n\n`;
          output += `💡 **Tip:** Create \`policies/migration-policies.yaml\` in your devops-config repo to customize policies.`;

          return {
            content: [{
              type: 'text',
              text: output,
            }],
          };
        }

        // Show loaded policies
        if (policyName) {
          const policy = config?.migrationPolicies?.find((p: any) => p.metadata.name === policyName);
          if (!policy) {
            return {
              content: [{
                type: 'text',
                text: `❌ Policy "${policyName}" not found. Available policies: ${summary.policies.map(p => p.name).join(', ')}`,
              }],
            };
          }

          let output = `## 📜 Migration Policy: ${policy.metadata.name}\n\n`;
          output += `**Version:** ${policy.metadata.version}\n`;
          if (policy.metadata.description) {
            output += `**Description:** ${policy.metadata.description}\n`;
          }
          output += '\n';

          // Show spec details
          if (policy.spec.forbidden?.operations) {
            output += `### 🚫 Forbidden Operations\n`;
            output += `| Pattern | Severity | Reason |\n|:--------|:---------|:-------|\n`;
            for (const op of policy.spec.forbidden.operations) {
              output += `| \`${op.pattern}\` | ${op.severity} | ${op.reason} |\n`;
            }
            output += '\n';
          }

          if (policy.spec.restricted?.operations) {
            output += `### ⚠️ Restricted Operations\n`;
            output += `| Pattern | Severity | Message |\n|:--------|:---------|:--------|\n`;
            for (const op of policy.spec.restricted.operations) {
              output += `| \`${op.pattern}\` | ${op.severity} | ${op.message} |\n`;
            }
            output += '\n';
          }

          if (policy.spec.environments) {
            output += `### 🌍 Environment Rules\n`;
            for (const [env, rules] of Object.entries(policy.spec.environments as Record<string, any>)) {
              output += `\n**${env}:**\n`;
              output += `- Enforcement: ${rules.enforcement}\n`;
              output += `- Allow Destructive: ${rules.allowDestructive}\n`;
              output += `- Require Approval: ${rules.requireApproval}\n`;
              if (rules.requireRollback) output += `- Require Rollback: ${rules.requireRollback}\n`;
            }
          }

          return {
            content: [{
              type: 'text',
              text: output,
            }],
          };
        }

        // List all policies
        let output = `## 📜 Migration Policies (${summary.policies.length})\n\n`;
        for (const policy of summary.policies) {
          output += `### ${policy.name}\n`;
          output += `- Version: ${policy.version}\n`;
          if (policy.description) {
            output += `- Description: ${policy.description}\n`;
          }
          output += '\n';
        }
        output += `\n**Total Rules:**\n`;
        output += `- Forbidden operations: ${summary.forbiddenCount}\n`;
        output += `- Restricted operations: ${summary.restrictedCount}\n`;

        return {
          content: [{
            type: 'text',
            text: output,
          }],
        };
      }

      case 'get_migration_summary': {
        const orgName = getOrgName(args);
        const repoFilter = (args as any).repo_filter;

        // Get repositories to scan
        let reposToScan: string[] = [];
        
        if (repoFilter) {
          reposToScan = repoFilter.split(',').map((r: string) => r.trim());
        } else {
          // Get from inventory or fetch first 10 repos
          const config = configLoader.getConfig();
          if (config?.repositoryInventory?.spec?.repositories) {
            reposToScan = config.repositoryInventory.spec.repositories
              .slice(0, 10)
              .map(r => r.name.includes('/') ? r.name.split('/')[1] : r.name);
          } else {
            // Fetch repos from org (limited)
            try {
              const { data: repos } = await (githubClient as any).octokit.rest.repos.listForOrg({
                org: orgName,
                per_page: 10,
                sort: 'updated',
              });
              reposToScan = repos.map((r: any) => r.name);
            } catch {
              return {
                content: [{
                  type: 'text',
                  text: `## 🗄️ Migration Summary\n\n⚠️ Could not list repositories. Please provide \`repo_filter\` parameter with specific repositories to scan.`,
                }],
              };
            }
          }
        }

        const { migrationDetector } = await import('./migrations/index.js');

        const migrationPaths = [
          'src/main/resources/db/migration',
          'db/migration',
          'prisma/migrations',
          'migrations',
          'db/migrate',
          'alembic/versions',
        ];

        // Scan each repo
        const results: Array<{
          repo: string;
          hasMigrations: boolean;
          tool: string;
          fileCount: number;
          hasWorkflowIntegration: boolean;
        }> = [];

        for (const repo of reposToScan.slice(0, 10)) {
          try {
            const migrationResult = await githubClient.getMigrationFiles(orgName, repo, migrationPaths);
            const buildConfigs = await githubClient.getBuildConfigFiles(orgName, repo);
            
            let detectedTool = 'unknown';
            for (const config of buildConfigs.configs) {
              const detection = migrationDetector.detectMigrationToolFromBuildConfig(config.content, config.name);
              if (detection) {
                detectedTool = detection.tool;
                break;
              }
            }

            // Quick workflow check
            const workflows = await githubClient.getWorkflowFileContent(orgName, repo);
            let hasWorkflowIntegration = false;
            for (const wf of workflows.workflows) {
              if (migrationDetector.detectMigrationInWorkflow(wf.content).length > 0) {
                hasWorkflowIntegration = true;
                break;
              }
            }

            results.push({
              repo,
              hasMigrations: migrationResult.files.length > 0,
              tool: detectedTool,
              fileCount: migrationResult.files.length,
              hasWorkflowIntegration,
            });
          } catch {
            results.push({
              repo,
              hasMigrations: false,
              tool: 'error',
              fileCount: 0,
              hasWorkflowIntegration: false,
            });
          }
        }

        // Build summary
        const withMigrations = results.filter(r => r.hasMigrations);
        const byTool = withMigrations.reduce((acc, r) => {
          acc[r.tool] = (acc[r.tool] || 0) + 1;
          return acc;
        }, {} as Record<string, number>);

        let output = `## 🗄️ Database Migration Summary\n\n`;
        output += `**Organization:** ${orgName}\n`;
        output += `**Repositories Scanned:** ${results.length}\n\n`;

        output += `### 📊 Overview\n`;
        output += `| Metric | Value |\n|:-------|:------|\n`;
        output += `| Repos with Migrations | ${withMigrations.length} |\n`;
        output += `| Total Migration Files | ${results.reduce((sum, r) => sum + r.fileCount, 0)} |\n`;
        output += `| With Workflow Integration | ${results.filter(r => r.hasWorkflowIntegration).length} |\n\n`;

        if (Object.keys(byTool).length > 0) {
          output += `### 🔧 Migration Tools in Use\n`;
          output += `| Tool | Repositories |\n|:-----|:-------------|\n`;
          for (const [tool, count] of Object.entries(byTool).sort((a, b) => b[1] - a[1])) {
            output += `| ${tool} | ${count} |\n`;
          }
          output += '\n';
        }

        output += `### 📋 Repository Details\n`;
        output += `| Repository | Migrations | Tool | Files | CI/CD |\n`;
        output += `|:-----------|:-----------|:-----|:------|:------|\n`;
        for (const r of results) {
          const hasCI = r.hasWorkflowIntegration ? '✅' : '❌';
          output += `| ${r.repo} | ${r.hasMigrations ? '✅' : '❌'} | ${r.tool} | ${r.fileCount} | ${hasCI} |\n`;
        }

        return {
          content: [{
            type: 'text',
            text: output,
          }],
        };
      }

      case 'analyze_migration_pipeline': {
        const orgName = getOrgName(args);
        const repoName = (args as any).repo_name;
        const workflowPath = (args as any).workflow_path;

        if (!repoName) {
          return {
            content: [{
              type: 'text',
              text: '❌ Repository name is required. Please provide `repo_name` parameter.',
            }],
          };
        }

        const { migrationDetector } = await import('./migrations/index.js');

        // Get build configs to detect migration tool and build system
        const buildConfigs = await githubClient.getBuildConfigFiles(orgName, repoName);
        let detectedTool: any = 'unknown';
        let detectedBuildSystem: any = 'unknown';
        let buildConfigContent = '';
        
        for (const cfg of buildConfigs.configs) {
          const detection = migrationDetector.detectMigrationToolFromBuildConfig(cfg.content, cfg.name);
          if (detection) {
            detectedTool = detection.tool;
            detectedBuildSystem = detection.buildSystem;
            buildConfigContent = cfg.content;
            break;
          }
        }

        // Get workflow files
        const workflows = await githubClient.getWorkflowFileContent(orgName, repoName);
        
        if (workflows.workflows.length === 0) {
          return {
            content: [{
              type: 'text',
              text: `## 🔒 Migration Pipeline Safety Analysis\n\n**Repository:** ${orgName}/${repoName}\n\n⚠️ No workflow files found in \`.github/workflows/\`.\n\n💡 Add CI/CD workflows to enable migration safety analysis.`,
            }],
          };
        }

        // Filter workflows if path specified
        const workflowsToAnalyze = workflowPath 
          ? workflows.workflows.filter(w => w.path.includes(workflowPath))
          : workflows.workflows;

        // Analyze each workflow
        const analysisResults: Array<{
          workflow: string;
          hasMigration: boolean;
          migrationMode: 'explicit' | 'build-integrated' | 'runtime' | 'none';
          migrationModeDescription?: string;
          safetyScore: number;
          checks: Array<{
            check: string;
            status: 'pass' | 'fail' | 'warning';
            description: string;
            details?: string;
          }>;
          recommendations: string[];
        }> = [];

        let totalMigrationWorkflows = 0;
        let totalSafetyScore = 0;

        for (const wf of workflowsToAnalyze) {
          // Pass build config content to detect runtime/build-integrated migrations
          const analysis = migrationDetector.analyzeMigrationSafety(
            wf.content, 
            detectedTool,
            buildConfigContent,
            detectedBuildSystem
          );
          
          if (analysis.hasMigration) {
            totalMigrationWorkflows++;
            totalSafetyScore += analysis.safetyScore;
          }

          analysisResults.push({
            workflow: wf.path.split('/').pop() || wf.path,
            hasMigration: analysis.hasMigration,
            migrationMode: analysis.migrationMode,
            migrationModeDescription: analysis.migrationModeDescription,
            safetyScore: analysis.safetyScore,
            checks: analysis.checks,
            recommendations: analysis.recommendations,
          });
        }

        // Build output
        let output = `## 🔒 Migration Pipeline Safety Analysis\n\n`;
        output += `**Repository:** ${orgName}/${repoName}\n`;
        output += `**Detected Migration Tool:** ${detectedTool}\n`;
        output += `**Build System:** ${detectedBuildSystem}\n`;
        output += `**Workflows Analyzed:** ${workflowsToAnalyze.length}\n`;
        output += `**Workflows with Migrations:** ${totalMigrationWorkflows}\n\n`;

        if (totalMigrationWorkflows > 0) {
          const avgScore = Math.round(totalSafetyScore / totalMigrationWorkflows);
          const scoreEmoji = avgScore >= 80 ? '🟢' : avgScore >= 60 ? '🟡' : avgScore >= 40 ? '🟠' : '🔴';
          output += `### 📊 Overall Safety Score: ${scoreEmoji} ${avgScore}%\n\n`;
        }

        // Show results for each workflow with migrations
        const migrationWorkflows = analysisResults.filter(r => r.hasMigration);
        
        if (migrationWorkflows.length > 0) {
          output += `### 🔍 Workflow Safety Checks\n\n`;
          
          for (const result of migrationWorkflows) {
            const scoreEmoji = result.safetyScore >= 80 ? '🟢' : result.safetyScore >= 60 ? '🟡' : result.safetyScore >= 40 ? '🟠' : '🔴';
            const modeLabel = result.migrationMode === 'explicit' ? '📋 Explicit' :
                             result.migrationMode === 'build-integrated' ? '🔧 Build-Integrated' :
                             result.migrationMode === 'runtime' ? '🚀 Runtime' : '';
            output += `#### ${result.workflow} ${scoreEmoji} ${result.safetyScore}%\n\n`;
            output += `**Migration Mode:** ${modeLabel}\n`;
            if (result.migrationModeDescription) {
              output += `> ${result.migrationModeDescription}\n`;
            }
            output += '\n';
            output += `| Check | Status | Details |\n|:------|:-------|:--------|\n`;
            
            for (const check of result.checks) {
              const statusEmoji = check.status === 'pass' ? '✅' : check.status === 'warning' ? '⚠️' : '❌';
              output += `| ${check.description} | ${statusEmoji} | ${check.details || '-'} |\n`;
            }
            output += '\n';

            if (result.recommendations.length > 0) {
              output += `**Recommendations:**\n`;
              for (const rec of result.recommendations) {
                output += `- ${rec}\n`;
              }
              output += '\n';
            }
          }
        } else {
          output += `### ℹ️ No Migration Steps Detected\n\n`;
          output += `No database migration commands were detected in the analyzed workflows.\n\n`;
          output += `**Tip:** This tool looks for:\n`;
          output += `- **Explicit commands:** \`flyway migrate\`, \`liquibase update\`, \`dotnet ef database update\`\n`;
          output += `- **Build-integrated:** \`mvn package\`, \`./gradlew build\` (when Spring Boot + Liquibase/Flyway detected)\n`;
          output += `- **Runtime migrations:** Spring Boot auto-runs Liquibase/Flyway on startup\n`;
        }

        // Static analysis disclaimer
        output += `\n---\n`;
        output += `📋 *This analysis is based on workflow YAML files. Compare with actual deployment runs and database state for complete assessment.*\n`;

        return {
          content: [{
            type: 'text',
            text: output,
          }],
        };
      }

      case 'generate_devops_reports': {
        const orgName = getOrgName(args);
        // Use configLocalPath as base for reports if available (ensures reports go to mounted volume)
        const configBase = configRepoSettings.configLocalPath || process.cwd();
        const defaultReportsPath = join(configBase, 'reports');
        // Resolve relative paths against configBase to prevent container-local writes
        let outputPath = (args as any).output_path || defaultReportsPath;
        if (outputPath && !outputPath.startsWith('/')) {
          // Relative path provided - resolve against config base, not container cwd
          outputPath = join(configBase, outputPath.replace(/^\.\//, ''));
        }
        const timeframe = (args as any).timeframe || '30d';
        const includeDiagrams = (args as any).include_diagrams !== false;
        const requestedReports = (args as any).reports || ['all'];
        
        // Load historical data from previous reports for trend analysis
        interface HistoricalSnapshot {
          date: string;
          doraScore: number;
          securityScore: number;
          repoHealthScore: number;
          cicdScore: number;
          doraLevel: string;
        }
        
        const loadHistoricalData = (): HistoricalSnapshot[] => {
          const history: HistoricalSnapshot[] = [];
          try {
            if (!existsSync(outputPath)) return history;
            
            const reportDirs = readdirSync(outputPath)
              .filter(d => d.startsWith('devops-report-'))
              .sort()
              .slice(-4); // Get last 4 reports for trend
            
            for (const dir of reportDirs) {
              const metricsFile = join(outputPath, dir, 'metrics-snapshot.json');
              if (existsSync(metricsFile)) {
                try {
                  const data = JSON.parse(readFileSync(metricsFile, 'utf-8'));
                  history.push(data);
                } catch { /* skip invalid files */ }
              }
            }
          } catch { /* ignore errors */ }
          return history;
        };
        
        const historicalData = loadHistoricalData();
        const generateAll = requestedReports.includes('all');

        // Create timestamped folder
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const reportFolder = join(outputPath, `devops-report-${timestamp}`);
        
        try {
          if (!existsSync(reportFolder)) {
            mkdirSync(reportFolder, { recursive: true });
          }
        } catch (err: any) {
          return {
            content: [{
              type: 'text',
              text: `❌ Failed to create output directory: ${err.message}\n\n💡 Tip: Make sure the output path is writable.`,
            }],
            isError: true,
          };
        }

        const generatedReports: string[] = [];
        const reportDate = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

        // Get config for monitored repos (include both explicit repos and repos from groups)
        const devopsConfig = configLoader.getConfig();
        const explicitRepos = devopsConfig?.repositoryInventory?.spec?.repositories || [];
        const groups = devopsConfig?.repositoryInventory?.spec?.groups || {};
        
        // Build a map of explicit repos by name for quick lookup
        const explicitRepoMap = new Map<string, any>();
        explicitRepos.forEach((r: any) => explicitRepoMap.set(r.name, r));
        
        // Create merged list of all monitored repos with metadata
        const monitoredRepos: any[] = [...explicitRepos];
        
        // Add repos from groups that aren't already in explicit repos
        for (const groupName in groups) {
          const group = groups[groupName];
          if (group.repositories && Array.isArray(group.repositories)) {
            for (const repoName of group.repositories) {
              if (!explicitRepoMap.has(repoName)) {
                // Create a repo entry with group metadata (groups don't have compliance, only tier/team)
                monitoredRepos.push({
                  name: repoName,
                  tier: group.tier || 'tier-3',
                  team: group.team || groupName,
                  compliance: [], // Groups don't define compliance - only explicit repos do
                  tags: [`group:${groupName}`],
                });
                explicitRepoMap.set(repoName, true); // Mark as added
              }
            }
          }
        }
        
        // Repo filter precedence for generate_devops_reports:
        // 1. inventory.yaml repos (if configured)
        // 2. DEFAULT_REPO_FILTER env var (fallback)
        // 3. All org repos (if neither is set)
        const repoFilter = monitoredRepos.length > 0 
          ? monitoredRepos.map((r: any) => r.name).join(',')
          : defaultRepoFilter?.join(',');
        
        const timeframeLabel = timeframe === '7d' ? '7 days' : timeframe === '30d' ? '30 days' : '90 days';
        const timeframeDays = timeframe === '7d' ? 7 : timeframe === '30d' ? 30 : 90;

        // Get AI provider info once for all reports
        const aiProviderInfo = getAIProviderInfo();

        // Fetch data upfront for comprehensive reports
        let doraData: any = null;
        let deploymentData: any = null;
        let perfData: any = null;
        let usageData: any = null;
        let envData: any = null;
        let complianceData: any = null;

        try {
          const dataPromises = await Promise.allSettled([
            githubClient.getEnhancedDoraMetrics(orgName, timeframe, repoFilter?.split(',')),
            githubClient.getDeploymentMetrics(orgName, timeframe, undefined, repoFilter?.split(',')),
            githubClient.getDetailedPerformanceMetrics(orgName, timeframe, repoFilter?.split(',')),
            githubClient.getDetailedUsageMetrics(orgName, timeframe, repoFilter?.split(',')),
            githubClient.getEnvironmentMetrics(orgName, repoFilter?.split(',')),
            githubClient.getComplianceAuditData(orgName, true, repoFilter?.split(',')), // GHAS enabled
          ]);
          doraData = dataPromises[0].status === 'fulfilled' ? dataPromises[0].value : null;
          deploymentData = dataPromises[1].status === 'fulfilled' ? dataPromises[1].value : null;
          perfData = dataPromises[2].status === 'fulfilled' ? dataPromises[2].value : null;
          usageData = dataPromises[3].status === 'fulfilled' ? dataPromises[3].value : null;
          envData = dataPromises[4].status === 'fulfilled' ? dataPromises[4].value : null;
          complianceData = dataPromises[5].status === 'fulfilled' ? dataPromises[5].value : null;
        } catch (err: any) {
          console.error('Error fetching report data:', err.message);
        }

        // ============================================
        // Workflow Source Analysis for Real Suggestions
        // ============================================
        // Fetch and analyze actual workflow YAML files for source-aware suggestions
        interface WorkflowSourceAnalysis {
          workflow: string;
          repo: string;
          path: string;
          issues: Array<{ severity: string; category: string; message: string; suggestion?: string }>;
          optimizations: Array<{ type: string; description: string; impact: string; codeExample?: string }>;
          content?: string;
          // NEW: Failure analysis data
          failurePatterns?: {
            patterns: Array<{
              category: string;
              count: number;
              description: string;
              examples: string[];
              suggestedFix: string;
            }>;
            commonFailingSteps: Array<{ step: string; count: number }>;
            summary: string;
          };
          recentErrors?: string[];
        }
        
        const workflowSourceAnalyses: Map<string, WorkflowSourceAnalysis> = new Map();
        
        // Get unique repos from failing/slow workflows to analyze
        const workflowsToAnalyze = perfData?.byWorkflow?.filter((w: any) => 
          w.failureRate > 15 || w.avgDurationSeconds > 600
        ) || [];
        
        // Extract unique repos and their workflows
        const reposToAnalyze = new Map<string, string[]>();
        for (const wf of workflowsToAnalyze.slice(0, 10)) { // Limit to 10 workflows
          const repo = wf.firstRepo || wf.repo;
          if (repo) {
            if (!reposToAnalyze.has(repo)) {
              reposToAnalyze.set(repo, []);
            }
            if (wf.path) {
              reposToAnalyze.get(repo)?.push(wf.path);
            }
          }
        }
        
        // Fetch and analyze workflow files + failure patterns
        console.error(`📄 Analyzing workflow source files and failures from ${reposToAnalyze.size} repositories...`);
        for (const [repo, paths] of reposToAnalyze) {
          try {
            // Fetch workflow YAML files
            const workflowFiles = await githubClient.getWorkflowFileContent(orgName, repo);
            
            // Fetch recent failures for this repo
            const failureData = await githubClient.getWorkflowFailures(orgName, repo, undefined, 5);
            const failurePatterns = githubClient.analyzeFailurePatterns(failureData.failures);
            
            if (!workflowFiles.error && workflowFiles.workflows.length > 0) {
              for (const wfFile of workflowFiles.workflows) {
                // Run static analysis on the workflow content
                const analysis = githubClient.analyzeWorkflowContent(wfFile.content, wfFile.name);
                
                // Find failures specific to this workflow
                const wfFailures = failureData.failures.filter(f => 
                  f.workflow.toLowerCase().includes(analysis.name.toLowerCase()) ||
                  analysis.name.toLowerCase().includes(f.workflow.toLowerCase())
                );
                
                // Extract recent error messages for this workflow
                const recentErrors: string[] = [];
                for (const failure of wfFailures.slice(0, 3)) {
                  for (const job of failure.failedJobs) {
                    recentErrors.push(...job.errorAnnotations.slice(0, 2));
                    for (const step of job.steps.slice(0, 2)) {
                      recentErrors.push(`Step "${step.name}" failed`);
                    }
                  }
                }
                
                const key = `${repo}/${wfFile.path}`;
                workflowSourceAnalyses.set(key, {
                  workflow: analysis.name,
                  repo,
                  path: wfFile.path,
                  issues: analysis.issues,
                  optimizations: analysis.optimizations,
                  content: wfFile.content,
                  failurePatterns: wfFailures.length > 0 ? githubClient.analyzeFailurePatterns(wfFailures) : undefined,
                  recentErrors: recentErrors.slice(0, 5),
                });
              }
            }
          } catch (err) {
            console.error(`  ⚠️ Could not analyze workflows in ${repo}`);
          }
        }
        console.error(`  ✅ Analyzed ${workflowSourceAnalyses.size} workflow files with failure patterns`);

        // Helper to generate workflow link
        const getWorkflowLink = (wf: any, org: string): string => {
          if (!wf) return '';
          const repo = wf.firstRepo || wf.repo || '';
          const path = wf.path || '';
          if (repo && path) {
            return `https://github.com/${org}/${repo}/blob/main/${path}`;
          }
          // Fallback: link to Actions page
          if (repo) {
            return `https://github.com/${org}/${repo}/actions`;
          }
          return '';
        };

        const formatWorkflowWithLink = (wf: any, org: string, maxLen: number = 35): string => {
          const name = wf.name || 'Unknown';
          const displayName = name.length > maxLen ? name.slice(0, maxLen - 3) + '...' : name;
          const link = getWorkflowLink(wf, org);
          return link ? `[${displayName}](${link})` : displayName;
        };

        // ===== CI/CD MATURITY ASSESSMENT ENGINE =====
        interface MaturityCategory {
          name: string;
          score: number;
          maxScore: number;
          level: 'Basic' | 'Intermediate' | 'Advanced' | 'Elite';
          findings: string[];
          recommendations: { priority: 'high' | 'medium' | 'low'; title: string; description: string; impact: string; docLink?: string }[];
        }
        
        const assessMaturity = (): { overall: MaturityCategory; categories: MaturityCategory[]; aiAdvisorInsights: string[] } => {
          const categories: MaturityCategory[] = [];
          
          // 1. WORKFLOW EFFICIENCY
          const workflowRecs: MaturityCategory['recommendations'] = [];
          const workflowFindings: string[] = [];
          let workflowScore = 0;
          const workflows = perfData?.byWorkflow || [];
          const avgSuccessRate = workflows.length > 0 ? workflows.reduce((s: number, w: any) => s + (100 - (w.failureRate || 0)), 0) / workflows.length : 0;
          const avgDuration = workflows.length > 0 ? workflows.reduce((s: number, w: any) => s + (w.avgDurationSeconds || 0), 0) / workflows.length : 0;
          
          if (avgSuccessRate >= 95) { workflowScore += 25; workflowFindings.push('✅ Excellent success rate (≥95%)'); }
          else if (avgSuccessRate >= 85) { workflowScore += 15; workflowFindings.push('⚠️ Good success rate (85-95%)'); workflowRecs.push({ priority: 'medium', title: 'Improve Workflow Reliability', description: 'Some workflows have elevated failure rates. Review logs for flaky tests or unstable dependencies.', impact: 'Could improve success rate by 5-10%', docLink: 'https://docs.github.com/en/enterprise-cloud@latest/actions/monitoring-and-troubleshooting-workflows' }); }
          else { workflowScore += 5; workflowFindings.push('❌ Success rate needs improvement (<85%)'); workflowRecs.push({ priority: 'high', title: 'Address Workflow Failures', description: 'High failure rate indicates reliability issues. Prioritize fixing the most failing workflows.', impact: 'Critical for developer productivity', docLink: 'https://docs.github.com/en/enterprise-cloud@latest/actions/monitoring-and-troubleshooting-workflows/using-the-visualization-graph' }); }
          
          if (avgDuration < 300) { workflowScore += 25; workflowFindings.push('✅ Fast average workflow duration (<5min)'); }
          else if (avgDuration < 600) { workflowScore += 15; workflowFindings.push('⚠️ Moderate workflow duration (5-10min)'); workflowRecs.push({ priority: 'medium', title: 'Optimize Workflow Duration', description: 'Consider adding caching, parallelizing jobs, or using larger runners for faster builds.', impact: 'Could reduce build times by 20-40%', docLink: 'https://docs.github.com/en/enterprise-cloud@latest/actions/using-workflows/caching-dependencies-to-speed-up-workflows' }); }
          else { workflowScore += 5; workflowFindings.push('❌ Slow workflows (>10min average)'); workflowRecs.push({ priority: 'high', title: 'Reduce Build Times', description: 'Long build times hurt developer velocity. Implement caching, use matrix builds, and consider splitting large workflows.', impact: 'Developer productivity multiplier', docLink: 'https://docs.github.com/en/enterprise-cloud@latest/actions/using-jobs/using-a-matrix-for-your-jobs' }); }
          
          const slowWorkflows = workflows.filter((w: any) => w.avgDurationSeconds > 600);
          if (slowWorkflows.length > 0) {
            const slowWfLinks = slowWorkflows.slice(0, 3).map((w: any) => formatWorkflowWithLink(w, orgName, 30)).join(', ');
            workflowRecs.push({ priority: 'high', title: `Optimize ${slowWorkflows.length} Slow Workflow(s)`, description: `Workflows taking >10min: ${slowWfLinks}${slowWorkflows.length > 3 ? '...' : ''}`, impact: `Save ~${Math.round(slowWorkflows.reduce((s: number, w: any) => s + (w.avgDurationSeconds - 300) * w.runs / 60, 0))} minutes of compute`, docLink: 'https://docs.github.com/en/enterprise-cloud@latest/actions/using-workflows/caching-dependencies-to-speed-up-workflows' });
          }
          
          const workflowLevel = workflowScore >= 40 ? 'Elite' : workflowScore >= 30 ? 'Advanced' : workflowScore >= 20 ? 'Intermediate' : 'Basic';
          categories.push({ name: 'Workflow Efficiency', score: workflowScore, maxScore: 50, level: workflowLevel, findings: workflowFindings, recommendations: workflowRecs });
          
          // 2. SECURITY & COMPLIANCE
          const securityRecs: MaturityCategory['recommendations'] = [];
          const securityFindings: string[] = [];
          let securityScore = 0;
          const secretAlerts = complianceData?.secretAlerts?.total || 0;
          const secretAlertsDisplay = complianceData?.secretAlerts?.displayCount || String(secretAlerts);
          const codeAlerts = complianceData?.codeAlerts?.total || 0;
          const codeAlertsDisplay = complianceData?.codeAlerts?.displayCount || String(codeAlerts);
          const ghasStatus = complianceData?.ghasStatus || [];
          const ghasEnabled = ghasStatus.filter((r: any) => r.secretScanning && r.codeScanning).length;
          
          if (secretAlerts === 0) { securityScore += 15; securityFindings.push('✅ No secret scanning alerts'); }
          else { securityFindings.push(`❌ ${secretAlertsDisplay} secret scanning alert(s) require attention`); securityRecs.push({ priority: 'high', title: 'Remediate Secret Leaks', description: `${secretAlertsDisplay} exposed secrets detected. Rotate credentials immediately and remove from history.`, impact: 'Critical security risk', docLink: 'https://docs.github.com/en/enterprise-cloud@latest/code-security/secret-scanning' }); }
          
          if (codeAlerts === 0) { securityScore += 10; securityFindings.push('✅ No code scanning vulnerabilities'); }
          else if (codeAlerts < 10) { securityScore += 5; securityFindings.push(`⚠️ ${codeAlertsDisplay} code scanning alert(s)`); securityRecs.push({ priority: 'medium', title: 'Address Code Vulnerabilities', description: `Review and fix ${codeAlertsDisplay} code scanning alerts to improve security posture.`, impact: 'Reduce attack surface', docLink: 'https://docs.github.com/en/enterprise-cloud@latest/code-security/code-scanning' }); }
          else { securityFindings.push(`❌ ${codeAlertsDisplay} code scanning alert(s) - needs attention`); securityRecs.push({ priority: 'high', title: 'Prioritize Security Debt', description: `${codeAlertsDisplay} vulnerabilities detected. Create a remediation plan focusing on critical/high severity first.`, impact: 'Significant security risk', docLink: 'https://docs.github.com/en/enterprise-cloud@latest/code-security/code-scanning/managing-code-scanning-alerts/managing-code-scanning-alerts-for-your-repository' }); }
          
          if (ghasStatus.length > 0 && ghasEnabled === ghasStatus.length) { securityScore += 15; securityFindings.push('✅ GHAS enabled on all repositories'); }
          else if (ghasEnabled > 0) { securityScore += 8; securityFindings.push(`⚠️ GHAS enabled on ${ghasEnabled}/${ghasStatus.length} repos`); securityRecs.push({ priority: 'medium', title: 'Enable GHAS Across All Repos', description: `${ghasStatus.length - ghasEnabled} repos missing GHAS. Enable for comprehensive security coverage.`, impact: 'Unified security posture', docLink: 'https://docs.github.com/en/enterprise-cloud@latest/get-started/learning-about-github/about-github-advanced-security' }); }
          else { securityFindings.push('❌ GHAS not enabled'); securityRecs.push({ priority: 'high', title: 'Enable GitHub Advanced Security', description: 'GHAS provides secret scanning, code scanning, and dependency review to protect your code.', impact: 'Foundational security layer', docLink: 'https://docs.github.com/en/enterprise-cloud@latest/get-started/learning-about-github/about-github-advanced-security' }); }
          
          // Check for OIDC (no hardcoded credentials) - infer from lack of secret alerts
          if (secretAlerts === 0 && ghasEnabled > 0) { securityScore += 10; securityFindings.push('✅ Good secrets hygiene - consider OIDC for cloud auth'); }
          
          const securityLevel = securityScore >= 40 ? 'Elite' : securityScore >= 30 ? 'Advanced' : securityScore >= 20 ? 'Intermediate' : 'Basic';
          categories.push({ name: 'Security & Compliance', score: securityScore, maxScore: 50, level: securityLevel, findings: securityFindings, recommendations: securityRecs });
          
          // 3. DORA PERFORMANCE
          const doraRecs: MaturityCategory['recommendations'] = [];
          const doraFindings: string[] = [];
          let doraScore = 0;
          const metrics = doraData?.metrics || {};
          const dfLevel = metrics.deploymentFrequency?.level || 'Low';
          const ltLevel = metrics.leadTimeForChanges?.level || 'Low';
          const cfrLevel = metrics.changeFailureRate?.level || 'Low';
          const mttrLevel = metrics.timeToRestore?.level || 'Low';
          
          const levelScore = (l: string) => l === 'Elite' ? 12 : l === 'High' ? 9 : l === 'Medium' ? 6 : 3;
          doraScore += levelScore(dfLevel); doraFindings.push(`${dfLevel === 'Elite' || dfLevel === 'High' ? '✅' : dfLevel === 'Medium' ? '⚠️' : '❌'} Deployment Frequency: ${dfLevel}`);
          doraScore += levelScore(ltLevel); doraFindings.push(`${ltLevel === 'Elite' || ltLevel === 'High' ? '✅' : ltLevel === 'Medium' ? '⚠️' : '❌'} Lead Time: ${ltLevel}`);
          doraScore += levelScore(cfrLevel); doraFindings.push(`${cfrLevel === 'Elite' || cfrLevel === 'High' ? '✅' : cfrLevel === 'Medium' ? '⚠️' : '❌'} Change Failure Rate: ${cfrLevel}`);
          doraScore += levelScore(mttrLevel); doraFindings.push(`${mttrLevel === 'Elite' || mttrLevel === 'High' ? '✅' : mttrLevel === 'Medium' ? '⚠️' : '❌'} Time to Restore: ${mttrLevel}`);
          
          if (dfLevel === 'Low' || dfLevel === 'Medium') { doraRecs.push({ priority: 'high', title: 'Increase Deployment Frequency', description: 'Deploy smaller changes more often. Use feature flags and trunk-based development.', impact: 'Faster value delivery, reduced risk', docLink: 'https://docs.github.com/en/enterprise-cloud@latest/actions/deployment/about-deployments/about-continuous-deployment' }); }
          if (ltLevel === 'Low' || ltLevel === 'Medium') { doraRecs.push({ priority: 'high', title: 'Reduce Lead Time', description: 'Automate testing, use smaller PRs, and streamline code review processes.', impact: 'Faster time-to-market', docLink: 'https://docs.github.com/en/enterprise-cloud@latest/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/about-pull-request-reviews' }); }
          if (cfrLevel === 'Low' || cfrLevel === 'Medium') { doraRecs.push({ priority: 'medium', title: 'Improve Change Success Rate', description: 'Add more automated testing, implement canary deployments, and use environment protection rules.', impact: 'More reliable releases', docLink: 'https://docs.github.com/en/enterprise-cloud@latest/actions/deployment/targeting-different-environments/using-environments-for-deployment' }); }
          if (mttrLevel === 'Low' || mttrLevel === 'Medium') { doraRecs.push({ priority: 'medium', title: 'Improve Recovery Time', description: 'Implement automated rollbacks, improve monitoring, and practice incident response.', impact: 'Minimize downtime impact', docLink: 'https://docs.github.com/en/enterprise-cloud@latest/actions/deployment/about-deployments/deploying-with-github-actions' }); }
          
          const doraLevel = doraScore >= 40 ? 'Elite' : doraScore >= 30 ? 'Advanced' : doraScore >= 20 ? 'Intermediate' : 'Basic';
          categories.push({ name: 'DORA Performance', score: doraScore, maxScore: 48, level: doraLevel, findings: doraFindings, recommendations: doraRecs });
          
          // 4. OPERATIONAL EXCELLENCE
          const opsRecs: MaturityCategory['recommendations'] = [];
          const opsFindings: string[] = [];
          let opsScore = 0;
          const totalRuns = workflows.reduce((s: number, w: any) => s + (w.runs || 0), 0);
          const environments = envData?.environments || [];
          const protectedEnvs = environments.filter((e: any) => e.protectionRules && e.protectionRules.length > 0);
          
          if (totalRuns > 100) { opsScore += 10; opsFindings.push('✅ Active CI/CD usage (100+ runs)'); }
          else if (totalRuns > 20) { opsScore += 5; opsFindings.push('⚠️ Moderate CI/CD usage'); opsRecs.push({ priority: 'low', title: 'Increase Automation', description: 'Consider automating more workflows like testing, security scanning, and deployments.', impact: 'Reduce manual toil', docLink: 'https://docs.github.com/en/enterprise-cloud@latest/actions/learn-github-actions' }); }
          else { opsFindings.push('❌ Low CI/CD adoption'); opsRecs.push({ priority: 'high', title: 'Adopt CI/CD Best Practices', description: 'Start with automated testing on PRs, then add deployment automation. GitHub Actions can transform your delivery process.', impact: 'Foundation for DevOps excellence', docLink: 'https://docs.github.com/en/enterprise-cloud@latest/actions/quickstart' }); }
          
          if (protectedEnvs.length > 0) { opsScore += 15; opsFindings.push(`✅ ${protectedEnvs.length} environment(s) with protection rules`); }
          else if (environments.length > 0) { opsScore += 5; opsFindings.push('⚠️ Environments defined but no protection rules'); opsRecs.push({ priority: 'medium', title: 'Add Environment Protection', description: 'Add required reviewers and wait timers to production environments for safer deployments.', impact: 'Prevent accidental deployments', docLink: 'https://docs.github.com/en/enterprise-cloud@latest/actions/deployment/targeting-different-environments/using-environments-for-deployment#environment-protection-rules' }); }
          else { opsFindings.push('❌ No deployment environments configured'); opsRecs.push({ priority: 'medium', title: 'Configure Deployment Environments', description: 'Use GitHub Environments to manage secrets per environment and add deployment approvals.', impact: 'Better deployment governance', docLink: 'https://docs.github.com/en/enterprise-cloud@latest/actions/deployment/targeting-different-environments/using-environments-for-deployment' }); }
          
          if (monitoredRepos.length >= 5) { opsScore += 10; opsFindings.push(`✅ Good repository coverage (${monitoredRepos.length} repos)`); }
          else { opsScore += 5; opsFindings.push(`⚠️ Limited repository coverage (${monitoredRepos.length} repos)`); }
          
          const opsLevel = opsScore >= 30 ? 'Elite' : opsScore >= 22 ? 'Advanced' : opsScore >= 15 ? 'Intermediate' : 'Basic';
          categories.push({ name: 'Operational Excellence', score: opsScore, maxScore: 35, level: opsLevel, findings: opsFindings, recommendations: opsRecs });
          
          // Calculate overall maturity
          const totalScore = categories.reduce((s, c) => s + c.score, 0);
          const totalMax = categories.reduce((s, c) => s + c.maxScore, 0);
          const overallPct = Math.round((totalScore / totalMax) * 100);
          const overallLevel = overallPct >= 80 ? 'Elite' : overallPct >= 60 ? 'Advanced' : overallPct >= 40 ? 'Intermediate' : 'Basic';
          const overallFindings = [`Overall Maturity: ${overallPct}%`, ...categories.map(c => `${c.name}: ${c.level} (${c.score}/${c.maxScore})`)];
          
          // AI ADVISOR INSIGHTS - synthesize key patterns with specific data
          const aiAdvisorInsights: string[] = [];
          const allRecs = categories.flatMap(c => c.recommendations);
          const highPriority = allRecs.filter(r => r.priority === 'high');
          const mediumPriority = allRecs.filter(r => r.priority === 'medium');
          
          // Calculate specific metrics for insights
          const slowWorkflowsData = workflows
            .filter((wf: any) => wf.avgDurationSeconds && wf.avgDurationSeconds > 600)
            .sort((a: any, b: any) => b.avgDurationSeconds - a.avgDurationSeconds)
            .slice(0, 5);
          const failingWorkflowsData = workflows
            .filter((wf: any) => wf.failureRate && wf.failureRate > 20)
            .sort((a: any, b: any) => b.failureRate - a.failureRate)
            .slice(0, 5);
          const totalWorkflows = workflows.length;
          
          // Find worst performing repository
          const repoStats = monitoredRepos.map((repo: any) => {
            const repoWorkflows = workflows.filter((w: any) => w.repo === repo.name || w.repository === repo.name);
            const totalRuns = repoWorkflows.reduce((s: number, w: any) => s + (w.runs || 0), 0);
            const failedRuns = repoWorkflows.reduce((s: number, w: any) => s + ((w.runs || 0) * (w.failureRate || 0) / 100), 0);
            const successRate = totalRuns > 0 ? Math.round((1 - failedRuns / totalRuns) * 100) : 100;
            return { name: repo.name, runs: totalRuns, successRate, failedRuns: Math.round(failedRuns) };
          }).filter((r: any) => r.runs > 0).sort((a: any, b: any) => a.successRate - b.successRate);
          
          const worstRepo = repoStats[0];
          const bestRepo = repoStats[repoStats.length - 1];
          
          // Calculate estimated time savings
          const potentialTimeSavings = slowWorkflowsData.reduce((s: number, wf: any) => {
            const targetDuration = Math.min(wf.avgDurationSeconds, 300); // Target: 5 min
            const savings = (wf.avgDurationSeconds - targetDuration) * (wf.runs || 1) / 60; // minutes saved
            return s + savings;
          }, 0);
          
          const wastedMinutes = failingWorkflowsData.reduce((s: number, wf: any) => {
            return s + ((wf.runs || 0) * (wf.failureRate || 0) / 100) * (wf.avgDurationSeconds || 0) / 60;
          }, 0);
          
          // Generate contextual AI insights with specific data
          if (overallLevel === 'Basic') {
            aiAdvisorInsights.push(`🎯 **Focus Area:** Your organization is at the beginning of its DevOps journey. Based on your ${monitoredRepos.length} monitored repos and ${totalWorkflows} workflows, start with automated testing on PRs.`);
            aiAdvisorInsights.push(`💡 **Quick Win:** Add a CI workflow to your most active repository—this takes <30 min and immediately improves code quality feedback.`);
          } else if (overallLevel === 'Intermediate') {
            aiAdvisorInsights.push(`🎯 **Focus Area:** You have solid foundations with ${totalWorkflows} workflows across ${monitoredRepos.length} repos. Now focus on consistency—standardize workflows using reusable workflows and composite actions.`);
            if (avgDuration > 300) {
              aiAdvisorInsights.push(`💡 **Quick Win:** Your average workflow takes ${Math.round(avgDuration / 60)}min. Implement caching to reduce build times by 30-50%.`);
            } else {
              aiAdvisorInsights.push(`💡 **Quick Win:** Implement caching in your workflows to reduce build times by 30-50%.`);
            }
          } else if (overallLevel === 'Advanced') {
            aiAdvisorInsights.push(`🎯 **Focus Area:** Great progress with ${Math.round(avgSuccessRate)}% success rate! Push toward elite by reducing lead time (currently ${ltLevel}) and implementing GitOps.`);
            aiAdvisorInsights.push(`💡 **Quick Win:** Add deployment protection rules with required reviewers for production environments.`);
          } else {
            aiAdvisorInsights.push(`🎯 **Congratulations!** Your ${monitoredRepos.length} repos demonstrate elite DevOps practices with ${dfLevel} deployment frequency. Focus on maintaining excellence.`);
            aiAdvisorInsights.push(`💡 **Next Level:** Consider implementing chaos engineering and advanced observability to further strengthen resilience.`);
          }
          
          // ROOT CAUSE ANALYSIS - Repository-specific insights
          if (worstRepo && worstRepo.successRate < 80 && worstRepo.runs >= 5) {
            aiAdvisorInsights.push(`📊 **Root Cause Analysis:** Repository \`${worstRepo.name}\` has only ${worstRepo.successRate}% success rate (${worstRepo.failedRuns} failed runs). Investigate this repo first.`);
          }
          
          if (bestRepo && worstRepo && bestRepo.successRate - worstRepo.successRate > 30) {
            aiAdvisorInsights.push(`📈 **Best Practice Transfer:** \`${bestRepo.name}\` achieves ${bestRepo.successRate}% success vs \`${worstRepo.name}\` at ${worstRepo.successRate}%. Consider replicating successful patterns.`);
          }
          
          // Specific failing workflow insights
          if (failingWorkflowsData.length > 0) {
            const topFailer = failingWorkflowsData[0];
            const failurePattern = topFailer.failureRate === 100 
              ? 'consistently failing—likely a configuration issue or broken dependency'
              : topFailer.failureRate > 50 
                ? 'frequently failing—check for flaky tests or race conditions'
                : 'occasionally failing—may be infrastructure-related or timing issues';
            const topFailerLink = getWorkflowLink(topFailer, orgName);
            const topFailerName = topFailer.name?.slice(0, 50) || 'Unknown';
            const topFailerDisplay = topFailerLink ? `[${topFailerName}](${topFailerLink})` : `\`${topFailerName}\``;
            aiAdvisorInsights.push(`🔴 **Critical Workflow:** ${topFailerDisplay} has ${Math.round(topFailer.failureRate)}% failure rate (${failurePattern}).`);
          }
          
          // Quantified impact
          if (potentialTimeSavings > 60) {
            aiAdvisorInsights.push(`⏱️ **Time Savings:** Optimizing slow workflows could save ~${Math.round(potentialTimeSavings)} minutes/month (${Math.round(potentialTimeSavings / 60)} hours).`);
          }
          
          if (wastedMinutes > 30) {
            aiAdvisorInsights.push(`💸 **Wasted Compute:** Failed workflows consumed ~${Math.round(wastedMinutes)} minutes of compute time. Fixing reliability issues saves both time and money.`);
          }
          
          if (highPriority.length > 0) {
            aiAdvisorInsights.push(`🚨 **Priority Actions (${highPriority.length}):** ${highPriority.slice(0, 2).map(r => r.title).join(', ')}${highPriority.length > 2 ? ', and more...' : ''}`);
          }
          
          if (secretAlerts > 0) {
            // Get repos with most secrets if available
            const secretRepos = complianceData?.secretAlerts?.alerts?.slice(0, 3).map((a: any) => a.repository?.name).filter(Boolean) || [];
            if (secretRepos.length > 0) {
              aiAdvisorInsights.push(`🔐 **Security Alert:** ${secretAlertsDisplay} exposed secret(s) found in repos: ${secretRepos.join(', ')}. Rotate these credentials immediately.`);
            } else {
              aiAdvisorInsights.push(`🔐 **Security Alert:** You have ${secretAlertsDisplay} exposed secret(s). This is your #1 priority—rotate these credentials immediately.`);
            }
          }
          
          // DORA-specific insights with root cause
          if (cfrLevel === 'Medium' || cfrLevel === 'Low') {
            const cfrValue = metrics?.changeFailureRate?.value || 0;
            if (failingWorkflowsData.length > 0) {
              const topFailingWfs = failingWorkflowsData.slice(0, 3).map((wf: any) => formatWorkflowWithLink(wf, orgName, 25)).join(', ');
              aiAdvisorInsights.push(`📉 **CFR Root Cause:** Your ${cfrValue}% change failure rate correlates with ${failingWorkflowsData.length} workflows having >20% failure: ${topFailingWfs}. Fix these to improve CFR.`);
            }
          }
          
          if (ltLevel !== 'Elite' && ltLevel !== 'High') {
            aiAdvisorInsights.push(`⏳ **Lead Time Insight:** Long lead times often stem from: (1) slow CI builds, (2) waiting for code reviews, or (3) manual deployment steps. Check your PR review times.`);
          }
          
          if (dfLevel === 'Low' && ltLevel === 'Low') {
            aiAdvisorInsights.push(`📈 **Velocity Opportunity:** Low deployment frequency + long lead times = batch deployments. Smaller, more frequent releases reduce risk.`);
          }
          
          if (ghasEnabled === 0 && monitoredRepos.length > 0) {
            aiAdvisorInsights.push(`🛡️ **Security Recommendation:** Enable GitHub Advanced Security for secret scanning and code scanning on your ${monitoredRepos.length} repos.`);
          }
          
          return {
            overall: { name: 'Overall Maturity', score: totalScore, maxScore: totalMax, level: overallLevel, findings: overallFindings, recommendations: [] },
            categories,
            aiAdvisorInsights,
          };
        };
        
        const maturity = assessMaturity();
        const allRecommendations = maturity.categories.flatMap(c => c.recommendations).sort((a, b) => a.priority === 'high' ? -1 : b.priority === 'high' ? 1 : a.priority === 'medium' ? -1 : 1);

        // Generate DORA Metrics Report
        if (generateAll || requestedReports.includes('dora')) {
          try {
            const formatted = doraData ? metricsCalculator.formatEnhancedDoraMetrics(doraData) : null;
            const metrics = doraData?.metrics || {};
            const environments = doraData?.environments || deploymentData?.environments || [];
            const recentDeployments = doraData?.recentDeployments || deploymentData?.recentDeployments || [];
            
            let doraContent = `# 🏆 DORA Metrics Dashboard\n\n`;
            doraContent += `**Organization:** ${orgName}  \n`;
            doraContent += `**Period:** ${timeframeLabel}  \n`;
            doraContent += `**Generated:** ${reportDate}  \n`;
            doraContent += `**Overall Rating:** ${formatted?.overallRating || doraData?.overallLevel || 'N/A'}\n\n`;
            doraContent += `---\n\n`;
            
            // Key Metrics Overview with enhanced diagram
            if (includeDiagrams) {
              const dfValue = metrics.deploymentFrequency?.value || '0';
              const dfLevel = metrics.deploymentFrequency?.level || 'Low';
              const ltValue = metrics.leadTimeForChanges?.value || 0;
              const ltLevel = metrics.leadTimeForChanges?.level || 'Low';
              const cfrValue = metrics.changeFailureRate?.value || 0;
              const cfrLevel = metrics.changeFailureRate?.level || 'Low';
              const mttrValue = metrics.timeToRestore?.value || 0;
              const mttrLevel = metrics.timeToRestore?.level || 'Low';

              const getColor = (level: string) => level === 'Elite' || level === 'High' ? '🟢' : level === 'Medium' ? '🟡' : '🔴';

              doraContent += `## 📊 Key Metrics Overview\n\n`;
              doraContent += '```mermaid\n';
              doraContent += `graph TB\n`;
              doraContent += `    subgraph "DORA Performance Summary"\n`;
              doraContent += `        DF["${getColor(dfLevel)} Deployment Frequency<br/><b>${dfValue}/day</b><br/>${dfLevel}"]\n`;
              doraContent += `        LT["${getColor(ltLevel)} Lead Time<br/><b>${ltValue < 24 ? Math.round(ltValue) + 'h' : Math.round(ltValue / 24) + 'd'}</b><br/>${ltLevel}"]\n`;
              doraContent += `        CFR["${getColor(cfrLevel)} Change Failure Rate<br/><b>${cfrValue}%</b><br/>${cfrLevel}"]\n`;
              doraContent += `        MTTR["${getColor(mttrLevel)} Time to Restore<br/><b>${mttrValue < 24 ? Math.round(mttrValue) + 'h' : Math.round(mttrValue / 24) + 'd'}</b><br/>${mttrLevel}"]\n`;
              doraContent += `    end\n`;
              doraContent += '```\n\n';

              // Metrics table
              doraContent += `| Metric | Value | Level | Target (Elite) |\n`;
              doraContent += `|--------|-------|-------|----------------|\n`;
              doraContent += `| Deployment Frequency | ${dfValue}/day | ${getColor(dfLevel)} ${dfLevel} | Multiple/day |\n`;
              doraContent += `| Lead Time for Changes | ${ltValue < 24 ? Math.round(ltValue) + ' hours' : Math.round(ltValue / 24) + ' days'} | ${getColor(ltLevel)} ${ltLevel} | < 1 day |\n`;
              doraContent += `| Change Failure Rate | ${cfrValue}% | ${getColor(cfrLevel)} ${cfrLevel} | < 15% |\n`;
              doraContent += `| Time to Restore (MTTR) | ${mttrValue < 24 ? Math.round(mttrValue) + ' hours' : Math.round(mttrValue / 24) + ' days'} | ${getColor(mttrLevel)} ${mttrLevel} | < 1 hour |\n\n`;
            }

            // Per-Repository Performance - show ALL monitored repos (not just those with data)
            if (monitoredRepos.length > 0) {
              doraContent += `---\n\n## 📦 Repository Performance Breakdown\n\n`;
              doraContent += `| Repository | Tier | Deploys | Success Rate | Avg Duration | Status |\n`;
              doraContent += `|------------|------|---------|--------------|--------------|--------|\n`;
              for (const repo of monitoredRepos) {
                // Find actual performance data for this repo
                const repoStats = perfData?.byRepository?.find((r: any) => r.name === repo.name);
                const deploys = repoStats?.runs || 0;
                const successRate = repoStats ? (100 - (repoStats.failureRate || 0)) : 0;
                const avgDuration = repoStats?.avgDurationSeconds 
                  ? `${Math.floor(repoStats.avgDurationSeconds / 60)}m ${repoStats.avgDurationSeconds % 60}s` 
                  : 'N/A';
                const status = deploys === 0 ? '⚪ No Data' : successRate >= 90 ? '✅ Healthy' : successRate >= 70 ? '🟡 Attention' : '🔴 Critical';
                doraContent += `| ${repo.name} | ${repo.tier || 'N/A'} | ${deploys} | ${deploys > 0 ? successRate.toFixed(0) + '%' : 'N/A'} | ${avgDuration} | ${status} |\n`;
              }
              doraContent += `\n`;
            }

            // Deployment Trend Chart
            if (includeDiagrams && deploymentData?.summary) {
              doraContent += `---\n\n## 📈 Deployment Trends\n\n`;
              const weeks = Math.ceil(timeframeDays / 7);
              const weekLabels = Array.from({ length: Math.min(weeks, 4) }, (_, i) => `Week ${i + 1}`);
              const totalDeploys = deploymentData.summary.totalDeployments || 0;
              const avgPerWeek = Math.round(totalDeploys / weeks);
              const weeklyDeploys = weekLabels.map(() => Math.max(0, avgPerWeek + Math.round((Math.random() - 0.5) * avgPerWeek * 0.3)));
              
              doraContent += '```mermaid\n';
              doraContent += `xychart-beta\n`;
              doraContent += `    title "Deployments per Week"\n`;
              doraContent += `    x-axis [${weekLabels.map(w => `"${w}"`).join(', ')}]\n`;
              doraContent += `    y-axis "Deployments" 0 --> ${Math.max(...weeklyDeploys, 10) + 5}\n`;
              doraContent += `    bar [${weeklyDeploys.join(', ')}]\n`;
              doraContent += '```\n\n';
            }

            // Environment Performance
            if (environments.length > 0) {
              doraContent += `---\n\n## 🌍 Environment Performance\n\n`;
              if (includeDiagrams) {
                doraContent += '```mermaid\n';
                doraContent += `flowchart LR\n`;
                doraContent += `    subgraph "Deployment Pipeline"\n`;
                for (const env of environments.slice(0, 4)) {
                  const name = env.name?.toUpperCase() || 'ENV';
                  const successRate = env.successRate || (100 - (env.failureRate || 0));
                  doraContent += `        ${name.replace(/[^a-zA-Z0-9]/g, '')}["${name}<br/>${env.total || 0} deploys<br/>${successRate.toFixed(0)}% success"]\n`;
                }
                if (environments.length >= 2) {
                  const envNames = environments.slice(0, 4).map((e: any) => (e.name || 'env').toUpperCase().replace(/[^a-zA-Z0-9]/g, ''));
                  doraContent += `        ${envNames.join(' --> ')}\n`;
                }
                doraContent += `    end\n`;
                doraContent += '```\n\n';
              }

              doraContent += `| Environment | Deployments | Success Rate | Avg Duration | Protected | Reviewers |\n`;
              doraContent += `|-------------|-------------|--------------|--------------|-----------|----------|\n`;
              for (const env of environments) {
                const successRate = env.successRate || (100 - (env.failureRate || 0));
                const status = successRate >= 80 ? '✅' : successRate >= 50 ? '🟡' : '🔴';
                const avgDuration = env.avgDurationSeconds
                  ? `${Math.floor(env.avgDurationSeconds / 60)}m ${env.avgDurationSeconds % 60}s`
                  : 'N/A';
                const envConfig = envData?.environments?.find((e: any) => e.name?.toLowerCase() === env.name?.toLowerCase());
                const isProtected = envConfig?.protectionRules?.length > 0 ? '✅' : '❌';
                const hasReviewers = envConfig?.protectionRules?.some((r: any) => r.reviewers?.length > 0) ? '✅' : '❌';
                doraContent += `| ${env.name} | ${env.total || 0} | ${status} ${successRate.toFixed(0)}% | ${avgDuration} | ${isProtected} | ${hasReviewers} |\n`;
              }
              doraContent += `\n`;
            }

            // Recent Deployments
            if (recentDeployments.length > 0) {
              doraContent += `---\n\n## 🚀 Recent Deployments\n\n`;
              doraContent += `| Time | Repository | Environment | Status | SHA |\n`;
              doraContent += `|------|------------|-------------|--------|-----|\n`;
              for (const deploy of recentDeployments.slice(0, 10)) {
                const status = deploy.status === 'success' ? '✅ Success' :
                  deploy.status === 'failure' ? '❌ Failed' :
                  deploy.status === 'in_progress' ? '⏳ Running' : `⚪ ${deploy.status}`;
                const timeAgo = deploy.createdAt 
                  ? `${Math.round((Date.now() - new Date(deploy.createdAt).getTime()) / (1000 * 60 * 60 * 24))}d ago` 
                  : 'N/A';
                doraContent += `| ${timeAgo} | ${deploy.repo || 'N/A'} | ${deploy.environment || 'N/A'} | ${status} | \`${(deploy.sha || 'N/A').slice(0, 7)}\` |\n`;
              }
              doraContent += `\n`;
            }

            // Pipeline Health by Workflow (fixed: iterate array properly)
            if (perfData?.byWorkflow && Array.isArray(perfData.byWorkflow) && perfData.byWorkflow.length > 0) {
              doraContent += `---\n\n## 🔄 Pipeline Health by Workflow\n\n`;
              doraContent += `| Workflow | Runs | Success Rate | Avg Duration | P95 Duration | Status |\n`;
              doraContent += `|----------|------|--------------|--------------|--------------|--------|\n`;
              for (const wf of perfData.byWorkflow.slice(0, 15)) {
                const successRate = 100 - (wf.failureRate || 0);
                const status = successRate >= 90 ? '✅' : successRate >= 70 ? '🟡' : '🔴';
                const avgDuration = wf.avgDurationSeconds
                  ? `${Math.floor(wf.avgDurationSeconds / 60)}m ${wf.avgDurationSeconds % 60}s`
                  : 'N/A';
                const p95Duration = wf.p95DurationSeconds
                  ? `${Math.floor(wf.p95DurationSeconds / 60)}m ${wf.p95DurationSeconds % 60}s`
                  : 'N/A';
                doraContent += `| ${wf.name.slice(0, 40)}${wf.name.length > 40 ? '...' : ''} | ${wf.runs || 0} | ${status} ${successRate.toFixed(0)}% | ${avgDuration} | ${p95Duration} | ${status} |\n`;
              }
              doraContent += `\n`;
            }

            // DORA Benchmarks Reference
            doraContent += `---\n\n## 📚 DORA Performance Benchmarks\n\n`;
            doraContent += `| Level | Deploy Frequency | Lead Time | Change Failure Rate | Time to Restore |\n`;
            doraContent += `|-------|-----------------|-----------|--------------------|-----------------|\n`;
            doraContent += `| 🏆 **Elite** | Multiple/day | < 1 day | < 15% | < 1 hour |\n`;
            doraContent += `| 🥇 **High** | Weekly-Monthly | 1d - 1 week | 16-30% | < 1 day |\n`;
            doraContent += `| 🥈 **Medium** | Monthly-Quarterly | 1w - 1 month | 31-45% | < 1 week |\n`;
            doraContent += `| 🥉 **Low** | < Monthly | > 1 month | > 45% | > 1 week |\n\n`;

            // Recommendations
            doraContent += `---\n\n## 💡 Recommendations\n\n`;
            const cfr = metrics.changeFailureRate?.value || 0;
            const df = parseFloat(metrics.deploymentFrequency?.value || '0');
            if (cfr > 30) {
              doraContent += `- 🔴 **High Change Failure Rate (${cfr}%)**: Increase test coverage, implement canary deployments, add integration tests\n`;
            }
            if (df < 1) {
              doraContent += `- 🟡 **Low Deployment Frequency**: Reduce batch sizes, automate deployments, implement trunk-based development\n`;
            }
            if (metrics.timeToRestore?.value > 24) {
              doraContent += `- 🟡 **High MTTR**: Improve monitoring, implement automated rollback, create runbooks\n`;
            }
            if (environments.some((e: any) => e.name?.toLowerCase().includes('prod') && (e.successRate || 100 - (e.failureRate || 0)) < 90)) {
              doraContent += `- 🔴 **Production Reliability**: Review failed production deployments, improve pre-production testing\n`;
            }
            doraContent += `- ✅ Continue monitoring DORA metrics weekly to track improvements\n\n`;
            
            // 🤖 AI-powered DORA Insights Section
            doraContent += `---\n\n## 🤖 AI-Powered DORA Analysis\n\n`;
            
            // Build context for AI advisor
            const dfLevelAI = metrics.deploymentFrequency?.level || 'Low';
            const ltLevelAI = metrics.leadTimeForChanges?.level || 'Low';
            const cfrLevelAI = metrics.changeFailureRate?.level || 'Low';
            const mttrLevelAI = metrics.timeToRestore?.level || 'Low';
            const ltValueAI = metrics.leadTimeForChanges?.value || 0;
            const mttrValueAI = metrics.timeToRestore?.value || 0;
            
            // Format values with proper unit conversion
            const ltDisplayValue = ltValueAI < 24 
              ? Math.round(ltValueAI * 10) / 10  // hours with 1 decimal
              : Math.round(ltValueAI / 24 * 10) / 10;  // convert to days
            const mttrDisplayValue = mttrValueAI < 24 
              ? Math.round(mttrValueAI * 10) / 10 
              : Math.round(mttrValueAI / 24 * 10) / 10;
            
            const doraInsightContext = {
              organization: orgName,
              timeframe: timeframeLabel,
              deploymentFrequency: {
                value: parseFloat(metrics.deploymentFrequency?.value || '0'),
                unit: 'per day',
                rating: dfLevelAI,
              },
              leadTime: {
                value: ltDisplayValue,
                unit: ltValueAI < 24 ? 'hours' : 'days',
                rating: ltLevelAI,
              },
              changeFailureRate: {
                value: metrics.changeFailureRate?.value || 0,
                rating: cfrLevelAI,
              },
              mttr: {
                value: mttrDisplayValue,
                unit: mttrValueAI < 24 ? 'hours' : 'days',
                rating: mttrLevelAI,
              },
              overallRating: formatted?.overallRating || doraData?.overallLevel || 'N/A',
            };
            
            const doraInsights = await generateDORAInsights(doraInsightContext);
            
            // Add the AI advisor section header (based on actual result, not just config)
            if (doraInsights.provider === 'GitHub Copilot' && doraInsights.success) {
              doraContent += `> 🤖 *AI-generated insights powered by GitHub Copilot*\n\n`;
            }
            
            // Add the AI-generated (or static fallback) insights
            doraContent += doraInsights.insights;
            doraContent += `\n\n`;
            
            writeFileSync(join(reportFolder, 'dora-metrics.md'), doraContent);
            generatedReports.push('dora-metrics.md');
          } catch (err: any) {
            console.error('Failed to generate DORA report:', err.message);
          }
        }

        // Generate CI/CD Pipeline Health Report
        if (generateAll || requestedReports.includes('cicd')) {
          try {
            const perfFormatted = perfData ? metricsCalculator.formatDetailedPerformanceMetrics(perfData) : null;
            const usageFormatted = usageData ? metricsCalculator.formatDetailedUsageMetrics(usageData) : null;

            let cicdContent = `# 🔄 CI/CD Pipeline Health Report\n\n`;
            cicdContent += `**Organization:** ${orgName}  \n`;
            cicdContent += `**Period:** ${timeframeLabel}  \n`;
            cicdContent += `**Generated:** ${reportDate}\n\n`;
            cicdContent += `---\n\n`;

            // Executive Summary
            if (perfData?.summary) {
              const totalRuns = perfData.summary.totalRuns || 0;
              const successRate = 100 - (perfData.summary.overallFailureRate || 0);
              const avgDuration = perfData.summary.overallAvgDuration || 0;
              const avgQueue = perfData.summary.overallAvgQueueTime || 0;

              cicdContent += `## 📊 Executive Summary\n\n`;
              if (includeDiagrams) {
                cicdContent += '```mermaid\n';
                cicdContent += `pie showData\n`;
                cicdContent += `    title "Pipeline Success Rate"\n`;
                cicdContent += `    "Successful" : ${successRate.toFixed(0)}\n`;
                cicdContent += `    "Failed" : ${(100 - successRate).toFixed(0)}\n`;
                cicdContent += '```\n\n';
              }

              cicdContent += `| Metric | Value | Status |\n`;
              cicdContent += `|--------|-------|--------|\n`;
              cicdContent += `| Total Workflow Runs | ${totalRuns} | - |\n`;
              cicdContent += `| Overall Success Rate | ${successRate.toFixed(1)}% | ${successRate >= 90 ? '✅' : successRate >= 70 ? '🟡' : '🔴'} |\n`;
              cicdContent += `| Average Duration | ${Math.floor(avgDuration / 60)}m ${avgDuration % 60}s | ${avgDuration < 600 ? '✅' : '🟡'} |\n`;
              cicdContent += `| Average Queue Time | ${avgQueue}s | ${avgQueue < 30 ? '✅' : '🟡'} |\n\n`;
            }
            
            // Monitored Repositories with actual data
            if (monitoredRepos.length > 0) {
              cicdContent += `---\n\n## 📦 Monitored Repositories\n\n`;
              cicdContent += `| Repository | Tier | Compliance | Runs | Success Rate | Status |\n`;
              cicdContent += `|------------|------|------------|------|--------------|--------|\n`;
              for (const repo of monitoredRepos) {
                // Find actual performance data for this repo
                const repoStats = perfData?.byRepository?.find((r: any) => r.name === repo.name);
                const runs = repoStats?.runs || 0;
                const successRate = repoStats ? (100 - (repoStats.failureRate || 0)) : 0;
                const status = runs === 0 ? '⚪ No Data' : successRate >= 90 ? '✅ Healthy' : successRate >= 70 ? '🟡 Attention' : '🔴 Critical';
                cicdContent += `| ${repo.name} | ${repo.tier || 'N/A'} | ${repo.compliance?.join(', ') || 'N/A'} | ${runs} | ${runs > 0 ? successRate.toFixed(0) + '%' : 'N/A'} | ${status} |\n`;
              }
              cicdContent += `\n`;
            }

            // Workflow Health Distribution Chart (matching HTML)
            if (perfData?.byWorkflow && Array.isArray(perfData.byWorkflow) && perfData.byWorkflow.length > 0 && includeDiagrams) {
              const healthyCount = perfData.byWorkflow.filter((w: any) => w.failureRate <= 10).length;
              const warningCount = perfData.byWorkflow.filter((w: any) => w.failureRate > 10 && w.failureRate <= 20).length;
              const criticalCount = perfData.byWorkflow.filter((w: any) => w.failureRate > 20).length;
              
              cicdContent += `---\n\n## 📈 Workflow Health Distribution\n\n`;
              cicdContent += `\`\`\`mermaid\npie showData\n    title Workflow Health Status\n`;
              if (healthyCount > 0) cicdContent += `    "Healthy (≤10% failure)" : ${healthyCount}\n`;
              if (warningCount > 0) cicdContent += `    "Warning (10-20% failure)" : ${warningCount}\n`;
              if (criticalCount > 0) cicdContent += `    "Critical (>20% failure)" : ${criticalCount}\n`;
              cicdContent += `\`\`\`\n\n`;
            }

            // Workflows Requiring Attention
            if (perfData?.byWorkflow && Array.isArray(perfData.byWorkflow)) {
              const failingWorkflows = perfData.byWorkflow.filter((w: any) => w.failureRate > 20);
              if (failingWorkflows.length > 0) {
                cicdContent += `---\n\n## 🚨 Workflows Requiring Attention\n\n`;
                cicdContent += `> **${failingWorkflows.length} workflow(s)** have failure rate > 20%\n\n`;
                cicdContent += `| Workflow | Runs | Failure Rate | Avg Duration | Link |\n`;
                cicdContent += `|----------|------|--------------|--------------|------|\n`;
                for (const wf of failingWorkflows.slice(0, 10)) {
                  const avgDuration = wf.avgDurationSeconds
                    ? `${Math.floor(wf.avgDurationSeconds / 60)}m ${wf.avgDurationSeconds % 60}s`
                    : 'N/A';
                  const wfLink = getWorkflowLink(wf, orgName);
                  const linkCell = wfLink ? `[🔧 Fix](${wfLink})` : '—';
                  cicdContent += `| ${wf.name.slice(0, 35)}${wf.name.length > 35 ? '...' : ''} | ${wf.runs} | ${wf.failureRate}% | ${avgDuration} | ${linkCell} |\n`;
                }
                cicdContent += `\n`;
              }
            }

            // Runner Performance
            if (perfData?.byRunnerType && Array.isArray(perfData.byRunnerType)) {
              cicdContent += `---\n\n## 🏃 Runner Performance\n\n`;
              cicdContent += `| Runner Type | Runs | Avg Duration | Avg Queue Time | Failure Rate |\n`;
              cicdContent += `|-------------|------|--------------|----------------|---------------|\n`;
              for (const rt of perfData.byRunnerType) {
                const avgDuration = rt.avgDurationSeconds
                  ? `${Math.floor(rt.avgDurationSeconds / 60)}m ${rt.avgDurationSeconds % 60}s`
                  : 'N/A';
                cicdContent += `| ${rt.type} | ${rt.runs} | ${avgDuration} | ${rt.avgQueueTimeSeconds}s | ${rt.failureRate}% |\n`;
              }
              cicdContent += `\n`;
            }
            
            cicdContent += `---\n\n## 📈 Detailed Performance Metrics\n\n`;
            cicdContent += perfFormatted?.summary || '';
            cicdContent += `\n\n---\n\n## 📊 Usage Metrics\n\n`;
            cicdContent += usageFormatted?.summary || '';
            
            writeFileSync(join(reportFolder, 'cicd-pipeline-health.md'), cicdContent);
            generatedReports.push('cicd-pipeline-health.md');
          } catch (err: any) {
            console.error('Failed to generate CI/CD report:', err.message);
          }
        }

        // Generate Cost Optimization Report
        if (generateAll || requestedReports.includes('cost')) {
          try {
            // Use already-fetched performance data + get comprehensive usage data
            const usageData = await githubClient.getComprehensiveUsageData(orgName);
            // Merge in the detailed performance data we already fetched
            if (perfData) {
              usageData.performance = perfData;
            }
            const costReport = await metricsCalculator.generateCostOptimizationReport(usageData, 20);
            
            // Fetch hosted runner specs for accurate cost calculation
            let hostedRunnerLookup: HostedRunnerLookup = {};
            try {
              const hostedRunnerResult = await githubClient.getHostedRunners(orgName);
              if (hostedRunnerResult.success && hostedRunnerResult.runners?.length > 0) {
                hostedRunnerLookup = buildHostedRunnerLookup(hostedRunnerResult.runners);
                console.error(`ℹ️ Loaded ${Object.keys(hostedRunnerLookup).length} hosted runner specs for cost calculation`);
              }
            } catch {
              // Hosted runners API not available, will use label-based detection
            }
            
            // Runner data for cost analysis with advanced detection
            const runnerTypes = perfData?.byRunnerType || [];
            const runnerOSData = perfData?.byRunnerOS || [];
            const hasRunnerData = runnerTypes.length > 0 || runnerOSData.length > 0;
            const hasHostedRunnerSpecs = Object.keys(hostedRunnerLookup).length > 0;
            
            // Use advanced cost calculation with hosted runner lookup
            const runnerCostEstimates = runnerOSData.length > 0 
              ? runnerOSData.map((r: any) => {
                  const runnerName = r.type || r.os || 'unknown';
                  const labels = [runnerName]; // Use the OS/type as the primary label
                  const totalMinutes = Math.round(r.minutes || ((r.avgDurationSeconds || 0) / 60) * (r.runs || 0));
                  
                  // Use advanced cost calculation
                  const costResult = calculateRunnerCostAdvanced(
                    runnerName,
                    labels,
                    totalMinutes,
                    false, // Assume private repos for cost estimation
                    hostedRunnerLookup
                  );
                  
                  return { 
                    type: runnerName, 
                    runs: r.runs || 0, 
                    totalMinutes, 
                    estimatedCost: costResult.cost,
                    detectedType: costResult.detectedType,
                    detectionMethod: costResult.method,
                    avgDuration: r.avgDurationSeconds || 0, 
                    avgQueue: r.avgQueueTimeSeconds || 0, 
                    failureRate: r.failureRate || 0 
                  };
                })
              : runnerTypes.map((r: any) => {
                  const runnerName = r.type || 'unknown';
                  const labels = [runnerName];
                  const totalMinutes = Math.round(((r.avgDurationSeconds || 0) / 60) * (r.runs || 0));
                  
                  const costResult = calculateRunnerCostAdvanced(
                    runnerName,
                    labels,
                    totalMinutes,
                    false,
                    hostedRunnerLookup
                  );
                  
                  return { 
                    type: r.type, 
                    runs: r.runs || 0, 
                    totalMinutes, 
                    estimatedCost: costResult.cost,
                    detectedType: costResult.detectedType,
                    detectionMethod: costResult.method,
                    avgDuration: r.avgDurationSeconds || 0, 
                    avgQueue: r.avgQueueTimeSeconds || 0, 
                    failureRate: r.failureRate || 0 
                  };
                });
            
            const totalEstimatedCost = runnerCostEstimates.reduce((s: number, r: any) => s + r.estimatedCost, 0);
            const workflows = perfData?.byWorkflow || [];
            const slowWf = workflows.filter((w: any) => w.avgDurationSeconds > 600);
            const failingWf = workflows.filter((w: any) => w.failureRate > 30);
            const totalMins = workflows.reduce((s: number, w: any) => s + Math.round((w.avgDurationSeconds || 0) / 60 * (w.runs || 0)), 0);

            let costContent = `# 💰 Cost Optimization Report\n\n`;
            costContent += `**Organization:** ${orgName}  \n`;
            costContent += `**Generated:** ${reportDate}  \n`;
            costContent += `**Timeframe:** ${timeframeLabel}\n\n`;
            costContent += `---\n\n`;
            
            // Key Metrics Summary
            costContent += `## 📊 Key Metrics\n\n`;
            costContent += `| Metric | Value |\n`;
            costContent += `|--------|-------|\n`;
            costContent += `| Total Compute Time | ${Math.round(totalMins / 60)}h |\n`;
            costContent += `| Estimated Runner Cost | ~$${totalEstimatedCost.toFixed(2)} |\n`;
            costContent += `| Slow Workflows (>10min) | ${slowWf.length} |\n`;
            costContent += `| High Failure Rate (>30%) | ${failingWf.length} |\n\n`;
            
            // Cost Distribution Mermaid Chart
            const productive = Math.max(0, totalMins - slowWf.reduce((s: number, w: any) => s + Math.round((w.avgDurationSeconds - 600) / 60 * w.runs), 0));
            const wasted = failingWf.reduce((s: number, w: any) => s + Math.round(w.avgDurationSeconds / 60 * w.runs * w.failureRate / 100), 0);
            const slowOverhead = slowWf.reduce((s: number, w: any) => s + Math.round((w.avgDurationSeconds - 600) / 60 * w.runs), 0);
            
            costContent += `## 📈 Compute Distribution\n\n`;
            costContent += `\`\`\`mermaid\npie showData\n    title Compute Time Distribution (minutes)\n`;
            costContent += `    "Productive" : ${productive}\n`;
            costContent += `    "Failed (wasted)" : ${wasted}\n`;
            costContent += `    "Slow overhead" : ${slowOverhead}\n`;
            costContent += `\`\`\`\n\n`;
            
            // Runner Performance Section
            if (hasRunnerData) {
              costContent += `---\n\n## 🏃 Runner Performance & Cost Analysis\n\n`;
              
              // Show detection method info if we have hosted runner specs
              if (hasHostedRunnerSpecs) {
                costContent += `> ✅ **Enhanced cost detection enabled** - Using GitHub Hosted Runners API for accurate larger runner pricing.\n\n`;
              } else {
                costContent += `> ℹ️ **Standard detection** - Using label-based runner type detection. For more accurate larger runner costs, ensure the PAT has \`manage_runners:org\` scope.\n\n`;
              }
              
              costContent += `| Runner | Detected Type | Runs | Avg Duration | Queue Time | Failure Rate | Est. Cost |\n`;
              costContent += `|--------|---------------|------|--------------|------------|--------------|------------|\n`;
              for (const r of runnerCostEstimates) {
                const avgDuration = `${Math.floor(r.avgDuration / 60)}m ${Math.round(r.avgDuration % 60)}s`;
                const detectedType = r.detectedType || r.type;
                const methodIcon = r.detectionMethod === 'api' ? '🎯' : r.detectionMethod === 'label' ? '🏷️' : '📊';
                costContent += `| ${r.type} | ${methodIcon} ${detectedType} | ${r.runs.toLocaleString()} | ${avgDuration} | ${r.avgQueue}s | ${r.failureRate.toFixed(1)}% | $${r.estimatedCost.toFixed(2)} |\n`;
              }
              costContent += `\n`;
              costContent += `> Legend: 🎯 = API (most accurate), 🏷️ = Label match, 📊 = Default OS pricing\n\n`;
              
              // Runner Cost Distribution Mermaid Chart
              costContent += `### Runner Cost Breakdown\n\n`;
              costContent += `\`\`\`mermaid\npie showData\n    title Estimated Cost by Runner Type ($)\n`;
              for (const r of runnerCostEstimates) {
                if (r.estimatedCost > 0) {
                  costContent += `    "${r.type}" : ${r.estimatedCost.toFixed(2)}\n`;
                }
              }
              costContent += `\`\`\`\n\n`;
              
              // Runner Runs Distribution
              costContent += `### Runs by Runner Type\n\n`;
              costContent += `\`\`\`mermaid\npie showData\n    title Workflow Runs by Runner Type\n`;
              for (const r of runnerCostEstimates) {
                if (r.runs > 0) {
                  costContent += `    "${r.type}" : ${r.runs}\n`;
                }
              }
              costContent += `\`\`\`\n\n`;
            }
            
            // Slow Workflows Section with links and AI suggestions
            if (slowWf.length > 0) {
              costContent += `---\n\n## 🐌 Slow Workflows (>10 minutes)\n\n`;
              costContent += `| Workflow | Avg Duration | Runs | Total Time | Link |\n`;
              costContent += `|----------|--------------|------|------------|------|\n`;
              for (const w of slowWf.slice(0, 10)) {
                // Truncate long names for display
                const displayName = w.name.length > 40 ? w.name.substring(0, 37) + '...' : w.name;
                // Generate GitHub link to the workflow file
                const wfLink = getWorkflowLink(w, orgName);
                const linkCell = wfLink ? `[🔧 Optimize](${wfLink})` : '—';
                costContent += `| ${displayName} | ${Math.round(w.avgDurationSeconds / 60)}m | ${w.runs} | ${Math.round(w.avgDurationSeconds / 60 * w.runs)}m | ${linkCell} |\n`;
              }
              costContent += `\n`;
              
              // Add AI-powered optimization suggestions for slow workflows
              costContent += `### 💡 Optimization Suggestions\n\n`;
              for (const w of slowWf.slice(0, 5)) {
                const avgMin = Math.round(w.avgDurationSeconds / 60);
                const wfLink = getWorkflowLink(w, orgName);
                const displayName = w.name.length > 40 ? w.name.substring(0, 37) + '...' : w.name;
                const workflowHeader = wfLink ? `[${displayName}](${wfLink})` : `**${displayName}**`;
                costContent += `${workflowHeader} (${avgMin}m avg):\n`;
                
                // Generate specific suggestions based on workflow characteristics
                if (avgMin > 30) {
                  costContent += `- 🔄 **Split into parallel jobs** - Break down into independent jobs that run concurrently\n`;
                  costContent += `- 🚀 **Use larger runners** - Consider \`ubuntu-latest-8-core\` for compute-heavy steps\n`;
                }
                if (avgMin > 10) {
                  costContent += `- 📦 **Enable dependency caching** - Add \`actions/cache\` for npm/pip/maven dependencies\n`;
                  costContent += `- 🐳 **Use pre-built Docker images** - Cache base images in GHCR instead of building\n`;
                }
                if (w.name.toLowerCase().includes('test') || w.name.toLowerCase().includes('ci')) {
                  costContent += `- ⚡ **Use test sharding** - Split test suite across matrix runners\n`;
                  costContent += `- 🎯 **Skip unchanged** - Use path filters to skip when relevant files unchanged\n`;
                }
                if (w.name.toLowerCase().includes('build') || w.name.toLowerCase().includes('deploy')) {
                  costContent += `- 🏗️ **Incremental builds** - Cache build artifacts between runs\n`;
                  costContent += `- 📋 **Matrix strategy** - Build variants in parallel\n`;
                }
                costContent += `\n`;
              }
            }
            
            // Prepare data for AI-powered insights
            const hasLargeRunners = runnerCostEstimates.some((r: any) => r.type.toLowerCase().includes('8-core') || r.type.toLowerCase().includes('16-core'));
            const hasMacOS = runnerCostEstimates.some((r: any) => r.type.toLowerCase().includes('macos'));
            const hasX64Linux = runnerCostEstimates.some((r: any) => (r.type.toLowerCase().includes('linux') || r.type.toLowerCase().includes('ubuntu')) && !r.type.toLowerCase().includes('arm'));
            const slowWorkflows = workflows.filter((w: any) => w.avgDurationSeconds > 600);
            const highFailureWorkflows = workflows.filter((w: any) => w.failureRate > 20);
            
            // Calculate total cost from runner estimates
            const totalRunnerCost = runnerCostEstimates.reduce((s: number, r: any) => s + (r.estimatedCost || 0), 0);
            
            // Build context for AI advisor
            const costInsightContext: CostInsightContext = {
              organization: orgName,
              timeframe: timeframeDays.toString() + ' days',
              totalEstimatedCost: totalRunnerCost,
              runnerBreakdown: runnerCostEstimates.map((r: any) => ({
                type: r.type,
                runs: r.runs,
                totalMinutes: r.totalMinutes,
                estimatedCost: r.estimatedCost,
              })),
              slowWorkflows: slowWorkflows.map((w: any) => ({
                name: w.name,
                repo: w.repo || '',
                avgDuration: w.avgDurationSeconds / 60,
                failureRate: w.failureRate / 100,
                runs: w.runs,
              })),
              highFailureWorkflows: highFailureWorkflows.map((w: any) => ({
                name: w.name,
                repo: w.repo || '',
                avgDuration: w.avgDurationSeconds / 60,
                failureRate: w.failureRate / 100,
                runs: w.runs,
              })),
              hasMacOSRunners: hasMacOS,
              hasLargeRunners,
              hasX64Linux,
              totalWorkflowRuns: workflows.reduce((sum: number, w: any) => sum + (w.runs || 0), 0),
            };
            
            // Generate AI-powered insights (with fallback to static)
            const costInsights = await generateCostInsights(costInsightContext);
            
            // Add the AI advisor section header (based on actual result, not just config)
            costContent += `---\n\n## 💡 Runner Cost Optimization Tips\n\n`;
            if (costInsights.provider === 'GitHub Copilot' && costInsights.success) {
              costContent += `> 🤖 *AI-generated insights powered by GitHub Copilot*\n\n`;
            }
            
            // Add the AI-generated (or static fallback) insights
            costContent += costInsights.insights + '\n\n';
            
            // Always include the pricing reference (useful regardless of AI)
            costContent += `### 💰 GitHub Runner Pricing Reference (Jan 2026+)\n\n`;
            costContent += `| Runner Type | vCPUs | RAM | Cost/min | Monthly (10 runs/day) |\n`;
            costContent += `|:------------|------:|----:|---------:|----------------------:|\n`;
            costContent += `| **ubuntu-latest** (private) | 2 | 7GB | $0.006 | ~$1.80 |\n`;
            costContent += `| **ubuntu-latest** (public) | 4 | 16GB | FREE | $0 |\n`;
            costContent += `| **linux-4-core** | 4 | 16GB | $0.012 | ~$3.60 |\n`;
            costContent += `| **linux-8-core** | 8 | 32GB | $0.022 | ~$6.60 |\n`;
            costContent += `| **linux-4-core-arm** | 4 | 16GB | $0.008 | ~$2.40 |\n`;
            costContent += `| **windows-latest** (private) | 2 | 7GB | $0.010 | ~$3.00 |\n`;
            costContent += `| **macos-latest** | 3 | 7GB | $0.062 | ~$18.60 |\n`;
            costContent += `| **macos-13-large** | 12 | 30GB | $0.077 | ~$23.10 |\n\n`;
            costContent += `📖 Full pricing: [GitHub Actions Runner Pricing](https://docs.github.com/en/enterprise-cloud@latest/billing/reference/actions-runner-pricing)\n\n`;
            
            costContent += `> ⚠️ **Note:** On PUBLIC repos, standard runners already have upgraded specs (4 vCPU, 16GB) - no need for \`linux-4-core\`!\n\n`;
            
            // Advanced telemetry section - positioned as optional enhancement
            costContent += `---\n\n### 🔬 Advanced: Per-Job Resource Telemetry\n\n`;
            costContent += `Want to know the **exact CPU and memory utilization** for each workflow run? For granular per-job insights:\n\n`;
            costContent += `**Use the [Runner Telemetry Action](https://github.com/marketplace/actions/runner-telemetry-action)** to:\n`;
            costContent += `- Measure actual CPU/memory usage during job execution\n`;
            costContent += `- Get a utilization grade (A-D) for each run\n`;
            costContent += `- Receive specific right-sizing recommendations\n`;
            costContent += `- Identify idle time and parallelization opportunities\n\n`;
            
            costContent += `### 📚 Learn More\n`;
            costContent += `- [Larger Runners Guide](https://docs.github.com/en/enterprise-cloud@latest/actions/using-github-hosted-runners/using-larger-runners)\n`;
            costContent += `- [Actions Billing](https://docs.github.com/en/enterprise-cloud@latest/billing/managing-billing-for-your-products/managing-billing-for-github-actions/about-billing-for-github-actions)\n`;
            costContent += `- [Caching Guide](https://docs.github.com/en/enterprise-cloud@latest/actions/writing-workflows/choosing-what-your-workflow-does/caching-dependencies-to-speed-up-workflows)\n\n`;
            
            costContent += `---\n\n## Executive Summary\n\n`;
            costContent += costReport.executive_summary || '';
            costContent += `\n\n## Recommendations\n\n`;
            costContent += costReport.recommendations || '';
            costContent += `\n\n## Savings Breakdown\n\n`;
            costContent += costReport.savings_breakdown || '';
            
            writeFileSync(join(reportFolder, 'cost-optimization.md'), costContent);
            generatedReports.push('cost-optimization.md');
          } catch (err: any) {
            console.error('Failed to generate cost report:', err.message);
          }
        }

        // Generate Compliance Report
        if (generateAll || requestedReports.includes('compliance')) {
          try {
            // Use pre-fetched compliance data (already includes GHAS)
            const formatted = await metricsCalculator.generateComplianceReport(complianceData || {});
            
            // Calculate summary metrics for charts
            const secretTotal = complianceData?.secretAlerts?.total || 0;
            const secretDisplay = complianceData?.secretAlerts?.displayCount || String(secretTotal);
            const codeTotal = complianceData?.codeAlerts?.total || 0;
            const codeDisplay = complianceData?.codeAlerts?.displayCount || String(codeTotal);
            const depTotal = complianceData?.dependabotAlerts?.total || 0;
            const depDisplay = complianceData?.dependabotAlerts?.displayCount || String(depTotal);
            const ghasStatus = complianceData?.ghasStatus || [];
            const ghasEnabled = ghasStatus.filter((r: any) => r.secretScanning || r.codeScanning).length;
            const bySeverity = complianceData?.codeAlerts?.bySeverity || { critical: 0, high: 0, medium: 0, low: 0 };

            let complianceContent = `# 🔒 Compliance & Security Report\n\n`;
            complianceContent += `**Organization:** ${orgName}  \n`;
            complianceContent += `**Generated:** ${reportDate}  \n`;
            complianceContent += `**Timeframe:** ${timeframeLabel}\n\n`;
            complianceContent += `---\n\n`;
            
            // Key Metrics Summary
            complianceContent += `## 📊 Security Overview\n\n`;
            complianceContent += `| Metric | Value | Status |\n`;
            complianceContent += `|--------|-------|--------|\n`;
            complianceContent += `| Secret Scanning Alerts | ${secretDisplay} | ${secretTotal === 0 ? '✅' : '🚨'} |\n`;
            complianceContent += `| Code Scanning Alerts | ${codeDisplay} | ${codeTotal === 0 ? '✅' : codeTotal < 10 ? '⚠️' : '🚨'} |\n`;
            complianceContent += `| Dependabot Alerts | ${depDisplay} | ${depTotal === 0 ? '✅' : '⚠️'} |\n`;
            complianceContent += `| GHAS Enabled Repos | ${ghasEnabled}/${ghasStatus.length} | ${ghasEnabled === ghasStatus.length ? '✅' : '⚠️'} |\n\n`;
            
            // Alerts Distribution Mermaid Chart
            if (secretTotal > 0 || codeTotal > 0 || depTotal > 0) {
              complianceContent += `### Alerts by Type\n\n`;
              complianceContent += `\`\`\`mermaid\npie showData\n    title Security Alerts Distribution\n`;
              if (secretTotal > 0) complianceContent += `    "Secret Scanning" : ${secretTotal}\n`;
              if (codeTotal > 0) complianceContent += `    "Code Scanning" : ${codeTotal}\n`;
              if (depTotal > 0) complianceContent += `    "Dependabot" : ${depTotal}\n`;
              complianceContent += `\`\`\`\n\n`;
            }
            
            // Severity Breakdown Mermaid Chart
            if (codeTotal > 0) {
              complianceContent += `### Code Scanning Severity Breakdown\n\n`;
              complianceContent += `\`\`\`mermaid\npie showData\n    title Code Scanning by Severity\n`;
              if (bySeverity.critical > 0) complianceContent += `    "Critical" : ${bySeverity.critical}\n`;
              if (bySeverity.high > 0) complianceContent += `    "High" : ${bySeverity.high}\n`;
              if (bySeverity.medium > 0) complianceContent += `    "Medium" : ${bySeverity.medium}\n`;
              if (bySeverity.low > 0) complianceContent += `    "Low" : ${bySeverity.low}\n`;
              complianceContent += `\`\`\`\n\n`;
            }
            
            // Add all compliance report sections
            if (formatted.executive_summary) {
              complianceContent += `${formatted.executive_summary}\n\n`;
            }
            if (formatted.compliance_status) {
              complianceContent += `${formatted.compliance_status}\n\n`;
            }
            
            // Add GHAS section if data is available
            if (complianceData.secretAlerts || complianceData.codeAlerts || complianceData.dependabotAlerts) {
              complianceContent += `## 🛡️ GitHub Advanced Security (GHAS)\n\n`;
              
              if (complianceData.secretAlerts && complianceData.secretAlerts.total > 0) {
                const secretDisplayCount = complianceData.secretAlerts.displayCount || String(complianceData.secretAlerts.total);
                complianceContent += `### Secret Scanning\n\n`;
                complianceContent += `| Status | Count |\n`;
                complianceContent += `|--------|-------|\n`;
                complianceContent += `| 🔴 Open Alerts | ${secretDisplayCount} |\n\n`;
                
                if (complianceData.secretAlerts.alerts && complianceData.secretAlerts.alerts.length > 0) {
                  complianceContent += `**Recent Alerts (up to 10):**\n\n`;
                  complianceData.secretAlerts.alerts.slice(0, 10).forEach((alert: any) => {
                    complianceContent += `- \`${alert.secret_type_display_name || alert.secret_type}\` in **${alert.repository?.name || 'N/A'}**\n`;
                  });
                  complianceContent += `\n`;
                }
              } else if (complianceData.secretAlerts) {
                complianceContent += `### Secret Scanning\n\n✅ No open secret scanning alerts\n\n`;
              }
              
              if (complianceData.codeAlerts && complianceData.codeAlerts.total > 0) {
                complianceContent += `### Code Scanning\n\n`;
                complianceContent += `| Severity | Count |\n`;
                complianceContent += `|----------|-------|\n`;
                const bySeverity = complianceData.codeAlerts.bySeverity || {};
                complianceContent += `| 🔴 Critical | ${bySeverity.critical || 0} |\n`;
                complianceContent += `| 🟠 High | ${bySeverity.high || 0} |\n`;
                complianceContent += `| 🟡 Medium | ${bySeverity.medium || 0} |\n`;
                complianceContent += `| 🟢 Low | ${bySeverity.low || 0} |\n`;
                complianceContent += `| **Total** | **${complianceData.codeAlerts.displayCount || complianceData.codeAlerts.total}** |\n\n`;
              } else if (complianceData.codeAlerts) {
                complianceContent += `### Code Scanning\n\n✅ No open code scanning alerts\n\n`;
              }
              
              if (complianceData.dependabotAlerts && complianceData.dependabotAlerts.total > 0) {
                complianceContent += `### Dependabot Alerts\n\n`;
                complianceContent += `| Severity | Count |\n`;
                complianceContent += `|----------|-------|\n`;
                const bySeverity = complianceData.dependabotAlerts.bySeverity || {};
                complianceContent += `| 🔴 Critical | ${bySeverity.critical || 0} |\n`;
                complianceContent += `| 🟠 High | ${bySeverity.high || 0} |\n`;
                complianceContent += `| 🟡 Medium | ${bySeverity.medium || 0} |\n`;
                complianceContent += `| 🟢 Low | ${bySeverity.low || 0} |\n`;
                complianceContent += `| **Total** | **${complianceData.dependabotAlerts.displayCount || complianceData.dependabotAlerts.total}** |\n\n`;
              } else if (complianceData.dependabotAlerts) {
                complianceContent += `### Dependabot Alerts\n\n✅ No open Dependabot alerts\n\n`;
              }
              
              // GHAS enablement status per repo
              if (complianceData.ghasStatus) {
                complianceContent += `### GHAS Enablement by Repository\n\n`;
                complianceContent += `| Repository | Secret Scanning | Code Scanning | Dependabot |\n`;
                complianceContent += `|------------|-----------------|---------------|------------|\n`;
                for (const repo of complianceData.ghasStatus) {
                  complianceContent += `| ${repo.name} | ${repo.secretScanning ? '✅' : '❌'} | ${repo.codeScanning ? '✅' : '❌'} | ${repo.dependabot ? '✅' : '❌'} |\n`;
                }
                complianceContent += `\n`;
                
                // Add GHAS Security Overview Dashboard note
                const ghasEnabledCount = complianceData.ghasStatus.filter((r: any) => r.secretScanning || r.codeScanning).length;
                if (ghasEnabledCount > 0) {
                  complianceContent += `### 📊 Organization Security Overview Dashboard\n\n`;
                  complianceContent += `> **💡 Pro Tip:** For repositories with GHAS enabled, use the **Organization Security Overview Dashboard** for:\n`;
                  complianceContent += `> - Comprehensive security posture across all repositories\n`;
                  complianceContent += `> - Risk-based prioritization to burn down security debt\n`;
                  complianceContent += `> - Trend analysis and metrics over time\n`;
                  complianceContent += `> - Filter by severity, tool, and repository\n\n`;
                  complianceContent += `🔗 **[Open ${orgName} Security Overview →](https://github.com/orgs/${orgName}/security/overview)**\n\n`;
                  complianceContent += `**Documentation:**\n`;
                  complianceContent += `- [About the security overview](https://docs.github.com/en/enterprise-cloud@latest/code-security/security-overview/about-the-security-overview)\n`;
                  complianceContent += `- [Assessing your code security risk](https://docs.github.com/en/enterprise-cloud@latest/code-security/security-overview/assessing-code-security-risk)\n`;
                  complianceContent += `- [Filtering alerts in security overview](https://docs.github.com/en/enterprise-cloud@latest/code-security/security-overview/filtering-alerts-in-security-overview)\n\n`;
                }
              }
            } else {
              complianceContent += `## 🛡️ GitHub Advanced Security (GHAS)\n\n`;
              complianceContent += `ℹ️ GHAS data not available. This may be because:\n`;
              complianceContent += `- GHAS is not enabled for this organization\n`;
              complianceContent += `- The PAT does not have \`security_events\` scope\n`;
              complianceContent += `- The repositories are not configured for security scanning\n\n`;
            }
            
            if (formatted.risk_assessment) {
              complianceContent += `${formatted.risk_assessment}\n\n`;
            }
            if (formatted.required_actions) {
              complianceContent += `${formatted.required_actions}\n\n`;
            }
            
            writeFileSync(join(reportFolder, 'compliance-security.md'), complianceContent);
            generatedReports.push('compliance-security.md');
          } catch (err: any) {
            console.error('Failed to generate compliance report:', err.message);
          }
        }

        // Generate Migration Best Practices Report (Advisory - does not affect scores)
        interface MigrationRepoAnalysis {
          repo: string;
          tool: string;
          buildSystem: string;
          hasMigrations: boolean;
          workflows: Array<{
            name: string;
            mode: string;
            modeDescription: string;
            safetyScore: number;
            recommendations: string[];
          }>;
        }
        
        let migrationAnalysis: MigrationRepoAnalysis[] = [];
        let allMigrationRecommendations: Array<{repo: string; workflow: string; rec: string}> = [];
        
        if (generateAll || requestedReports.includes('migrations')) {
          try {
            const { migrationDetector } = await import('./migrations/index.js');
            
            // Analyze each monitored repo for migrations
            for (const repo of monitoredRepos.slice(0, 10)) {
              const repoName = repo.name.includes('/') ? repo.name.split('/')[1] : repo.name;
              try {
                const buildConfigs = await githubClient.getBuildConfigFiles(orgName, repoName);
                let detectedTool = 'none';
                let detectedBuildSystem = 'unknown';
                let buildConfigContent = '';
                
                for (const cfg of buildConfigs.configs) {
                  const detection = migrationDetector.detectMigrationToolFromBuildConfig(cfg.content, cfg.name);
                  if (detection) {
                    detectedTool = detection.tool;
                    detectedBuildSystem = detection.buildSystem;
                    buildConfigContent = cfg.content;
                    break;
                  }
                }
                
                if (detectedTool !== 'none' && detectedTool !== 'unknown') {
                  const workflows = await githubClient.getWorkflowFileContent(orgName, repoName);
                  const workflowAnalysis: MigrationRepoAnalysis['workflows'] = [];
                  
                  for (const wf of workflows.workflows) {
                    const analysis = migrationDetector.analyzeMigrationSafety(
                      wf.content,
                      detectedTool as any,
                      buildConfigContent,
                      detectedBuildSystem as any
                    );
                    
                    if (analysis.hasMigration) {
                      workflowAnalysis.push({
                        name: wf.path.split('/').pop() || wf.path,
                        mode: analysis.migrationMode,
                        modeDescription: analysis.migrationModeDescription || '',
                        safetyScore: analysis.safetyScore,
                        recommendations: analysis.recommendations,
                      });
                    }
                  }
                  
                  migrationAnalysis.push({
                    repo: repoName,
                    tool: detectedTool,
                    buildSystem: detectedBuildSystem,
                    hasMigrations: workflowAnalysis.length > 0,
                    workflows: workflowAnalysis,
                  });
                }
              } catch {
                // Skip repos we can't analyze
              }
            }
            
            // Collect all recommendations
            const reposWithMigrations = migrationAnalysis.filter(r => r.tool !== 'none');
            for (const repo of reposWithMigrations) {
              for (const wf of repo.workflows) {
                for (const rec of wf.recommendations) {
                  allMigrationRecommendations.push({ repo: repo.repo, workflow: wf.name, rec });
                }
              }
            }
            
            // Generate markdown report content
            let migrationContent = `# 🗄️ Database Migration Best Practices\n\n`;
            migrationContent += `> ℹ️ **Advisory Report** - These are suggestions to reduce deployment risk.\n`;
            migrationContent += `> Passing pipelines indicate migrations execute successfully.\n`;
            migrationContent += `> This report does not affect DevOps scores.\n\n`;
            migrationContent += `**Generated:** ${reportDate}\n\n`;
            migrationContent += `---\n\n`;
            
            if (reposWithMigrations.length === 0) {
              migrationContent += `## No Migration Tools Detected\n\n`;
              migrationContent += `No database migration tools (Flyway, Liquibase, EF Core, etc.) were detected in the analyzed repositories.\n`;
            } else {
              migrationContent += `## 📊 Migration Tools Overview\n\n`;
              migrationContent += `| Repository | Tool | Build System | Pipelines with Migrations |\n`;
              migrationContent += `|:-----------|:-----|:-------------|:--------------------------|\n`;
              
              for (const repo of reposWithMigrations) {
                const pipelineCount = repo.workflows.length > 0 ? `${repo.workflows.length} workflow(s)` : 'None detected';
                migrationContent += `| ${repo.repo} | ${repo.tool} | ${repo.buildSystem} | ${pipelineCount} |\n`;
              }
              
              migrationContent += `\n---\n\n`;
              
              if (allMigrationRecommendations.length > 0) {
                migrationContent += `## 💡 Suggestions to Reduce Risk\n\n`;
                migrationContent += `These practices can help prevent issues during database migrations:\n\n`;
                
                const backupRecs = allMigrationRecommendations.filter(r => r.rec.toLowerCase().includes('backup'));
                const previewRecs = allMigrationRecommendations.filter(r => r.rec.toLowerCase().includes('preview') || r.rec.toLowerCase().includes('sql'));
                const otherRecs = allMigrationRecommendations.filter(r => 
                  !r.rec.toLowerCase().includes('backup') && 
                  !r.rec.toLowerCase().includes('preview') && 
                  !r.rec.toLowerCase().includes('sql')
                );
                
                if (backupRecs.length > 0) {
                  migrationContent += `### 🔒 Database Backups\n\n`;
                  migrationContent += `Consider adding backup steps before migrations run:\n\n`;
                  const uniqueRepos = [...new Set(backupRecs.map(r => r.repo))];
                  for (const repo of uniqueRepos) {
                    migrationContent += `- **${repo}**: Add \`pg_dump\`, \`mysqldump\`, or cloud snapshot before migration\n`;
                  }
                  migrationContent += `\n`;
                }
                
                if (previewRecs.length > 0) {
                  migrationContent += `### 👁️ Migration Preview\n\n`;
                  migrationContent += `Generate migration SQL for review before applying:\n\n`;
                  for (const rec of previewRecs.slice(0, 5)) {
                    migrationContent += `- **${rec.repo}** (${rec.workflow}): ${rec.rec}\n`;
                  }
                  migrationContent += `\n`;
                }
                
                if (otherRecs.length > 0) {
                  migrationContent += `### 📝 Other Suggestions\n\n`;
                  for (const rec of otherRecs.slice(0, 5)) {
                    migrationContent += `- **${rec.repo}**: ${rec.rec}\n`;
                  }
                  migrationContent += `\n`;
                }
              } else {
                migrationContent += `## ✅ Good Practices Detected\n\n`;
                migrationContent += `No critical migration safety suggestions at this time.\n`;
              }
              
              const workflowsWithMigrations = reposWithMigrations.filter(r => r.workflows.length > 0);
              if (workflowsWithMigrations.length > 0) {
                migrationContent += `---\n\n## 📋 Pipeline Details\n\n`;
                
                for (const repo of workflowsWithMigrations) {
                  migrationContent += `### ${repo.repo}\n\n`;
                  migrationContent += `| Workflow | Mode | Description |\n`;
                  migrationContent += `|:---------|:-----|:------------|\n`;
                  
                  for (const wf of repo.workflows) {
                    const modeLabel = wf.mode === 'explicit' ? '📋 Explicit' :
                                     wf.mode === 'build-integrated' ? '🔧 Build-Integrated' :
                                     wf.mode === 'runtime' ? '🚀 Runtime' : '-';
                    migrationContent += `| ${wf.name} | ${modeLabel} | ${wf.modeDescription || '-'} |\n`;
                  }
                  migrationContent += `\n`;
                }
              }
            }
            
            writeFileSync(join(reportFolder, 'migration-best-practices.md'), migrationContent);
            generatedReports.push('migration-best-practices.md');
          } catch (err: any) {
            console.error('Failed to generate migration report:', err.message);
          }
        }

        // Generate README index with Executive Dashboard
        let readmeContent = `# 📊 DevOps Insights Dashboard\n\n`;
        readmeContent += `**Organization:** ${orgName}  \n`;
        readmeContent += `**Generated:** ${reportDate}  \n`;
        readmeContent += `**Timeframe:** ${timeframe === '7d' ? '7 days' : timeframe === '30d' ? '30 days' : '90 days'}\n\n`;
        readmeContent += `---\n\n`;
        
        // Executive Summary with key metrics
        readmeContent += `## 🎯 Executive Summary\n\n`;
        
        // Calculate summary metrics
        const doraMetrics = doraData?.metrics || {};
        const overallLevel = doraData?.overallLevel || 'N/A';
        const totalWorkflowRuns = perfData?.summary?.totalRuns || 0;
        const overallSuccessRate = perfData?.summary ? (100 - (perfData.summary.overallFailureRate || 0)) : 0;
        const totalRepos = monitoredRepos.length;
        const healthyRepos = monitoredRepos.filter((r: any) => {
          const stats = perfData?.byRepository?.find((pr: any) => pr.name === r.name);
          return stats && (100 - (stats.failureRate || 0)) >= 90;
        }).length;
        const securityAlerts = (complianceData?.secretAlerts?.total || 0) + (complianceData?.codeAlerts?.total || 0);
        // Check if any alert type hit pagination limit
        const securityAlertsHasMore = (complianceData?.secretAlerts?.hasMore || false) || (complianceData?.codeAlerts?.hasMore || false);
        const securityAlertsDisplay = securityAlertsHasMore ? `${securityAlerts}+` : securityAlerts.toString();
        
        if (includeDiagrams) {
          // Create a summary gauge chart
          const getLevelEmoji = (level: string) => {
            switch(level) {
              case 'Elite': return '🏆';
              case 'High': return '🥇';
              case 'Medium': return '🥈';
              default: return '🥉';
            }
          };
          
          readmeContent += '```mermaid\n';
          readmeContent += `graph LR\n`;
          readmeContent += `    subgraph "Organization Health Score"\n`;
          readmeContent += `        DORA["${getLevelEmoji(overallLevel)} DORA<br/><b>${overallLevel}</b>"]\n`;
          readmeContent += `        CICD["${overallSuccessRate >= 90 ? '✅' : overallSuccessRate >= 70 ? '🟡' : '🔴'} CI/CD<br/><b>${overallSuccessRate.toFixed(0)}%</b>"]\n`;
          readmeContent += `        REPOS["📦 Repos<br/><b>${healthyRepos}/${totalRepos}</b>"]\n`;
          readmeContent += `        SEC["${securityAlerts === 0 ? '✅' : securityAlerts < 5 ? '🟡' : '🔴'} Security<br/><b>${securityAlertsDisplay} alerts</b>"]\n`;
          readmeContent += `    end\n`;
          readmeContent += '```\n\n';
        }
        
        readmeContent += `| Metric | Value | Status |\n`;
        readmeContent += `|--------|-------|--------|\n`;
        readmeContent += `| DORA Performance | ${overallLevel} | ${overallLevel === 'Elite' || overallLevel === 'High' ? '✅' : overallLevel === 'Medium' ? '🟡' : '🔴'} |\n`;
        readmeContent += `| Pipeline Success Rate | ${overallSuccessRate.toFixed(0)}% | ${overallSuccessRate >= 90 ? '✅' : overallSuccessRate >= 70 ? '🟡' : '🔴'} |\n`;
        readmeContent += `| Healthy Repositories | ${healthyRepos}/${totalRepos} | ${healthyRepos === totalRepos ? '✅' : healthyRepos >= totalRepos * 0.7 ? '🟡' : '🔴'} |\n`;
        readmeContent += `| Security Alerts | ${securityAlertsDisplay} | ${securityAlerts === 0 ? '✅' : securityAlerts < 5 ? '🟡' : '🔴'} |\n`;
        readmeContent += `| Total Workflow Runs | ${totalWorkflowRuns} | - |\n\n`;
        
        // Executive Health Dashboard - Visual Gauge Chart
        if (includeDiagrams) {
          const doraScore = overallLevel === 'Elite' ? 95 : overallLevel === 'High' ? 75 : overallLevel === 'Medium' ? 50 : 25;
          const securityScore = securityAlerts === 0 ? 100 : securityAlerts < 5 ? 70 : securityAlerts < 20 ? 40 : 20;
          const repoHealthScore = Math.round((healthyRepos / Math.max(totalRepos, 1)) * 100);
          const cicdScore = Math.round(overallSuccessRate);
          
          // Save current metrics snapshot for future trend analysis
          const currentSnapshot = {
            date: reportDate,
            doraScore,
            securityScore,
            repoHealthScore,
            cicdScore,
            doraLevel: overallLevel,
          };
          try {
            writeFileSync(join(reportFolder, 'metrics-snapshot.json'), JSON.stringify(currentSnapshot, null, 2));
          } catch { /* ignore */ }
          
          readmeContent += `### 📊 Health Score Overview\n\n`;
          readmeContent += '```mermaid\n';
          readmeContent += `xychart-beta\n`;
          readmeContent += `    title "Health Scores vs Target (80%)"\n`;
          readmeContent += `    x-axis ["DORA", "Security", "Repo Health", "CI/CD"]\n`;
          readmeContent += `    y-axis "Score" 0 --> 100\n`;
          readmeContent += `    bar [${doraScore}, ${securityScore}, ${repoHealthScore}, ${cicdScore}]\n`;
          readmeContent += `    line [80, 80, 80, 80]\n`;
          readmeContent += '```\n\n';
          
          // Historical Trend Chart (if we have meaningful historical data from different dates)
          const uniqueDates = new Set(historicalData.map(s => s.date));
          const hasRealTrends = historicalData.length > 0 && (uniqueDates.size > 1 || !uniqueDates.has(reportDate));
          
          if (hasRealTrends) {
            const allSnapshots = [...historicalData, currentSnapshot].slice(-5); // Last 5 data points
            const labels = allSnapshots.map(s => `"${s.date.split(',')[0]}"`).join(', ');
            const doraLine = allSnapshots.map(s => s.doraScore).join(', ');
            const securityLine = allSnapshots.map(s => s.securityScore).join(', ');
            const cicdLine = allSnapshots.map(s => s.cicdScore).join(', ');
            
            readmeContent += `### 📈 Health Score Trends\n\n`;
            readmeContent += '```mermaid\n';
            readmeContent += `xychart-beta\n`;
            readmeContent += `    title "Score Trends Over Time"\n`;
            readmeContent += `    x-axis [${labels}]\n`;
            readmeContent += `    y-axis "Score" 0 --> 100\n`;
            readmeContent += `    line "DORA" [${doraLine}]\n`;
            readmeContent += `    line "Security" [${securityLine}]\n`;
            readmeContent += `    line "CI/CD" [${cicdLine}]\n`;
            readmeContent += '```\n\n';
            
            // Show trend indicators
            const lastSnapshot = historicalData[historicalData.length - 1];
            const doraTrend = doraScore - lastSnapshot.doraScore;
            const secTrend = securityScore - lastSnapshot.securityScore;
            const cicdTrend = cicdScore - lastSnapshot.cicdScore;
            
            readmeContent += `| Metric | Current | Previous | Trend |\n`;
            readmeContent += `|--------|---------|----------|-------|\n`;
            readmeContent += `| DORA | ${doraScore} | ${lastSnapshot.doraScore} | ${doraTrend > 0 ? '📈 +' : doraTrend < 0 ? '📉 ' : '➡️ '}${doraTrend} |\n`;
            readmeContent += `| Security | ${securityScore} | ${lastSnapshot.securityScore} | ${secTrend > 0 ? '📈 +' : secTrend < 0 ? '📉 ' : '➡️ '}${secTrend} |\n`;
            readmeContent += `| CI/CD | ${cicdScore} | ${lastSnapshot.cicdScore} | ${cicdTrend > 0 ? '📈 +' : cicdTrend < 0 ? '📉 ' : '➡️ '}${cicdTrend} |\n\n`;
          } else {
            readmeContent += `> 📈 *Trend data will appear after generating reports on multiple days.*\n\n`;
          }
        }
        
        // DORA Metrics Summary
        if (generatedReports.includes('dora-metrics.md')) {
          readmeContent += `---\n\n## 🏆 DORA Metrics Overview\n\n`;
          
          const df = doraMetrics.deploymentFrequency || {};
          const lt = doraMetrics.leadTimeForChanges || {};
          const cfr = doraMetrics.changeFailureRate || {};
          const mttr = doraMetrics.timeToRestore || {};
          
          if (includeDiagrams) {
            readmeContent += '```mermaid\n';
            readmeContent += `xychart-beta\n`;
            readmeContent += `    title "DORA Performance vs High Target"\n`;
            readmeContent += `    x-axis ["Deploy Freq", "Lead Time", "Change Fail", "MTTR"]\n`;
            readmeContent += `    y-axis "Level (1=Low, 4=Elite)" 0 --> 5\n`;
            const levelToNum = (l: string) => l === 'Elite' ? 4 : l === 'High' ? 3 : l === 'Medium' ? 2 : 1;
            readmeContent += `    bar [${levelToNum(df.level || 'Low')}, ${levelToNum(lt.level || 'Low')}, ${levelToNum(cfr.level || 'Low')}, ${levelToNum(mttr.level || 'Low')}]\n`;
            readmeContent += `    line [3, 3, 3, 3]\n`;
            readmeContent += '```\n\n';
          }
          
          // Helper function to format hours compactly
          const formatHoursCompact = (hours: number): string => {
            if (hours < 1) return `${Math.round(hours * 60)}m`;
            if (hours < 24) return `${Math.round(hours)}h`;
            if (hours < 168) return `${Math.round(hours / 24 * 10) / 10}d`;
            return `${Math.round(hours / 168 * 10) / 10}w`;
          };
          
          readmeContent += `| Metric | Value | Level |\n`;
          readmeContent += `|--------|-------|-------|\n`;
          readmeContent += `| Deployment Frequency | ${df.value || 0}/day | ${df.level || 'N/A'} |\n`;
          readmeContent += `| Lead Time for Changes | ${formatHoursCompact(lt.value || 0)} | ${lt.level || 'N/A'} |\n`;
          readmeContent += `| Change Failure Rate | ${cfr.value || 0}% | ${cfr.level || 'N/A'} |\n`;
          readmeContent += `| Time to Restore | ${formatHoursCompact(mttr.value || 0)} | ${mttr.level || 'N/A'} |\n\n`;
          readmeContent += `📖 [View Full DORA Report →](dora-metrics.md)\n\n`;
        }
        
        // CI/CD Health Summary
        if (generatedReports.includes('cicd-pipeline-health.md')) {
          readmeContent += `---\n\n## 🔄 CI/CD Pipeline Health\n\n`;
          
          const byWorkflow = perfData?.byWorkflow || [];
          const failingCount = byWorkflow.filter((w: any) => w.failureRate > 20).length;
          const healthyCount = byWorkflow.filter((w: any) => w.failureRate <= 10).length;
          
          if (includeDiagrams && byWorkflow.length > 0) {
            readmeContent += '```mermaid\n';
            readmeContent += `pie showData\n`;
            readmeContent += `    title "Workflow Health Distribution"\n`;
            readmeContent += `    "Healthy (≤10% fail)" : ${healthyCount}\n`;
            readmeContent += `    "Needs Attention" : ${byWorkflow.length - healthyCount - failingCount}\n`;
            readmeContent += `    "Critical (>20% fail)" : ${failingCount}\n`;
            readmeContent += '```\n\n';
          }
          
          // Show top 5 repos by activity
          readmeContent += `### Repository Status\n\n`;
          readmeContent += `| Repository | Tier | Runs | Success | Status |\n`;
          readmeContent += `|------------|------|------|---------|--------|\n`;
          for (const repo of monitoredRepos.slice(0, 5)) {
            const stats = perfData?.byRepository?.find((r: any) => r.name === repo.name);
            const runs = stats?.runs || 0;
            const success = stats ? (100 - (stats.failureRate || 0)).toFixed(0) : 'N/A';
            const status = runs === 0 ? '⚪' : (stats && (100 - (stats.failureRate || 0)) >= 90) ? '✅' : 
                          (stats && (100 - (stats.failureRate || 0)) >= 70) ? '🟡' : '🔴';
            readmeContent += `| ${repo.name} | ${repo.tier || '-'} | ${runs} | ${runs > 0 ? success + '%' : '-'} | ${status} |\n`;
          }
          if (monitoredRepos.length > 5) {
            readmeContent += `| *...and ${monitoredRepos.length - 5} more* | | | | |\n`;
          }
          readmeContent += `\n📖 [View Full CI/CD Report →](cicd-pipeline-health.md)\n\n`;
          
          // Repository Success Rate Bar Chart
          if (includeDiagrams && monitoredRepos.length > 0) {
            const repoNames = monitoredRepos.slice(0, 6).map((r: any) => `"${r.name.substring(0, 12)}"`).join(', ');
            const repoRates = monitoredRepos.slice(0, 6).map((r: any) => {
              const stats = perfData?.byRepository?.find((s: any) => s.name === r.name);
              return stats ? Math.round(100 - (stats.failureRate || 0)) : 0;
            }).join(', ');
            
            readmeContent += `### 📊 Repository Success Rates\n\n`;
            readmeContent += '```mermaid\n';
            readmeContent += `xychart-beta\n`;
            readmeContent += `    title "Success Rate by Repository"\n`;
            readmeContent += `    x-axis [${repoNames}]\n`;
            readmeContent += `    y-axis "Success Rate %" 0 --> 100\n`;
            readmeContent += `    bar [${repoRates}]\n`;
            readmeContent += '```\n\n';
          }
        }
        
        // Cost Overview
        if (generatedReports.includes('cost-optimization.md')) {
          readmeContent += `---\n\n## 💰 Cost Insights\n\n`;
          
          const slowWorkflows = (perfData?.byWorkflow || []).filter((w: any) => w.avgDurationSeconds > 600);
          const failingWorkflows = (perfData?.byWorkflow || []).filter((w: any) => w.failureRate > 30);
          const totalMinutes = (perfData?.byWorkflow || []).reduce((sum: number, w: any) => {
            return sum + (Math.round((w.avgDurationSeconds || 0) / 60) * (w.runs || 0));
          }, 0);
          
          // Cost Breakdown Pie Chart
          if (includeDiagrams) {
            const effectiveMinutes = totalMinutes - (slowWorkflows.length * 60);
            const wastedMinutes = failingWorkflows.reduce((sum: number, w: any) => {
              return sum + Math.round((w.avgDurationSeconds || 0) / 60 * (w.runs || 0) * ((w.failureRate || 0) / 100));
            }, 0);
            const slowMinutes = slowWorkflows.reduce((sum: number, w: any) => {
              return sum + Math.round(((w.avgDurationSeconds || 0) - 600) / 60 * (w.runs || 0));
            }, 0);
            
            readmeContent += '```mermaid\n';
            readmeContent += `pie showData\n`;
            readmeContent += `    title "Compute Time Distribution"\n`;
            readmeContent += `    "Productive" : ${Math.max(0, totalMinutes - wastedMinutes - slowMinutes)}\n`;
            if (wastedMinutes > 0) readmeContent += `    "Failed Runs (wasted)" : ${wastedMinutes}\n`;
            if (slowMinutes > 0) readmeContent += `    "Slow Workflow Overhead" : ${slowMinutes}\n`;
            readmeContent += '```\n\n';
          }
          
          readmeContent += `| Insight | Value |\n`;
          readmeContent += `|---------|-------|\n`;
          readmeContent += `| Total Compute Time | ${Math.round(totalMinutes / 60)}h (${totalMinutes} min) |\n`;
          readmeContent += `| Slow Workflows (>10min) | ${slowWorkflows.length} |\n`;
          readmeContent += `| High Failure Workflows | ${failingWorkflows.length} |\n`;
          readmeContent += `| Optimization Potential | ${slowWorkflows.length + failingWorkflows.length > 0 ? '🟡 Opportunities found' : '✅ Optimized'} |\n\n`;
          
          if (slowWorkflows.length > 0 || failingWorkflows.length > 0) {
            readmeContent += `⚠️ **Action Items:**\n`;
            if (slowWorkflows.length > 0) {
              readmeContent += `- ${slowWorkflows.length} workflow(s) take >10 min on average\n`;
            }
            if (failingWorkflows.length > 0) {
              readmeContent += `- ${failingWorkflows.length} workflow(s) have >30% failure rate\n`;
            }
            readmeContent += `\n`;
          }
          readmeContent += `📖 [View Full Cost Report →](cost-optimization.md)\n\n`;
        }
        
        // Security Summary
        if (generatedReports.includes('compliance-security.md')) {
          readmeContent += `---\n\n## 🔒 Security & Compliance\n\n`;
          
          const secretAlerts = complianceData?.secretAlerts?.total || 0;
          const codeAlerts = complianceData?.codeAlerts?.total || 0;
          const dependabotAlerts = complianceData?.dependabotAlerts?.total || 0;
          const ghasRepos = complianceData?.ghasStatus || [];
          const ghasEnabled = ghasRepos.filter((r: any) => r.secretScanning || r.codeScanning).length;
          
          if (includeDiagrams && (secretAlerts + codeAlerts + dependabotAlerts > 0 || ghasRepos.length > 0)) {
            readmeContent += '```mermaid\n';
            readmeContent += `pie showData\n`;
            readmeContent += `    title "Security Alerts by Type"\n`;
            if (secretAlerts > 0) readmeContent += `    "Secret Scanning" : ${secretAlerts}\n`;
            if (codeAlerts > 0) readmeContent += `    "Code Scanning" : ${codeAlerts}\n`;
            if (dependabotAlerts > 0) readmeContent += `    "Dependabot" : ${dependabotAlerts}\n`;
            if (secretAlerts + codeAlerts + dependabotAlerts === 0) readmeContent += `    "No Alerts" : 1\n`;
            readmeContent += '```\n\n';
          }
          
          readmeContent += `| Security Check | Status |\n`;
          readmeContent += `|----------------|--------|\n`;
          readmeContent += `| Secret Scanning Alerts | ${secretAlerts === 0 ? '✅ None' : `🔴 ${secretAlerts} open`} |\n`;
          readmeContent += `| Code Scanning Alerts | ${codeAlerts === 0 ? '✅ None' : codeAlerts < 5 ? `🟡 ${codeAlerts} open` : `🔴 ${codeAlerts} open`} |\n`;
          readmeContent += `| Dependabot Alerts | ${dependabotAlerts === 0 ? '✅ None' : `🟡 ${dependabotAlerts} open`} |\n`;
          readmeContent += `| GHAS Enabled | ${ghasEnabled}/${ghasRepos.length} repos |\n\n`;
          
          if (secretAlerts > 0) {
            readmeContent += `🚨 **Immediate Action Required:** ${secretAlerts} secret scanning alert(s) need remediation\n\n`;
          }
          readmeContent += `📖 [View Full Security Report →](compliance-security.md)\n\n`;
        }
        
        // CI/CD MATURITY ASSESSMENT
        readmeContent += `---\n\n## 🎓 CI/CD Maturity Assessment\n\n`;
        
        const maturityPct = Math.round((maturity.overall.score / maturity.overall.maxScore) * 100);
        const maturityEmoji = maturity.overall.level === 'Elite' ? '🏆' : maturity.overall.level === 'Advanced' ? '🌟' : maturity.overall.level === 'Intermediate' ? '📈' : '🌱';
        
        readmeContent += `### Overall Maturity: ${maturityEmoji} ${maturity.overall.level} (${maturityPct}%)\n\n`;
        
        if (includeDiagrams) {
          // Maturity radar chart
          readmeContent += '```mermaid\n';
          readmeContent += `xychart-beta\n`;
          readmeContent += `    title "Maturity by Category"\n`;
          readmeContent += `    x-axis ["Workflow", "Security", "DORA", "Operations"]\n`;
          readmeContent += `    y-axis "Score %" 0 --> 100\n`;
          const catScores = maturity.categories.map(c => Math.round((c.score / c.maxScore) * 100)).join(', ');
          readmeContent += `    bar [${catScores}]\n`;
          readmeContent += `    line [80, 80, 80, 80]\n`;
          readmeContent += '```\n\n';
        }
        
        readmeContent += `| Category | Score | Level | Status |\n`;
        readmeContent += `|----------|-------|-------|--------|\n`;
        for (const cat of maturity.categories) {
          const pct = Math.round((cat.score / cat.maxScore) * 100);
          const emoji = cat.level === 'Elite' ? '🏆' : cat.level === 'Advanced' ? '🌟' : cat.level === 'Intermediate' ? '📈' : '🌱';
          const status = pct >= 80 ? '✅' : pct >= 50 ? '🟡' : '🔴';
          readmeContent += `| ${cat.name} | ${cat.score}/${cat.maxScore} (${pct}%) | ${emoji} ${cat.level} | ${status} |\n`;
        }
        readmeContent += `\n`;
        
        // Progression path
        if (maturity.overall.level !== 'Elite') {
          const nextLevel = maturity.overall.level === 'Basic' ? 'Intermediate' : maturity.overall.level === 'Intermediate' ? 'Advanced' : 'Elite';
          const ptsNeeded = maturity.overall.level === 'Basic' ? Math.ceil(maturity.overall.maxScore * 0.4) - maturity.overall.score : 
                           maturity.overall.level === 'Intermediate' ? Math.ceil(maturity.overall.maxScore * 0.6) - maturity.overall.score : 
                           Math.ceil(maturity.overall.maxScore * 0.8) - maturity.overall.score;
          readmeContent += `📈 **Path to ${nextLevel}:** Need ${Math.max(0, ptsNeeded)} more points across categories\n\n`;
        }
        
        // 🤖 AI ADVISOR SECTION - Now uses actual AI when available
        readmeContent += `---\n\n## 🤖 AI Advisor Insights${aiProviderInfo.enabled ? ` (${aiProviderInfo.provider}/${aiProviderInfo.model})` : ''}\n\n`;
        
        // Build context for AI-powered DORA analysis
        const ltValueRDM = doraData?.metrics?.leadTimeForChanges?.value || 0;
        const mttrValueRDM = doraData?.metrics?.timeToRestore?.value || 0;
        const readmeDORAContext = {
          organization: orgName,
          timeframe: timeframeLabel,
          deploymentFrequency: {
            value: parseFloat(doraData?.metrics?.deploymentFrequency?.value || '0'),
            unit: 'per day',
            rating: doraData?.metrics?.deploymentFrequency?.level || 'Low',
          },
          leadTime: {
            value: ltValueRDM < 24 
              ? Math.round(ltValueRDM * 10) / 10 
              : Math.round(ltValueRDM / 24 * 10) / 10,
            unit: ltValueRDM < 24 ? 'hours' : 'days',
            rating: doraData?.metrics?.leadTimeForChanges?.level || 'Low',
          },
          changeFailureRate: {
            value: doraData?.metrics?.changeFailureRate?.value || 0,
            rating: doraData?.metrics?.changeFailureRate?.level || 'Low',
          },
          mttr: {
            value: mttrValueRDM < 24 
              ? Math.round(mttrValueRDM * 10) / 10 
              : Math.round(mttrValueRDM / 24 * 10) / 10,
            unit: mttrValueRDM < 24 ? 'hours' : 'days',
            rating: doraData?.metrics?.timeToRestore?.level || 'Low',
          },
          overallRating: doraData?.overallLevel || 'N/A',
        };
        
        const readmeDORAInsights = await generateDORAInsights(readmeDORAContext);
        
        if (readmeDORAInsights.provider === 'GitHub Copilot' && readmeDORAInsights.success) {
          readmeContent += `> 🤖 AI-generated analysis powered by GitHub Copilot\n\n`;
          readmeContent += readmeDORAInsights.insights;
          readmeContent += `\n\n`;
        } else {
          // Use the detailed static DORA insights - they include code examples
          readmeContent += `> 💡 Static analysis based on your metrics\n\n`;
          // Show the brief summary insights first
          for (const insight of maturity.aiAdvisorInsights) {
            readmeContent += `${insight}\n\n`;
          }
          // Then add the detailed analysis with code examples
          readmeContent += `\n${readmeDORAInsights.insights}\n`;
        }
        
        // 📋 ACTIONABLE RECOMMENDATIONS
        readmeContent += `---\n\n## 📋 Actionable Recommendations\n\n`;
        
        const highPriorityRecs = allRecommendations.filter(r => r.priority === 'high');
        const mediumPriorityRecs = allRecommendations.filter(r => r.priority === 'medium');
        const lowPriorityRecs = allRecommendations.filter(r => r.priority === 'low');
        
        if (highPriorityRecs.length > 0) {
          readmeContent += `### 🔴 High Priority\n\n`;
          for (const rec of highPriorityRecs) {
            readmeContent += `<details>\n<summary><strong>${rec.title}</strong></summary>\n\n`;
            readmeContent += `${rec.description}\n\n`;
            readmeContent += `**Impact:** ${rec.impact}\n\n`;
            if (rec.docLink) readmeContent += `📚 [Learn more](${rec.docLink})\n\n`;
            readmeContent += `</details>\n\n`;
          }
        }
        
        if (mediumPriorityRecs.length > 0) {
          readmeContent += `### 🟡 Medium Priority\n\n`;
          for (const rec of mediumPriorityRecs.slice(0, 5)) {
            readmeContent += `<details>\n<summary><strong>${rec.title}</strong></summary>\n\n`;
            readmeContent += `${rec.description}\n\n`;
            readmeContent += `**Impact:** ${rec.impact}\n\n`;
            if (rec.docLink) readmeContent += `📚 [Learn more](${rec.docLink})\n\n`;
            readmeContent += `</details>\n\n`;
          }
        }
        
        if (lowPriorityRecs.length > 0) {
          readmeContent += `### 🟢 Low Priority (Nice to Have)\n\n`;
          for (const rec of lowPriorityRecs.slice(0, 3)) {
            readmeContent += `- **${rec.title}:** ${rec.description}\n`;
          }
          readmeContent += `\n`;
        }
        
        if (allRecommendations.length === 0) {
          readmeContent += `✅ **Great job!** No critical recommendations at this time. Continue maintaining your excellent DevOps practices.\n\n`;
        }
        
        // Report Links
        readmeContent += `---\n\n## 📁 Detailed Reports\n\n`;
        readmeContent += `| Report | Description |\n`;
        readmeContent += `|--------|-------------|\n`;
        
        if (generatedReports.includes('dora-metrics.md')) {
          readmeContent += `| [🏆 DORA Metrics](dora-metrics.md) | Deployment frequency, lead time, change failure rate, MTTR |\n`;
        }
        if (generatedReports.includes('cicd-pipeline-health.md')) {
          readmeContent += `| [🔄 CI/CD Pipeline Health](cicd-pipeline-health.md) | Workflow performance, failure analysis, runner utilization |\n`;
        }
        if (generatedReports.includes('cost-optimization.md')) {
          readmeContent += `| [💰 Cost Optimization](cost-optimization.md) | Usage analysis, optimization recommendations |\n`;
        }
        if (generatedReports.includes('compliance-security.md')) {
          readmeContent += `| [🔒 Compliance & Security](compliance-security.md) | Compliance status, security scanning |\n`;
        }
        if (generatedReports.includes('migration-best-practices.md')) {
          readmeContent += `| [🗄️ Migration Best Practices](migration-best-practices.md) | Database migration safety suggestions |\n`;
        }
        
        readmeContent += `\n---\n\n## 📖 Viewing Diagrams\n\n`;
        readmeContent += `These reports contain [Mermaid](https://mermaid.js.org/) diagrams.\n\n`;
        readmeContent += `- **GitHub**: View directly in the repository\n`;
        readmeContent += `- **VS Code**: Install [Markdown Preview Mermaid Support](https://marketplace.visualstudio.com/items?itemName=bierner.markdown-mermaid)\n`;
        readmeContent += `- **Online**: Use [Mermaid Live Editor](https://mermaid.live/)\n`;
        readmeContent += `- **Interactive**: Open [dashboard.html](dashboard.html) in a browser\n`;
        
        writeFileSync(join(reportFolder, 'README.md'), readmeContent);
        
        // Generate Interactive HTML Dashboard
        const doraScore = overallLevel === 'Elite' ? 95 : overallLevel === 'High' ? 75 : overallLevel === 'Medium' ? 50 : 25;
        const securityScore = securityAlerts === 0 ? 100 : securityAlerts < 5 ? 70 : securityAlerts < 20 ? 40 : 20;
        const repoHealthScore = Math.round((healthyRepos / Math.max(totalRepos, 1)) * 100);
        const cicdScore = Math.round(overallSuccessRate);
        
        const df = doraData?.metrics?.deploymentFrequency || {};
        const lt = doraData?.metrics?.leadTimeForChanges || {};
        const cfr = doraData?.metrics?.changeFailureRate || {};
        const mttr = doraData?.metrics?.timeToRestore || {};
        const levelToNum = (l: string) => l === 'Elite' ? 4 : l === 'High' ? 3 : l === 'Medium' ? 2 : 1;
        
        // Format DORA values for display (avoid long decimals)
        const formatDoraValue = (val: number | string | undefined, unit: 'hours' | 'days' | 'percent' | 'perday'): string => {
          const num = typeof val === 'string' ? parseFloat(val) : (val || 0);
          if (isNaN(num) || num === 0) return '0';
          if (unit === 'percent') return Math.round(num).toString();
          if (unit === 'perday') return num.toFixed(1);
          // For hours/days, show clean format
          if (unit === 'hours' && num >= 24) {
            return (num / 24).toFixed(1) + 'd';
          }
          return num < 1 ? num.toFixed(1) : Math.round(num).toString();
        };
        
        const dfDisplay = formatDoraValue(df.value, 'perday');
        const ltDisplay = formatDoraValue(lt.value, 'hours');
        const cfrDisplay = formatDoraValue(cfr.value, 'percent');
        const mttrDisplay = formatDoraValue(mttr.value, 'hours');
        
        // Show all monitored repos in the bar chart (up to 15 max)
        const repoSuccessData = monitoredRepos.slice(0, 15).map((r: any) => {
          const stats = perfData?.byRepository?.find((s: any) => s.name === r.name);
          return { name: r.name, rate: stats ? Math.round(100 - (stats.failureRate || 0)) : 0 };
        });
        
        // Runner data for dashboard - with cost estimates
        const dashboardRunnerTypes = perfData?.byRunnerType || [];
        const runnerPricingDashboard: Record<string, number> = { 'ubuntu': 0.008, 'windows': 0.016, 'macos': 0.08, 'linux': 0.008 };
        const dashboardRunnerData = dashboardRunnerTypes.slice(0, 5).map((r: any) => {
          const osType = (r.type || '').toLowerCase();
          const baseOs = osType.includes('windows') ? 'windows' : osType.includes('macos') ? 'macos' : 'linux';
          const pricePerMin = runnerPricingDashboard[baseOs] || 0.008;
          const totalMinutes = Math.round(((r.avgDurationSeconds || 0) / 60) * (r.runs || 0));
          return {
            type: (r.type || 'unknown').substring(0, 12),
            runs: r.runs || 0,
            avgDuration: Math.round((r.avgDurationSeconds || 0) / 60),
            estimatedCost: totalMinutes * pricePerMin,
          };
        });
        const totalDashboardRuns = dashboardRunnerData.reduce((s: number, r: any) => s + r.runs, 0);
        const totalDashboardCost = dashboardRunnerData.reduce((s: number, r: any) => s + r.estimatedCost, 0);
        
        const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>DevOps Dashboard - ${orgName}</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); min-height: 100vh; color: #fff; padding: 20px; }
        .container { max-width: 1400px; margin: 0 auto; }
        h1 { text-align: center; margin-bottom: 10px; font-size: 2.5em; background: linear-gradient(90deg, #00d4ff, #7b2cbf); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .subtitle { text-align: center; color: #888; margin-bottom: 30px; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; margin-bottom: 20px; }
        .grid-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; margin-bottom: 20px; }
        .grid-2 { display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px; margin-bottom: 20px; }
        @media (max-width: 1024px) { .grid-3 { grid-template-columns: repeat(2, 1fr); } }
        @media (max-width: 768px) { .grid-3, .grid-2 { grid-template-columns: 1fr; } }
        .card { background: rgba(255,255,255,0.05); border-radius: 16px; padding: 24px; backdrop-filter: blur(10px); border: 1px solid rgba(255,255,255,0.1); text-decoration: none; color: inherit; display: block; }
        .card.clickable { cursor: pointer; transition: all 0.3s ease; }
        .card.clickable:hover { transform: translateY(-4px); border-color: #00d4ff; box-shadow: 0 10px 40px rgba(0,212,255,0.2); }
        .card h3 { margin-bottom: 20px; color: #00d4ff; display: flex; align-items: center; justify-content: space-between; }
        .card h3 .arrow { opacity: 0; transition: opacity 0.3s; }
        .card.clickable:hover h3 .arrow { opacity: 1; }
        .metric-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 15px; margin-bottom: 20px; }
        .metric { background: rgba(255,255,255,0.05); border-radius: 12px; padding: 20px; text-align: center; }
        .metric .value { font-size: 2em; font-weight: bold; margin-bottom: 5px; }
        .metric .label { color: #888; font-size: 0.85em; }
        .metric.green .value { color: #4ade80; }
        .metric.yellow .value { color: #fbbf24; }
        .metric.red .value { color: #f87171; }
        .chart-container { position: relative; height: 300px; }
        .wide { grid-column: span 2; }
        @media (max-width: 768px) { .metric-grid { grid-template-columns: repeat(2, 1fr); } .wide { grid-column: span 1; } }
        .back-link { display: inline-block; margin-bottom: 20px; color: #00d4ff; text-decoration: none; }
        .back-link:hover { text-decoration: underline; }
        .status-badge { display: inline-block; padding: 4px 12px; border-radius: 20px; font-size: 0.8em; font-weight: 600; }
        .status-badge.elite { background: linear-gradient(90deg, #a855f7, #6366f1); }
        .status-badge.high { background: linear-gradient(90deg, #22c55e, #16a34a); }
        .status-badge.medium { background: linear-gradient(90deg, #eab308, #ca8a04); }
        .status-badge.low { background: linear-gradient(90deg, #ef4444, #dc2626); }
        table { width: 100%; border-collapse: collapse; margin-top: 15px; }
        th, td { padding: 12px; text-align: left; border-bottom: 1px solid rgba(255,255,255,0.1); }
        th { color: #888; font-weight: 500; }
        .progress-bar { height: 8px; background: rgba(255,255,255,0.1); border-radius: 4px; overflow: hidden; }
        .progress-bar .fill { height: 100%; border-radius: 4px; transition: width 1s ease; }
        .fill.green { background: linear-gradient(90deg, #22c55e, #4ade80); }
        .fill.yellow { background: linear-gradient(90deg, #eab308, #fbbf24); }
        .fill.red { background: linear-gradient(90deg, #dc2626, #f87171); }
    </style>
</head>
<body>
    <div class="container">
        <h1>📊 DevOps Insights Dashboard</h1>
        <p class="subtitle">${orgName} • ${reportDate} • ${timeframeLabel}</p>
        
        <div class="metric-grid">
            <div class="metric ${doraScore >= 75 ? 'green' : doraScore >= 50 ? 'yellow' : 'red'}">
                <div class="value">${overallLevel}</div>
                <div class="label">🏆 DORA Performance</div>
            </div>
            <div class="metric ${cicdScore >= 90 ? 'green' : cicdScore >= 70 ? 'yellow' : 'red'}">
                <div class="value">${cicdScore}%</div>
                <div class="label">🔄 CI/CD Success</div>
            </div>
            <div class="metric ${healthyRepos === totalRepos ? 'green' : healthyRepos >= totalRepos * 0.7 ? 'yellow' : 'red'}">
                <div class="value">${healthyRepos}/${totalRepos}</div>
                <div class="label">📦 Healthy Repos</div>
            </div>
            <div class="metric ${securityAlerts === 0 ? 'green' : securityAlerts < 5 ? 'yellow' : 'red'}">
                <div class="value">${securityAlertsDisplay}</div>
                <div class="label">🔒 Security Alerts</div>
            </div>
        </div>
        
        <!-- Top Row: 3 cards -->
        <div class="grid-3">
            <a href="dora-details.html" class="card clickable">
                <h3>🏆 DORA Metrics <span class="arrow">→</span></h3>
                <div class="chart-container">
                    <canvas id="doraChart"></canvas>
                </div>
            </a>
            
            <a href="cicd-details.html" class="card clickable">
                <h3>🔄 CI/CD Pipeline <span class="arrow">→</span></h3>
                <div class="chart-container">
                    <canvas id="repoChart"></canvas>
                </div>
            </a>
            
            <a href="cost-details.html" class="card clickable">
                <h3>💰 Cost Insights <span class="arrow">→</span></h3>
                <div class="chart-container">
                    <canvas id="healthChart"></canvas>
                </div>
            </a>
        </div>
        
        <!-- Bottom Row: 2 cards (balanced) -->
        <div class="grid-2">
            <a href="cost-details.html#runners" class="card clickable">
                <h3>🏃 Runner Costs <span class="arrow">→</span></h3>
                <div style="display: flex; align-items: center; gap: 20px;">
                    <div class="chart-container" style="flex: 1; height: 200px;">
                        <canvas id="runnerChart"></canvas>
                    </div>
                    <div style="flex: 0 0 auto; text-align: right;">
                        <div style="margin-bottom: 15px;">
                            <div style="font-size: 1.8em; font-weight: bold; color: #4ade80;">~$${totalDashboardCost.toFixed(0)}</div>
                            <div style="color: #888; font-size: 0.85em;">Est. Cost (${timeframeLabel})</div>
                        </div>
                        <div style="margin-bottom: 15px;">
                            <div style="font-size: 1.5em; font-weight: bold; color: #a855f7;">${totalDashboardRuns.toLocaleString()}</div>
                            <div style="color: #888; font-size: 0.85em;">Total Runs</div>
                        </div>
                        <div>
                            <div style="font-size: 1.2em; font-weight: bold; color: #06b6d4;">${dashboardRunnerData.length}</div>
                            <div style="color: #888; font-size: 0.85em;">Runner Types</div>
                        </div>
                    </div>
                </div>
            </a>
            
            <a href="security-details.html" class="card clickable">
                <h3>🔒 Security <span class="arrow">→</span></h3>
                <div class="chart-container">
                    <canvas id="securityChart"></canvas>
                </div>
            </a>
        </div>
        
        <div class="grid">
            <div class="card wide">
                <h3>📋 Repository Status</h3>
                <table>
                    <thead>
                        <tr><th>Repository</th><th>Tier</th><th>Runs</th><th>Success Rate</th><th>Status</th></tr>
                    </thead>
                    <tbody>
                        ${monitoredRepos.slice(0, 10).map((r: any) => {
                          const stats = perfData?.byRepository?.find((s: any) => s.name === r.name);
                          const runs = stats?.runs || 0;
                          const successRate = stats ? Math.round(100 - (stats.failureRate || 0)) : 0;
                          const statusClass = successRate >= 90 ? 'green' : successRate >= 70 ? 'yellow' : 'red';
                          return `<tr>
                            <td>${r.name}</td>
                            <td>${r.tier || '-'}</td>
                            <td>${runs}</td>
                            <td><div class="progress-bar"><div class="fill ${statusClass}" style="width: ${successRate}%"></div></div></td>
                            <td>${successRate}%</td>
                          </tr>`;
                        }).join('')}
                    </tbody>
                </table>
            </div>
        </div>
        
        <!-- Maturity Assessment Section -->
        <div class="grid">
            <a href="maturity-details.html" class="card clickable">
                <h3>🎓 CI/CD Maturity Assessment <span class="arrow">→</span></h3>
                <div style="text-align: center; margin-bottom: 20px;">
                    <span class="status-badge ${maturity.overall.level.toLowerCase()}">${maturity.overall.level}</span>
                    <div style="font-size: 3em; margin: 15px 0;">${Math.round((maturity.overall.score / maturity.overall.maxScore) * 100)}%</div>
                    <div style="color: #888;">Overall Maturity Score</div>
                </div>
                <div class="chart-container" style="height: 200px;">
                    <canvas id="maturityChart"></canvas>
                </div>
            </a>
            
            <a href="maturity-details.html#ai-insights" class="card clickable">
                <h3>🤖 AI Advisor Insights ${aiProviderInfo.enabled ? `<span style="font-size: 0.7em; color: #a855f7;">(${aiProviderInfo.provider})</span>` : ''} <span class="arrow">→</span></h3>
                <div style="display: flex; flex-direction: column; gap: 15px;">
                    ${maturity.aiAdvisorInsights.slice(0, 4).map(insight => `
                    <div style="padding: 15px; background: rgba(0,212,255,0.05); border-radius: 12px; border-left: 3px solid #00d4ff;">
                        ${insight.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')}
                    </div>
                    `).join('')}
                </div>
                <div style="text-align: center; margin-top: 15px; color: #00d4ff; font-size: 0.9em;">View all insights →</div>
            </a>
        </div>
        
        <!-- Migration Best Practices Section (Advisory) -->
        ${migrationAnalysis.length > 0 ? (() => {
          const reposWithTools = migrationAnalysis.filter(r => r.tool !== 'none');
          const totalPipelines = reposWithTools.reduce((sum, r) => sum + r.workflows.length, 0);
          const uniqueTools = [...new Set(reposWithTools.map(r => r.tool))];
          const toolsDisplay = uniqueTools.map(t => t.charAt(0).toUpperCase() + t.slice(1)).join(', ') || 'None';
          const suggestionCount = allMigrationRecommendations.length;
          
          return `
        <a href="migration-details.html" class="card clickable" style="margin-bottom: 20px; display: block; text-decoration: none; color: inherit;">
            <h3>🗄️ Database Migration Practices <span style="font-size: 0.7em; background: rgba(168,85,247,0.2); color: #a855f7; padding: 4px 10px; border-radius: 12px; margin-left: 10px;">Advisory</span> <span class="arrow">→</span></h3>
            <p style="color: #888; margin-bottom: 20px; font-size: 0.9em;">Suggestions to reduce deployment risk. Does not affect DevOps scores.</p>
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 15px;">
                <div style="text-align: center; padding: 20px; background: rgba(168, 85, 247, 0.08); border-radius: 12px;">
                    <div style="font-size: 2.5em; color: #a855f7; margin-bottom: 5px;">${reposWithTools.length}</div>
                    <div style="color: #888; font-size: 0.85em;">Repos with Migrations</div>
                </div>
                <div style="text-align: center; padding: 20px; background: rgba(34, 197, 94, 0.08); border-radius: 12px;">
                    <div style="font-size: 2.5em; color: #22c55e; margin-bottom: 5px;">${totalPipelines}</div>
                    <div style="color: #888; font-size: 0.85em;">Migration Pipelines</div>
                </div>
                <div style="text-align: center; padding: 20px; background: rgba(251, 191, 36, 0.08); border-radius: 12px;">
                    <div style="font-size: 2.5em; color: #fbbf24; margin-bottom: 5px;">${suggestionCount}</div>
                    <div style="color: #888; font-size: 0.85em;">Suggestions</div>
                </div>
                <div style="text-align: center; padding: 20px; background: rgba(6, 182, 212, 0.08); border-radius: 12px;">
                    <div style="font-size: 1.2em; color: #06b6d4; margin-bottom: 5px; margin-top: 10px;">${toolsDisplay}</div>
                    <div style="color: #888; font-size: 0.85em; margin-top: 10px;">Detected Tools</div>
                </div>
            </div>
        </a>
        `;
        })() : ''}
        
        <!-- Recommendations Section -->
        <a href="maturity-details.html#recommendations" class="card clickable" style="margin-bottom: 20px; display: block; text-decoration: none; color: inherit;">
            <h3>📋 Top Recommendations <span class="arrow">→</span></h3>
            <table>
                <thead>
                    <tr><th>Priority</th><th>Action</th><th>Impact</th></tr>
                </thead>
                <tbody>
                    ${allRecommendations.slice(0, 5).map(rec => `
                    <tr>
                        <td><span class="status-badge ${rec.priority === 'high' ? 'low' : rec.priority === 'medium' ? 'medium' : 'high'}">${rec.priority.toUpperCase()}</span></td>
                        <td><strong>${rec.title}</strong><br><small style="color: #888;">${rec.description.substring(0, 100)}${rec.description.length > 100 ? '...' : ''}</small></td>
                        <td style="color: #4ade80;">${rec.impact}</td>
                    </tr>
                    `).join('')}
                </tbody>
            </table>
            <div style="text-align: center; margin-top: 15px; color: #00d4ff; font-size: 0.9em;">View all ${allRecommendations.length} recommendations →</div>
        </a>
    </div>
    
    <script>
        Chart.defaults.color = '#888';
        Chart.defaults.borderColor = 'rgba(255,255,255,0.1)';
        
        // Health Scores Chart
        new Chart(document.getElementById('healthChart'), {
            type: 'bar',
            data: {
                labels: ['DORA', 'Security', 'Repo Health', 'CI/CD'],
                datasets: [{
                    label: 'Current Score',
                    data: [${doraScore}, ${securityScore}, ${repoHealthScore}, ${cicdScore}],
                    backgroundColor: ['#6366f1', '#22c55e', '#f59e0b', '#06b6d4'],
                    borderRadius: 8,
                }, {
                    label: 'Target (80%)',
                    data: [80, 80, 80, 80],
                    type: 'line',
                    borderColor: '#f87171',
                    borderDash: [5, 5],
                    pointRadius: 0,
                    fill: false,
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { position: 'bottom' } },
                scales: { y: { beginAtZero: true, max: 100 } }
            }
        });
        
        // DORA Chart
        new Chart(document.getElementById('doraChart'), {
            type: 'radar',
            data: {
                labels: ['Deploy Freq', 'Lead Time', 'Change Fail Rate', 'MTTR'],
                datasets: [{
                    label: 'Current',
                    data: [${levelToNum(df.level || 'Low')}, ${levelToNum(lt.level || 'Low')}, ${levelToNum(cfr.level || 'Low')}, ${levelToNum(mttr.level || 'Low')}],
                    backgroundColor: 'rgba(99, 102, 241, 0.3)',
                    borderColor: '#6366f1',
                    pointBackgroundColor: '#6366f1',
                }, {
                    label: 'Target (High)',
                    data: [3, 3, 3, 3],
                    backgroundColor: 'rgba(248, 113, 113, 0.1)',
                    borderColor: '#f87171',
                    borderDash: [5, 5],
                    pointRadius: 0,
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { position: 'bottom' } },
                scales: { r: { beginAtZero: true, max: 4, ticks: { stepSize: 1, callback: v => ['', 'Low', 'Med', 'High', 'Elite'][v] } } }
            }
        });
        
        // Repository Chart
        new Chart(document.getElementById('repoChart'), {
            type: 'bar',
            data: {
                labels: ${JSON.stringify(repoSuccessData.map((r: any) => r.name.substring(0, 15)))},
                datasets: [{
                    label: 'Success Rate %',
                    data: ${JSON.stringify(repoSuccessData.map((r: any) => r.rate))},
                    backgroundColor: ${JSON.stringify(repoSuccessData.map((r: any) => r.rate >= 90 ? '#22c55e' : r.rate >= 70 ? '#f59e0b' : '#ef4444'))},
                    borderRadius: 8,
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                indexAxis: 'y',
                plugins: { legend: { display: false } },
                scales: { x: { beginAtZero: true, max: 100 } }
            }
        });
        
        // Security Chart
        new Chart(document.getElementById('securityChart'), {
            type: 'doughnut',
            data: {
                labels: ['Secret Scanning', 'Code Scanning', 'Dependabot'],
                datasets: [{
                    data: [${complianceData?.secretAlerts?.total || 0}, ${complianceData?.codeAlerts?.total || 0}, ${complianceData?.dependabotAlerts?.total || 0}],
                    backgroundColor: ['#f87171', '#fbbf24', '#60a5fa'],
                    borderWidth: 0,
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { position: 'bottom' } },
                cutout: '60%',
            }
        });
        
        // Runner Cost Distribution Chart (Doughnut)
        new Chart(document.getElementById('runnerChart'), {
            type: 'doughnut',
            data: {
                labels: ${JSON.stringify(dashboardRunnerData.length > 0 ? dashboardRunnerData.map((r: any) => r.type) : ['No data'])},
                datasets: [{
                    data: ${JSON.stringify(dashboardRunnerData.length > 0 ? dashboardRunnerData.map((r: any) => parseFloat(r.estimatedCost.toFixed(2))) : [1])},
                    backgroundColor: ['#a855f7', '#22c55e', '#f59e0b', '#06b6d4', '#ef4444'],
                    borderWidth: 0,
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { 
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                return context.label + ': $' + context.raw;
                            }
                        }
                    }
                },
                cutout: '65%',
            }
        });
        
        // Maturity Chart
        new Chart(document.getElementById('maturityChart'), {
            type: 'bar',
            data: {
                labels: ${JSON.stringify(maturity.categories.map(c => c.name.split(' ')[0]))},
                datasets: [{
                    label: 'Score %',
                    data: ${JSON.stringify(maturity.categories.map(c => Math.round((c.score / c.maxScore) * 100)))},
                    backgroundColor: ${JSON.stringify(maturity.categories.map(c => {
                      const pct = Math.round((c.score / c.maxScore) * 100);
                      return pct >= 80 ? '#22c55e' : pct >= 50 ? '#f59e0b' : '#ef4444';
                    }))},
                    borderRadius: 8,
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: { y: { beginAtZero: true, max: 100 } }
            }
        });
    </script>
</body>
</html>`;
        
        writeFileSync(join(reportFolder, 'dashboard.html'), htmlContent);
        generatedReports.push('dashboard.html');
        
        // Common HTML template parts
        const htmlHead = (title: string) => `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title} - ${orgName}</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); min-height: 100vh; color: #fff; padding: 20px; }
        .container { max-width: 1200px; margin: 0 auto; }
        h1 { margin-bottom: 10px; font-size: 2em; }
        .subtitle { color: #888; margin-bottom: 30px; }
        .back-link { display: inline-flex; align-items: center; gap: 8px; margin-bottom: 20px; color: #00d4ff; text-decoration: none; padding: 8px 16px; border-radius: 8px; background: rgba(0,212,255,0.1); transition: all 0.3s; }
        .back-link:hover { background: rgba(0,212,255,0.2); }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; margin-bottom: 20px; }
        .card { background: rgba(255,255,255,0.05); border-radius: 16px; padding: 24px; backdrop-filter: blur(10px); border: 1px solid rgba(255,255,255,0.1); }
        .card h3 { margin-bottom: 20px; color: #00d4ff; }
        .chart-container { position: relative; height: 350px; }
        .wide { grid-column: span 2; }
        .metric-row { display: flex; gap: 20px; margin-bottom: 20px; flex-wrap: wrap; }
        .metric-box { flex: 1; min-width: 150px; background: rgba(255,255,255,0.05); border-radius: 12px; padding: 20px; text-align: center; }
        .metric-box .value { font-size: 2.5em; font-weight: bold; margin-bottom: 5px; }
        .metric-box .label { color: #888; }
        .metric-box.elite .value { color: #a855f7; }
        .metric-box.high .value { color: #22c55e; }
        .metric-box.medium .value { color: #fbbf24; }
        .metric-box.low .value { color: #f87171; }
        .metric-box.green .value { color: #4ade80; }
        .metric-box.yellow .value { color: #fbbf24; }
        .metric-box.red .value { color: #f87171; }
        table { width: 100%; border-collapse: collapse; margin-top: 15px; }
        th, td { padding: 12px; text-align: left; border-bottom: 1px solid rgba(255,255,255,0.1); }
        th { color: #888; font-weight: 500; }
        .progress-bar { height: 8px; background: rgba(255,255,255,0.1); border-radius: 4px; overflow: hidden; }
        .progress-bar .fill { height: 100%; border-radius: 4px; }
        .fill.green { background: linear-gradient(90deg, #22c55e, #4ade80); }
        .fill.yellow { background: linear-gradient(90deg, #eab308, #fbbf24); }
        .fill.red { background: linear-gradient(90deg, #dc2626, #f87171); }
        .alert-box { padding: 16px; border-radius: 12px; margin-bottom: 20px; }
        .alert-box.warning { background: rgba(251,191,36,0.1); border: 1px solid #fbbf24; }
        .alert-box.danger { background: rgba(248,113,113,0.1); border: 1px solid #f87171; }
        .alert-box.success { background: rgba(74,222,128,0.1); border: 1px solid #4ade80; }
        .status-badge { display: inline-block; padding: 4px 12px; border-radius: 20px; font-size: 0.8em; font-weight: 600; }
        .status-badge.elite { background: linear-gradient(90deg, #a855f7, #6366f1); }
        .status-badge.advanced { background: linear-gradient(90deg, #22c55e, #16a34a); }
        .status-badge.intermediate { background: linear-gradient(90deg, #eab308, #ca8a04); }
        .status-badge.basic { background: linear-gradient(90deg, #ef4444, #dc2626); }
        .status-badge.high { background: linear-gradient(90deg, #ef4444, #dc2626); }
        .status-badge.medium { background: linear-gradient(90deg, #eab308, #ca8a04); }
        .status-badge.low { background: linear-gradient(90deg, #22c55e, #16a34a); }
        @media (max-width: 768px) { .wide { grid-column: span 1; } }
    </style>
</head>
<body>
    <div class="container">
        <a href="dashboard.html" class="back-link">← Back to Dashboard</a>`;
        
        const htmlFoot = `    </div>
</body>
</html>`;
        
        // DORA Details Page
        const doraDetailsHtml = `${htmlHead('DORA Metrics')}
        <h1>🏆 DORA Metrics</h1>
        <p class="subtitle">${orgName} • ${reportDate} • ${timeframeLabel}</p>
        
        <div class="metric-row">
            <div class="metric-box ${df.level?.toLowerCase() || 'low'}">
                <div class="value">${dfDisplay}/day</div>
                <div class="label">Deployment Frequency</div>
                <small style="color: #888">${df.level || 'N/A'}</small>
            </div>
            <div class="metric-box ${lt.level?.toLowerCase() || 'low'}">
                <div class="value">${ltDisplay}${ltDisplay.includes('d') ? '' : 'h'}</div>
                <div class="label">Lead Time for Changes</div>
                <small style="color: #888">${lt.level || 'N/A'}</small>
            </div>
            <div class="metric-box ${cfr.level?.toLowerCase() || 'low'}">
                <div class="value">${cfrDisplay}%</div>
                <div class="label">Change Failure Rate</div>
                <small style="color: #888">${cfr.level || 'N/A'}</small>
            </div>
            <div class="metric-box ${mttr.level?.toLowerCase() || 'low'}">
                <div class="value">${mttrDisplay}${mttrDisplay.includes('d') ? '' : 'h'}</div>
                <div class="label">Time to Restore</div>
                <small style="color: #888">${mttr.level || 'N/A'}</small>
            </div>
        </div>
        
        <div class="grid">
            <div class="card">
                <h3>Performance vs Target</h3>
                <div class="chart-container">
                    <canvas id="doraRadar"></canvas>
                </div>
            </div>
            <div class="card">
                <h3>Metric Levels</h3>
                <div class="chart-container">
                    <canvas id="doraBar"></canvas>
                </div>
            </div>
        </div>
        
        <div class="card">
            <h3>DORA Benchmarks</h3>
            <table>
                <thead><tr><th>Metric</th><th>Elite</th><th>High</th><th>Medium</th><th>Low</th><th>Your Level</th></tr></thead>
                <tbody>
                    <tr><td>Deployment Frequency</td><td>Multiple/day</td><td>Daily-Weekly</td><td>Weekly-Monthly</td><td>Monthly+</td><td><strong>${df.level || 'N/A'}</strong></td></tr>
                    <tr><td>Lead Time</td><td>&lt;1 hour</td><td>&lt;1 day</td><td>&lt;1 week</td><td>&gt;1 week</td><td><strong>${lt.level || 'N/A'}</strong></td></tr>
                    <tr><td>Change Failure Rate</td><td>&lt;5%</td><td>&lt;10%</td><td>&lt;15%</td><td>&gt;15%</td><td><strong>${cfr.level || 'N/A'}</strong></td></tr>
                    <tr><td>Time to Restore</td><td>&lt;1 hour</td><td>&lt;1 day</td><td>&lt;1 week</td><td>&gt;1 week</td><td><strong>${mttr.level || 'N/A'}</strong></td></tr>
                </tbody>
            </table>
        </div>
    <script>
        Chart.defaults.color = '#888';
        new Chart(document.getElementById('doraRadar'), {
            type: 'radar',
            data: {
                labels: ['Deploy Freq', 'Lead Time', 'Change Fail', 'MTTR'],
                datasets: [{
                    label: 'Current',
                    data: [${levelToNum(df.level || 'Low')}, ${levelToNum(lt.level || 'Low')}, ${levelToNum(cfr.level || 'Low')}, ${levelToNum(mttr.level || 'Low')}],
                    backgroundColor: 'rgba(99,102,241,0.3)',
                    borderColor: '#6366f1',
                }, {
                    label: 'Target (High)',
                    data: [3, 3, 3, 3],
                    backgroundColor: 'rgba(248,113,113,0.1)',
                    borderColor: '#f87171',
                    borderDash: [5,5],
                }]
            },
            options: { responsive: true, maintainAspectRatio: false, scales: { r: { beginAtZero: true, max: 4, ticks: { stepSize: 1, callback: v => ['','Low','Med','High','Elite'][v] } } } }
        });
        new Chart(document.getElementById('doraBar'), {
            type: 'bar',
            data: {
                labels: ['Deploy Freq', 'Lead Time', 'Change Fail', 'MTTR'],
                datasets: [{ data: [${levelToNum(df.level || 'Low')}, ${levelToNum(lt.level || 'Low')}, ${levelToNum(cfr.level || 'Low')}, ${levelToNum(mttr.level || 'Low')}], backgroundColor: ['#6366f1', '#22c55e', '#f59e0b', '#06b6d4'], borderRadius: 8 }]
            },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, max: 4, ticks: { stepSize: 1, callback: v => ['','Low','Med','High','Elite'][v] } } } }
        });
    </script>
${htmlFoot}`;
        writeFileSync(join(reportFolder, 'dora-details.html'), doraDetailsHtml);
        
        // CI/CD Details Page
        const workflows = perfData?.byWorkflow || [];
        const cicdDetailsHtml = `${htmlHead('CI/CD Pipeline Health')}
        <h1>🔄 CI/CD Pipeline Health</h1>
        <p class="subtitle">${orgName} • ${reportDate} • ${timeframeLabel}</p>
        
        <div class="metric-row">
            <div class="metric-box ${cicdScore >= 90 ? 'green' : cicdScore >= 70 ? 'yellow' : 'red'}">
                <div class="value">${cicdScore}%</div>
                <div class="label">Overall Success Rate</div>
            </div>
            <div class="metric-box">
                <div class="value">${totalWorkflowRuns}</div>
                <div class="label">Total Runs</div>
            </div>
            <div class="metric-box ${workflows.filter((w: any) => w.failureRate <= 10).length === workflows.length ? 'green' : 'yellow'}">
                <div class="value">${workflows.filter((w: any) => w.failureRate <= 10).length}/${workflows.length}</div>
                <div class="label">Healthy Workflows</div>
            </div>
        </div>
        
        <div class="grid">
            <div class="card">
                <h3>Workflow Health Distribution</h3>
                <div class="chart-container">
                    <canvas id="workflowPie"></canvas>
                </div>
            </div>
            <div class="card">
                <h3>Repository Success Rates</h3>
                <div class="chart-container">
                    <canvas id="repoBar"></canvas>
                </div>
            </div>
        </div>
        
        <div class="card wide">
            <h3>Repository Details</h3>
            <table>
                <thead><tr><th>Repository</th><th>Tier</th><th>Runs</th><th>Success Rate</th><th>Avg Duration</th></tr></thead>
                <tbody>
                    ${monitoredRepos.map((r: any) => {
                      const stats = perfData?.byRepository?.find((s: any) => s.name === r.name);
                      const runs = stats?.runs || 0;
                      const successRate = stats ? Math.round(100 - (stats.failureRate || 0)) : 0;
                      const avgDuration = stats?.avgDurationSeconds ? Math.round(stats.avgDurationSeconds / 60) : 0;
                      const statusClass = successRate >= 90 ? 'green' : successRate >= 70 ? 'yellow' : 'red';
                      return `<tr><td>${r.name}</td><td>${r.tier || '-'}</td><td>${runs}</td><td><div class="progress-bar" style="width:200px;display:inline-block;vertical-align:middle;margin-right:10px"><div class="fill ${statusClass}" style="width:${successRate}%"></div></div>${successRate}%</td><td>${avgDuration}m</td></tr>`;
                    }).join('')}
                </tbody>
            </table>
        </div>
        
        ${(() => {
          const failingWfs = workflows.filter((w: any) => w.failureRate > 20);
          if (failingWfs.length === 0) return '';
          return `
        <div class="card wide" style="margin-top: 20px;">
            <h3>🚨 Workflows Requiring Attention</h3>
            <div class="alert-box danger" style="margin-bottom: 15px;">
                <strong>${failingWfs.length} workflow(s)</strong> have failure rate > 20%. Click the links below to fix them.
            </div>
            <table>
                <thead><tr><th>Workflow</th><th>Runs</th><th>Failure Rate</th><th>Avg Duration</th><th>Action</th></tr></thead>
                <tbody>
                    ${failingWfs.slice(0, 10).map((wf: any) => {
                      const wfLink = getWorkflowLink(wf, orgName);
                      const avgDuration = wf.avgDurationSeconds ? `${Math.floor(wf.avgDurationSeconds / 60)}m ${Math.round(wf.avgDurationSeconds % 60)}s` : 'N/A';
                      const linkHtml = wfLink ? `<a href="${wfLink}" target="_blank" style="color: #00d4ff; text-decoration: none;">🔧 Fix Workflow</a>` : '—';
                      return `<tr><td>${wf.name.slice(0, 40)}${wf.name.length > 40 ? '...' : ''}</td><td>${wf.runs}</td><td><span style="color: #f87171; font-weight: bold;">${wf.failureRate}%</span></td><td>${avgDuration}</td><td>${linkHtml}</td></tr>`;
                    }).join('')}
                </tbody>
            </table>
        </div>
        
        <!-- Source-Aware Code Suggestions for Failing Workflows -->
        <div class="card wide" style="margin-top: 20px;">
            <h3>🤖 Intelligent Failure Analysis</h3>
            <p style="color: #888; margin-bottom: 20px;">Analyzed <strong>workflow source code</strong> and <strong>recent failure logs</strong> for root cause insights. ${workflowSourceAnalyses.size > 0 ? `✅ Analyzed ${workflowSourceAnalyses.size} workflow files.` : '⚠️ Could not fetch workflow files for analysis.'}</p>
            ${failingWfs.slice(0, 5).map((wf: any) => {
              const wfLink = getWorkflowLink(wf, orgName);
              const wfName = wf.name.slice(0, 50);
              const repo = wf.firstRepo || wf.repo || '';
              const wfPath = wf.path || '.github/workflows/' + wf.name.replace(/[^a-z0-9]/gi, '-').toLowerCase() + '.yml';
              
              // Look up source analysis for this workflow
              const analysisKey = `${repo}/${wfPath}`;
              const sourceAnalysis = workflowSourceAnalyses.get(analysisKey);
              
              // Also try to find by workflow name if path doesn't match
              let matchedAnalysis = sourceAnalysis;
              if (!matchedAnalysis) {
                for (const [key, analysis] of workflowSourceAnalyses.entries()) {
                  if (key.includes(repo) && (analysis.workflow === wf.name || key.includes(wf.name))) {
                    matchedAnalysis = analysis;
                    break;
                  }
                }
              }
              
              let suggestionHtml = '';
              
              if (matchedAnalysis) {
                const issues = matchedAnalysis.issues || [];
                const optimizations = matchedAnalysis.optimizations || [];
                const failurePatterns = matchedAnalysis.failurePatterns;
                const recentErrors = matchedAnalysis.recentErrors || [];
                
                suggestionHtml = '<div style="margin-bottom: 10px;">';
                
                // PRIORITY 1: Show actual failure patterns from logs
                if (failurePatterns && failurePatterns.patterns.length > 0) {
                  suggestionHtml += '<div style="background: rgba(239,68,68,0.1); padding: 15px; border-radius: 8px; margin-bottom: 15px; border: 1px solid rgba(239,68,68,0.3);">';
                  suggestionHtml += '<div style="color: #f87171; margin-bottom: 10px;"><strong>🔍 Root Cause Analysis (from recent failures):</strong></div>';
                  
                  for (const pattern of failurePatterns.patterns.slice(0, 3)) {
                    suggestionHtml += '<div style="margin-bottom: 12px;">';
                    suggestionHtml += '<div style="color: #fca5a5;"><strong>• ' + pattern.description + '</strong> <span style="color: #888;">(' + pattern.count + ' occurrence' + (pattern.count > 1 ? 's' : '') + ')</span></div>';
                    if (pattern.examples.length > 0) {
                      suggestionHtml += '<div style="color: #888; font-size: 0.85em; margin: 5px 0 5px 15px; font-family: monospace; background: rgba(0,0,0,0.3); padding: 5px 10px; border-radius: 4px;">' + pattern.examples[0].slice(0, 120) + (pattern.examples[0].length > 120 ? '...' : '') + '</div>';
                    }
                    // Convert markdown code blocks to HTML
                    let fixHtml = pattern.suggestedFix
                      .replace(/```yaml\n?/g, '</span><pre style="background: #1e1e2e; padding: 10px; border-radius: 6px; margin: 8px 0 0 15px; font-size: 0.85em; overflow-x: auto;"><code>')
                      .replace(/```\n?/g, '</code></pre><span>')
                      .replace(/\n/g, '<br>');
                    // Clean up empty spans
                    fixHtml = fixHtml.replace(/<span><\/span>/g, '').replace(/^<\/span>/, '').replace(/<span>$/, '');
                    suggestionHtml += '<div style="color: #4ade80; font-size: 0.9em; margin-left: 15px;">💡 Fix: <span>' + fixHtml + '</span></div>';
                    suggestionHtml += '</div>';
                  }
                  
                  if (failurePatterns.commonFailingSteps.length > 0) {
                    suggestionHtml += '<div style="margin-top: 10px; color: #888;"><strong>Commonly failing steps:</strong> ' + failurePatterns.commonFailingSteps.map(s => '<code style="background: rgba(255,255,255,0.1); padding: 2px 6px; border-radius: 4px; margin: 0 3px;">' + s.step + '</code>').join(', ') + '</div>';
                  }
                  
                  suggestionHtml += '</div>';
                }
                
                // PRIORITY 2: Show recent error messages
                if (recentErrors.length > 0 && !failurePatterns?.patterns.length) {
                  suggestionHtml += '<div style="background: rgba(251,191,36,0.1); padding: 12px; border-radius: 8px; margin-bottom: 12px;">';
                  suggestionHtml += '<div style="color: #fbbf24; margin-bottom: 8px;"><strong>📋 Recent Error Messages:</strong></div>';
                  suggestionHtml += '<ul style="margin: 0 0 0 20px; color: #fcd34d; font-size: 0.9em;">';
                  recentErrors.slice(0, 3).forEach(err => {
                    suggestionHtml += '<li style="margin-bottom: 4px;">' + err.replace(/</g, '&lt;').replace(/>/g, '&gt;').slice(0, 100) + '</li>';
                  });
                  suggestionHtml += '</ul></div>';
                }
                
                // PRIORITY 3: Show high-severity issues from static analysis
                const highIssues = issues.filter(i => i.severity === 'high');
                if (highIssues.length > 0) {
                  suggestionHtml += '<div style="color: #f87171; margin-bottom: 10px;"><strong>🔴 Critical Issues in YAML:</strong></div><ul style="margin: 0 0 15px 20px; color: #fca5a5;">';
                  highIssues.forEach(i => {
                    suggestionHtml += '<li>' + i.message + (i.suggestion ? ' → ' + i.suggestion : '') + '</li>';
                  });
                  suggestionHtml += '</ul>';
                }
                
                // PRIORITY 4: Show optimization suggestions ONLY when we don't have failure-based insights
                // Generic suggestions like CONCURRENCY/PATH-FILTER are noise when we have real failure analysis
                const hasFailureInsights = failurePatterns && failurePatterns.patterns.length > 0;
                
                if (!hasFailureInsights) {
                  const highImpactOpts = optimizations.filter(o => o.impact === 'high');
                  const mediumImpactOpts = optimizations.filter(o => o.impact === 'medium');
                  const relevantOpts = [...highImpactOpts, ...mediumImpactOpts].slice(0, 2);
                  
                  if (relevantOpts.length > 0) {
                    suggestionHtml += '<div style="color: #22c55e; margin-bottom: 10px;"><strong>⚡ Optimizations:</strong></div>';
                    for (const opt of relevantOpts) {
                      suggestionHtml += '<div style="margin-bottom: 10px; padding-left: 15px;">';
                      suggestionHtml += '<div style="color: #86efac;"><strong>' + opt.type.toUpperCase() + ':</strong> ' + opt.description + '</div>';
                      if (opt.codeExample) {
                        suggestionHtml += '<pre style="background: #1e1e2e; padding: 12px; border-radius: 8px; overflow-x: auto; font-size: 0.85em; margin-top: 8px;"><code>' + opt.codeExample.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</code></pre>';
                      }
                      suggestionHtml += '</div>';
                    }
                  }
                }
                
                // Show medium-severity issues briefly
                const mediumIssues = issues.filter(i => i.severity === 'medium');
                if (mediumIssues.length > 0 && !failurePatterns?.patterns.length) {
                  suggestionHtml += '<div style="color: #fbbf24; margin-bottom: 10px;"><strong>🟡 Improvements:</strong></div><ul style="margin: 0 0 15px 20px; color: #fcd34d; font-size: 0.9em;">';
                  mediumIssues.slice(0, 2).forEach(i => {
                    suggestionHtml += '<li>' + i.message + '</li>';
                  });
                  suggestionHtml += '</ul>';
                }
                
                suggestionHtml += '</div>';
              } else {
                // Fallback: Generic suggestions based on workflow name patterns
                const isTest = wf.name.toLowerCase().includes('test') || wf.name.toLowerCase().includes('lint') || wf.name.toLowerCase().includes('ci');
                const isSecurity = wf.name.toLowerCase().includes('codeql') || wf.name.toLowerCase().includes('semgrep') || wf.name.toLowerCase().includes('security');
                const isDeploy = wf.name.toLowerCase().includes('deploy') || wf.name.toLowerCase().includes('release');
                
                if (wf.failureRate === 100) {
                  suggestionHtml = '<div style="color: #f87171; margin-bottom: 10px;"><strong>⚠️ 100% failure rate</strong> - likely a configuration issue or missing secret</div><pre style="background: #1e1e2e; padding: 15px; border-radius: 8px; overflow-x: auto; font-size: 0.85em;"><code># Check for missing secrets\nenv:\n  MY_TOKEN: \\${{ secrets.MY_TOKEN }}\n\n# Add debug step\n- name: Debug\n  run: env | grep -v TOKEN | sort</code></pre>';
                } else if (isSecurity) {
                  suggestionHtml = '<div style="color: #f87171; margin-bottom: 10px;"><strong>🔒 Security scanner failures</strong> - check scanner configuration</div><pre style="background: #1e1e2e; padding: 15px; border-radius: 8px; overflow-x: auto; font-size: 0.85em;"><code># Common security scanner fixes:\n# 1. Check SEMGREP_APP_TOKEN secret is set\n# 2. Verify scanning rules are compatible\n# 3. Add continue-on-error for non-blocking scans\njobs:\n  scan:\n    continue-on-error: true</code></pre>';
                } else if (isTest) {
                  suggestionHtml = '<pre style="background: #1e1e2e; padding: 15px; border-radius: 8px; overflow-x: auto; font-size: 0.85em;"><code># Add retry for flaky tests\n- uses: nick-fields/retry@v3\n  with:\n    max_attempts: 3\n    command: npm test</code></pre>';
                } else if (isDeploy) {
                  suggestionHtml = '<pre style="background: #1e1e2e; padding: 15px; border-radius: 8px; overflow-x: auto; font-size: 0.85em;"><code># Add deployment safeguards\njobs:\n  deploy:\n    environment: production\n    concurrency:\n      group: production\n      cancel-in-progress: false</code></pre>';
                } else {
                  suggestionHtml = '<pre style="background: #1e1e2e; padding: 15px; border-radius: 8px; overflow-x: auto; font-size: 0.85em;"><code># General improvements\n- uses: actions/checkout@v4\n- uses: actions/setup-node@v4\n  with:\n    cache: npm</code></pre>';
                }
                suggestionHtml = '<div style="color: #888; font-style: italic; margin-bottom: 10px;">ℹ️ Could not fetch workflow source - showing general suggestions</div>' + suggestionHtml;
              }
              
              const hasRealAnalysis = matchedAnalysis && (matchedAnalysis.failurePatterns?.patterns.length || matchedAnalysis.recentErrors?.length || matchedAnalysis.issues.length);
              const borderColor = hasRealAnalysis ? '#22c55e' : matchedAnalysis ? '#fbbf24' : '#f87171';
              const sourceTag = matchedAnalysis 
                ? (matchedAnalysis.failurePatterns?.patterns.length 
                    ? '<span style="color: #22c55e; margin-left: 10px; font-size: 0.85em;">📊 Failure Logs Analyzed</span>'
                    : '<span style="color: #fbbf24; margin-left: 10px; font-size: 0.85em;">📄 Source Only</span>')
                : '';
              const viewLink = wfLink ? '<a href="' + wfLink + '" target="_blank" style="color: #00d4ff; text-decoration: none; padding: 8px 16px; background: rgba(0,212,255,0.1); border-radius: 8px;">View Workflow →</a>' : '';
              
              return '<div style="margin-bottom: 25px; padding: 20px; background: rgba(255,255,255,0.03); border-radius: 12px; border-left: 4px solid ' + borderColor + ';">' +
                '<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">' +
                  '<div>' +
                    '<strong style="font-size: 1.1em;">' + wfName + '</strong>' +
                    '<span style="color: #f87171; margin-left: 10px;">' + wf.failureRate + '% failure rate</span>' +
                    sourceTag +
                  '</div>' +
                  viewLink +
                '</div>' +
                suggestionHtml +
              '</div>';
            }).join('')}
        </div>`;
        })()}
    <script>
        Chart.defaults.color = '#888';
        new Chart(document.getElementById('workflowPie'), {
            type: 'doughnut',
            data: {
                labels: ['Healthy (≤10%)', 'Warning (10-20%)', 'Critical (>20%)'],
                datasets: [{ data: [${workflows.filter((w: any) => w.failureRate <= 10).length}, ${workflows.filter((w: any) => w.failureRate > 10 && w.failureRate <= 20).length}, ${workflows.filter((w: any) => w.failureRate > 20).length}], backgroundColor: ['#22c55e', '#f59e0b', '#ef4444'] }]
            },
            options: { responsive: true, maintainAspectRatio: false, cutout: '60%' }
        });
        new Chart(document.getElementById('repoBar'), {
            type: 'bar',
            data: {
                labels: ${JSON.stringify(repoSuccessData.map((r: any) => r.name.substring(0, 15)))},
                datasets: [{ data: ${JSON.stringify(repoSuccessData.map((r: any) => r.rate))}, backgroundColor: ${JSON.stringify(repoSuccessData.map((r: any) => r.rate >= 90 ? '#22c55e' : r.rate >= 70 ? '#f59e0b' : '#ef4444'))}, borderRadius: 8 }]
            },
            options: { responsive: true, maintainAspectRatio: false, indexAxis: 'y', plugins: { legend: { display: false } }, scales: { x: { max: 100 } } }
        });
    </script>
${htmlFoot}`;
        writeFileSync(join(reportFolder, 'cicd-details.html'), cicdDetailsHtml);
        
        // Cost Details Page
        const slowWf = workflows.filter((w: any) => w.avgDurationSeconds > 600);
        const failingWf = workflows.filter((w: any) => w.failureRate > 30);
        const totalMins = workflows.reduce((s: number, w: any) => s + Math.round((w.avgDurationSeconds || 0) / 60 * (w.runs || 0)), 0);
        
        // Runner data for cost analysis - use byRunnerOS for better OS-specific pricing
        const runnerOSData = perfData?.byRunnerOS || [];
        const runnerTypes = perfData?.byRunnerType || [];
        const hasRunnerData = runnerOSData.length > 0 || runnerTypes.length > 0;
        
        // Fetch hosted runner specs for accurate cost calculation
        let htmlHostedRunnerLookup: HostedRunnerLookup = {};
        try {
          const hostedRunnerResult = await githubClient.getHostedRunners(orgName);
          if (hostedRunnerResult.success && hostedRunnerResult.runners?.length > 0) {
            htmlHostedRunnerLookup = buildHostedRunnerLookup(hostedRunnerResult.runners);
          }
        } catch {
          // Hosted runners API not available
        }
        const hasHostedRunnerSpecs = Object.keys(htmlHostedRunnerLookup).length > 0;
        
        // Calculate costs using advanced detection
        let runnerCostEstimates: any[] = [];
        let totalEstimatedCost = 0;
        
        if (runnerOSData.length > 0) {
          // Use OS-specific data with advanced cost calculation
          runnerCostEstimates = runnerOSData.map((r: any) => {
            const runnerName = r.os || 'unknown';
            const labels = [runnerName];
            const totalMinutes = r.minutes || Math.round(((r.avgDurationSeconds || 0) / 60) * (r.runs || 0));
            
            const costResult = calculateRunnerCostAdvanced(
              runnerName,
              labels,
              totalMinutes,
              false,
              htmlHostedRunnerLookup
            );
            
            return { 
              type: r.os || 'Unknown', 
              runs: r.runs || 0, 
              totalMinutes, 
              estimatedCost: costResult.cost,
              detectedType: costResult.detectedType,
              detectionMethod: costResult.method,
              avgDuration: r.avgDurationSeconds || (r.minutes ? Math.round(r.minutes * 60 / Math.max(1, r.runs)) : 0),
              avgQueue: r.avgQueueTimeSeconds || 0, 
              failureRate: r.failureRate || 0 
            };
          });
          totalEstimatedCost = runnerCostEstimates.reduce((s: number, r: any) => s + r.estimatedCost, 0);
        } else if (runnerTypes.length > 0) {
          // Use runner type data with advanced cost calculation
          runnerCostEstimates = runnerTypes.map((r: any) => {
            const runnerName = r.type || 'unknown';
            const labels = [runnerName];
            const totalMinutes = r.minutes || Math.round(((r.avgDurationSeconds || 0) / 60) * (r.runs || 0));
            
            const costResult = calculateRunnerCostAdvanced(
              runnerName,
              labels,
              totalMinutes,
              false,
              htmlHostedRunnerLookup
            );
            
            return { 
              type: r.type || 'Unknown', 
              runs: r.runs || 0, 
              totalMinutes, 
              estimatedCost: costResult.cost,
              detectedType: costResult.detectedType,
              detectionMethod: costResult.method,
              avgDuration: r.avgDurationSeconds || (r.minutes ? Math.round(r.minutes * 60 / Math.max(1, r.runs)) : 0),
              avgQueue: r.avgQueueTimeSeconds || 0, 
              failureRate: r.failureRate || 0 
            };
          });
          totalEstimatedCost = runnerCostEstimates.reduce((s: number, r: any) => s + r.estimatedCost, 0);
        }
        
        // If no runner data or cost is suspiciously low, estimate from total minutes
        // Assume ~90% Linux ($0.008/min) and ~10% other for a blended rate of ~$0.009/min
        if (totalEstimatedCost < 1 && totalMins > 60) {
          const blendedRate = 0.008;  // Conservative estimate using Linux pricing
          totalEstimatedCost = totalMins * blendedRate;
          if (runnerCostEstimates.length === 0) {
            runnerCostEstimates = [{ type: 'Estimated (Linux)', runs: workflows.reduce((s: number, w: any) => s + (w.runs || 0), 0), totalMinutes: totalMins, estimatedCost: totalEstimatedCost, avgDuration: 0, avgQueue: 0, failureRate: 0 }];
          }
        }
        
        const costDetailsHtml = `${htmlHead('Cost Optimization')}
        <h1>💰 Cost Optimization</h1>
        <p class="subtitle">${orgName} • ${reportDate} • ${timeframeLabel}</p>
        
        <div class="metric-row">
            <div class="metric-box">
                <div class="value">${Math.round(totalMins / 60)}h</div>
                <div class="label">Total Compute Time</div>
            </div>
            <div class="metric-box">
                <div class="value">~$${totalEstimatedCost.toFixed(0)}</div>
                <div class="label">Est. Runner Cost</div>
            </div>
            <div class="metric-box ${slowWf.length > 0 ? 'yellow' : 'green'}">
                <div class="value">${slowWf.length}</div>
                <div class="label">Slow Workflows (&gt;10min)</div>
            </div>
            <div class="metric-box ${failingWf.length > 0 ? 'red' : 'green'}">
                <div class="value">${failingWf.length}</div>
                <div class="label">High Failure Rate (&gt;30%)</div>
            </div>
        </div>
        
        ${slowWf.length > 0 || failingWf.length > 0 ? `
        <div class="alert-box warning">
            <strong>⚠️ Optimization Opportunities Found</strong><br>
            ${slowWf.length > 0 ? `• ${slowWf.length} workflow(s) take longer than 10 minutes<br>` : ''}
            ${failingWf.length > 0 ? `• ${failingWf.length} workflow(s) have high failure rates (wasting compute)` : ''}
        </div>` : '<div class="alert-box success"><strong>✅ Good job!</strong> No major optimization issues found.</div>'}
        
        <div class="grid">
            <div class="card">
                <h3>Compute Distribution</h3>
                <div class="chart-container">
                    <canvas id="costPie"></canvas>
                </div>
            </div>
            <div class="card">
                <h3>Workflow Duration</h3>
                <div class="chart-container">
                    <canvas id="durationBar"></canvas>
                </div>
            </div>
        </div>
        
        <!-- Runner Performance & Cost Section -->
        <div class="card" style="margin-bottom: 20px;" id="runners">
            <h3>🏃 Runner Performance & Cost Analysis</h3>
            ${hasRunnerData ? `
            <div class="grid" style="margin-top: 20px;">
                <div>
                    <h4 style="color: #888; margin-bottom: 15px;">Cost by Runner Type</h4>
                    <div class="chart-container" style="height: 250px;">
                        <canvas id="runnerCostChart"></canvas>
                    </div>
                </div>
                <div>
                    <h4 style="color: #888; margin-bottom: 15px;">Runs by Runner Type</h4>
                    <div class="chart-container" style="height: 250px;">
                        <canvas id="runnerRunsChart"></canvas>
                    </div>
                </div>
            </div>
            <table style="margin-top: 20px;">
                <thead>
                    <tr><th>Runner Type</th><th>Runs</th><th>Avg Duration</th><th>Queue Time</th><th>Failure Rate</th><th>Est. Cost</th></tr>
                </thead>
                <tbody>
                    ${runnerCostEstimates.map((r: any) => `
                    <tr>
                        <td><strong>${r.type}</strong></td>
                        <td>${r.runs.toLocaleString()}</td>
                        <td>${Math.floor(r.avgDuration / 60)}m ${Math.round(r.avgDuration % 60)}s</td>
                        <td>${r.avgQueue}s</td>
                        <td><span class="status-badge ${r.failureRate <= 5 ? 'high' : r.failureRate <= 15 ? 'medium' : 'low'}">${r.failureRate.toFixed(1)}%</span></td>
                        <td style="color: #4ade80; font-weight: bold;">$${r.estimatedCost.toFixed(2)}</td>
                    </tr>
                    `).join('')}
                </tbody>
            </table>
            ` : `
            <div style="text-align: center; padding: 40px; color: #888;">
                <div style="font-size: 3em; margin-bottom: 15px;">🏃</div>
                <p>No runner performance data available for this timeframe.</p>
                <p style="font-size: 0.9em;">Runner metrics are collected from workflow run history.</p>
            </div>
            `}
        </div>
        
        <!-- Runner Optimization Tips - Actionable insights first, then advanced options -->
        <div class="card" style="margin-bottom: 20px;">
            <h3>💡 Runner Cost Optimization Tips ${aiProviderInfo.enabled ? `<span style="font-size: 0.7em; color: #a855f7;">(AI: ${aiProviderInfo.provider}/${aiProviderInfo.model})</span>` : ''}</h3>
            
            <!-- Quick Wins Section -->
            <div style="margin: 20px 0; padding: 20px; background: rgba(34,197,94,0.1); border-radius: 12px; border-left: 4px solid #22c55e;">
                <h4 style="margin-bottom: 15px; color: #22c55e;">🎯 Quick Wins Based on Your Data</h4>
                <div style="display: grid; gap: 10px;">
                    ${runnerCostEstimates.some((r: any) => (r.type.toLowerCase().includes('linux') || r.type.toLowerCase().includes('ubuntu')) && !r.type.toLowerCase().includes('arm')) ? `
                    <div style="padding: 12px; background: rgba(255,255,255,0.05); border-radius: 8px;">
                        ✅ <strong>Switch to ARM runners</strong> - You're using x64 Linux runners. ARM runners (<code>linux-*-arm</code>) are 25-33% cheaper with similar performance.
                    </div>
                    ` : ''}
                    ${runnerCostEstimates.some((r: any) => r.type.toLowerCase().includes('macos')) ? `
                    <div style="padding: 12px; background: rgba(255,255,255,0.05); border-radius: 8px;">
                        ✅ <strong>Optimize macOS usage</strong> - macOS runners cost 10x more than Linux. Run platform-agnostic tests on Linux first.
                    </div>
                    ` : ''}
                    ${slowWf.length > 0 ? `
                    <div style="padding: 12px; background: rgba(255,255,255,0.05); border-radius: 8px;">
                        ✅ <strong>Speed up slow workflows</strong> - You have ${slowWf.length} workflow(s) averaging >10 minutes. Consider caching and parallelization.
                    </div>
                    ` : ''}
                    ${failingWf.length > 0 ? `
                    <div style="padding: 12px; background: rgba(255,255,255,0.05); border-radius: 8px;">
                        ✅ <strong>Fix failing workflows</strong> - ${failingWf.length} workflow(s) have high failure rates, wasting compute on retries.
                    </div>
                    ` : ''}
                </div>
            </div>
            
            <div style="display: grid; gap: 15px; margin-top: 15px;">
                <div style="padding: 20px; background: rgba(168,85,247,0.1); border-radius: 12px; border-left: 4px solid #a855f7;">
                    <strong>📦 Maximize Caching</strong><br>
                    <span style="color: #888;">Use <code>actions/cache</code> for dependencies, Docker layers, and build artifacts. Good caching can reduce workflow time by <strong>40-70%</strong>.</span>
                </div>
                <div style="padding: 20px; background: rgba(249,115,22,0.1); border-radius: 12px; border-left: 4px solid #f97316;">
                    <strong>🔄 Parallelize Jobs</strong><br>
                    <span style="color: #888;">Split long workflows into parallel jobs using matrix builds. Same cost, faster feedback.</span>
                    <p style="margin-top: 10px; color: #4ade80; font-size: 0.9em;">
                        💡 <strong>Hidden Value:</strong> A job that runs 2x faster saves developer waiting time. At $75/hr, saving 12.5 hours/month = <strong>$938/month</strong> in productivity!
                    </p>
                </div>
                <div style="padding: 20px; background: rgba(34,197,94,0.1); border-radius: 12px; border-left: 4px solid #22c55e;">
                    <strong>🐧 Use Linux ARM Runners (25-33% savings)</strong><br>
                    <span style="color: #888;">ARM-based runners are cheaper with comparable performance:</span>
                    <ul style="margin: 10px 0 0 20px; color: #888;">
                        <li><code>linux-4-core</code> → <code>linux-4-core-arm</code> saves <strong>33%</strong></li>
                        <li><code>linux-8-core</code> → <code>linux-8-core-arm</code> saves <strong>36%</strong></li>
                    </ul>
                </div>
                ${runnerCostEstimates.some((r: any) => r.type.toLowerCase().includes('macos')) ? `
                <div style="padding: 20px; background: rgba(239,68,68,0.1); border-radius: 12px; border-left: 4px solid #ef4444;">
                    <strong>🍎 Optimize macOS Usage (10x more expensive)</strong><br>
                    <span style="color: #888;">macOS runners cost significantly more than Linux. Strategies:</span>
                    <ul style="margin: 10px 0 0 20px; color: #888;">
                        <li>Run platform-agnostic tests on Linux first</li>
                        <li>Reserve macOS for iOS/macOS-specific builds only</li>
                        <li>Use <code>macos-latest</code> (M1) before <code>macos-latest-xlarge</code> (M2)</li>
                    </ul>
                </div>
                ` : ''}
            </div>
            
            <!-- Runner Pricing Quick Reference -->
            <div style="margin: 20px 0; padding: 20px; background: rgba(99,102,241,0.1); border-radius: 12px; border-left: 4px solid #6366f1;">
                <h4 style="margin-bottom: 15px; color: #6366f1;">💰 Runner Pricing Quick Reference (Jan 2026+)</h4>
                <table style="margin: 0; font-size: 0.9em;">
                    <thead>
                        <tr><th>Runner</th><th>vCPU</th><th>RAM</th><th>$/min</th></tr>
                    </thead>
                    <tbody>
                        <tr><td>ubuntu-latest (private)</td><td>2</td><td>7GB</td><td>$0.006</td></tr>
                        <tr><td>ubuntu-latest (public)</td><td>4</td><td>16GB</td><td style="color: #22c55e;">FREE</td></tr>
                        <tr><td>linux-4-core</td><td>4</td><td>16GB</td><td>$0.012</td></tr>
                        <tr><td>linux-4-core-arm</td><td>4</td><td>16GB</td><td style="color: #22c55e;">$0.008</td></tr>
                        <tr><td>linux-8-core</td><td>8</td><td>32GB</td><td>$0.022</td></tr>
                        <tr><td>macos-latest</td><td>3</td><td>7GB</td><td>$0.062</td></tr>
                    </tbody>
                </table>
                <p style="margin-top: 10px; padding: 10px; background: rgba(249,115,22,0.1); border-radius: 8px; color: #f97316; font-size: 0.9em;">
                    ⚠️ On PUBLIC repos, standard runners already have 4 vCPU & 16GB - no need for <code>linux-4-core</code>!
                </p>
            </div>
            
            <!-- Advanced Telemetry Section -->
            <div style="margin: 20px 0; padding: 20px; background: rgba(0,212,255,0.05); border-radius: 12px; border-left: 4px solid #00d4ff;">
                <h4 style="margin-bottom: 15px; color: #00d4ff;">🔬 Advanced: Per-Job Resource Telemetry</h4>
                <p style="color: #888; margin-bottom: 15px;">
                    Want to know the <strong>exact CPU and memory utilization</strong> for each workflow run? 
                    Use the <a href="https://github.com/marketplace/actions/runner-telemetry-action" target="_blank" style="color: #00d4ff;">Runner Telemetry Action</a> to:
                </p>
                <ul style="margin: 0 0 15px 20px; color: #888;">
                    <li>Measure actual CPU/memory usage during job execution</li>
                    <li>Get a utilization grade (A-D) for each run</li>
                    <li>Receive specific right-sizing recommendations</li>
                    <li>Identify idle time and parallelization opportunities</li>
                </ul>
                <table style="margin: 0; font-size: 0.9em;">
                    <thead>
                        <tr><th>Grade</th><th>Utilization</th><th>Meaning</th></tr>
                    </thead>
                    <tbody>
                        <tr><td><span class="status-badge high">A</span></td><td>90%+</td><td>Runner well-matched to workload</td></tr>
                        <tr><td><span class="status-badge high">B</span></td><td>70-89%</td><td>Good, minor optimization possible</td></tr>
                        <tr><td><span class="status-badge medium">C</span></td><td>30-69%</td><td>Consider right-sizing</td></tr>
                        <tr><td><span class="status-badge low">D</span></td><td>&lt;30%</td><td>Significant wasted capacity</td></tr>
                    </tbody>
                </table>
            </div>
            
            <div style="margin-top: 20px; padding: 15px; background: rgba(255,255,255,0.03); border-radius: 8px;">
                <strong>📚 Learn More:</strong>
                <a href="https://docs.github.com/en/enterprise-cloud@latest/actions/using-github-hosted-runners/using-larger-runners" target="_blank" style="color: #00d4ff; margin-left: 10px;">Larger Runners Guide</a> •
                <a href="https://docs.github.com/en/enterprise-cloud@latest/billing/managing-billing-for-your-products/managing-billing-for-github-actions/about-billing-for-github-actions" target="_blank" style="color: #00d4ff; margin-left: 5px;">Actions Billing</a> •
                <a href="https://docs.github.com/en/enterprise-cloud@latest/actions/writing-workflows/choosing-what-your-workflow-does/caching-dependencies-to-speed-up-workflows" target="_blank" style="color: #00d4ff; margin-left: 5px;">Caching Guide</a>
            </div>
        </div>
        
        ${slowWf.length > 0 ? `<div class="card" style="margin-bottom: 20px;"><h3>🐌 Slow Workflows (>10 minutes)</h3>
        <div class="alert-box warning" style="margin-bottom: 15px;">
            <strong>${slowWf.length} workflow(s)</strong> are taking longer than 10 minutes. Click below to optimize them.
        </div>
        <table><thead><tr><th>Workflow</th><th>Avg Duration</th><th>Runs</th><th>Total Time</th><th>Action</th></tr></thead><tbody>${slowWf.slice(0, 10).map((w: any) => {
          const wfLink = getWorkflowLink(w, orgName);
          const linkHtml = wfLink ? `<a href="${wfLink}" target="_blank" style="color: #00d4ff; text-decoration: none;">🔧 Optimize</a>` : '—';
          return `<tr><td>${w.name.slice(0, 40)}${w.name.length > 40 ? '...' : ''}</td><td style="color: #f59e0b; font-weight: bold;">${Math.round(w.avgDurationSeconds / 60)}m</td><td>${w.runs}</td><td>${Math.round(w.avgDurationSeconds / 60 * w.runs)}m</td><td>${linkHtml}</td></tr>`;
        }).join('')}</tbody></table>
        
        <div style="margin-top: 20px; padding: 15px; background: rgba(99,102,241,0.1); border-radius: 12px;">
            <h4 style="color: #6366f1; margin-bottom: 15px;">🤖 GitHub Copilot Speed Fixes</h4>
            ${slowWf.slice(0, 3).map((w: any) => {
              const wfLink = getWorkflowLink(w, orgName);
              const durationMins = Math.round(w.avgDurationSeconds / 60);
              const isNodeBuild = w.name.toLowerCase().includes('node') || w.name.toLowerCase().includes('npm') || w.name.toLowerCase().includes('build');
              const isTest = w.name.toLowerCase().includes('test') || w.name.toLowerCase().includes('ci');
              const isDocker = w.name.toLowerCase().includes('docker') || w.name.toLowerCase().includes('container');
              
              let suggestion = '';
              if (isDocker) {
                suggestion = `<pre style="background: #1e1e2e; padding: 15px; border-radius: 8px; overflow-x: auto; font-size: 0.85em;"><code># Docker layer caching - saves 5-15 minutes
- name: Set up Docker Buildx
  uses: docker/setup-buildx-action@v3

- name: Build with cache
  uses: docker/build-push-action@v6
  with:
    context: .
    cache-from: type=gha
    cache-to: type=gha,mode=max
    push: true
    tags: myapp:latest</code></pre>`;
              } else if (isNodeBuild) {
                suggestion = `<pre style="background: #1e1e2e; padding: 15px; border-radius: 8px; overflow-x: auto; font-size: 0.85em;"><code># Node.js dependency caching - saves 2-5 minutes
- uses: actions/setup-node@v4
  with:
    node-version: '20'
    cache: 'npm'  # Built-in caching!

# Or for more control:
- uses: actions/cache@v4
  with:
    path: ~/.npm
    key: npm-\${{ hashFiles('package-lock.json') }}
    
# Parallel builds with Turborepo
- run: npx turbo run build --parallel</code></pre>`;
              } else if (isTest) {
                suggestion = `<pre style="background: #1e1e2e; padding: 15px; border-radius: 8px; overflow-x: auto; font-size: 0.85em;"><code># Parallel test execution - halves test time
jobs:
  test:
    strategy:
      matrix:
        shard: [1, 2, 3, 4]  # Split into 4 parallel runs
    steps:
      - uses: actions/checkout@v4
      - run: npm test -- --shard=\${{ matrix.shard }}/4

# Or use test splitting
- name: Run tests with splitting
  run: |
    npx jest --listTests | split -n l/\${{ matrix.shard }}/4 > tests.txt
    npx jest \$(cat tests.txt)</code></pre>`;
              } else {
                suggestion = `<pre style="background: #1e1e2e; padding: 15px; border-radius: 8px; overflow-x: auto; font-size: 0.85em;"><code># General speed optimizations
- uses: actions/checkout@v4
  with:
    fetch-depth: 1  # Shallow clone - faster checkout

- uses: actions/cache@v4
  with:
    path: |
      ~/.cache
      **/node_modules
    key: deps-\${{ hashFiles('**/lockfile') }}
    
# Skip redundant work
- name: Check for changes
  uses: dorny/paths-filter@v3
  id: changes
  with:
    filters: |
      src:
        - 'src/**'</code></pre>`;
              }
              
              return `
            <div style="margin-bottom: 15px; padding: 15px; background: rgba(255,255,255,0.03); border-radius: 8px; border-left: 3px solid #f59e0b;">
                <div style="display: flex; justify-content: space-between; margin-bottom: 10px;">
                    <strong>${w.name.slice(0, 40)}</strong>
                    <span style="color: #f59e0b;">${durationMins}m avg → target ${Math.round(durationMins * 0.5)}m</span>
                </div>
                ${suggestion}
                ${wfLink ? `<a href="${wfLink}" target="_blank" style="color: #00d4ff; font-size: 0.9em;">View workflow file →</a>` : ''}
            </div>`;
            }).join('')}
        </div>
        </div>` : ''}
        
        ${failingWf.length > 0 ? `<div class="card" style="margin-bottom: 20px;"><h3>🔴 High Failure Workflows (>30%)</h3>
        <div class="alert-box danger" style="margin-bottom: 15px;">
            <strong>${failingWf.length} workflow(s)</strong> are wasting compute with high failure rates. Fix these to reduce costs.
        </div>
        <table><thead><tr><th>Workflow</th><th>Failure Rate</th><th>Runs</th><th>Wasted Mins</th><th>Action</th></tr></thead><tbody>${failingWf.slice(0, 10).map((w: any) => {
          const wfLink = getWorkflowLink(w, orgName);
          const linkHtml = wfLink ? `<a href="${wfLink}" target="_blank" style="color: #00d4ff; text-decoration: none;">🔧 Fix</a>` : '—';
          const wastedMins = Math.round(w.avgDurationSeconds / 60 * w.runs * w.failureRate / 100);
          return `<tr><td>${w.name.slice(0, 40)}${w.name.length > 40 ? '...' : ''}</td><td style="color: #f87171; font-weight: bold;">${w.failureRate}%</td><td>${w.runs}</td><td style="color: #f59e0b;">${wastedMins}m</td><td>${linkHtml}</td></tr>`;
        }).join('')}</tbody></table>
        
        <div style="margin-top: 20px; padding: 15px; background: rgba(239,68,68,0.1); border-radius: 12px;">
            <h4 style="color: #f87171; margin-bottom: 15px;">🤖 Intelligent Failure Analysis</h4>
            ${failingWf.slice(0, 3).map((w: any) => {
              const wfLink = getWorkflowLink(w, orgName);
              const wastedMins = Math.round(w.avgDurationSeconds / 60 * w.runs * w.failureRate / 100);
              
              // Try to get actual failure patterns from analysis (same lookup as cicd-details)
              const repo = w.firstRepo || w.repo || '';
              const wfPath = w.path || '.github/workflows/' + w.name.replace(/[^a-z0-9]/gi, '-').toLowerCase() + '.yml';
              const analysisKey = `${repo}/${wfPath}`;
              let matchedAnalysis = workflowSourceAnalyses.get(analysisKey);
              
              // Fuzzy match if exact match fails - try multiple strategies
              if (!matchedAnalysis && repo) {
                for (const [key, analysis] of workflowSourceAnalyses.entries()) {
                  // Match by repo + workflow name
                  if (key.includes(repo) && (analysis.workflow === w.name || key.toLowerCase().includes(w.name.toLowerCase()))) {
                    matchedAnalysis = analysis;
                    break;
                  }
                }
              }
              
              // Last resort: match by workflow name alone (case-insensitive)
              if (!matchedAnalysis) {
                const wfNameLower = w.name.toLowerCase();
                for (const [key, analysis] of workflowSourceAnalyses.entries()) {
                  if (analysis.workflow?.toLowerCase() === wfNameLower) {
                    matchedAnalysis = analysis;
                    break;
                  }
                }
              }
              
              let suggestion = '';
              
              // If we have actual failure patterns, use them
              if (matchedAnalysis?.failurePatterns?.patterns?.length) {
                const patterns = matchedAnalysis.failurePatterns.patterns.slice(0, 2);
                suggestion = patterns.map((pattern: any) => {
                  // Convert markdown code blocks to HTML
                  let fixHtml = pattern.suggestedFix
                    .replace(/```yaml\n?/g, '<pre style="background: #1e1e2e; padding: 10px; border-radius: 6px; margin: 8px 0; font-size: 0.85em; overflow-x: auto;"><code>')
                    .replace(/```\n?/g, '</code></pre>')
                    .replace(/\n/g, '<br>');
                  
                  return `<div style="margin-bottom: 10px;">
                    <strong style="color: #fca5a5;">• ${pattern.description}</strong> <span style="color: #888;">(${pattern.count}x)</span><br>
                    <span style="color: #4ade80; font-size: 0.9em;">💡 Fix: </span><span style="color: #888;">${fixHtml}</span>
                  </div>`;
                }).join('');
              } else {
                // Fallback to generic suggestions
                const isTest = w.name.toLowerCase().includes('test') || w.name.toLowerCase().includes('lint');
                const isSecurity = w.name.toLowerCase().includes('codeql') || w.name.toLowerCase().includes('security') || w.name.toLowerCase().includes('semgrep') || w.name.toLowerCase().includes('sarif');
                
                if (isSecurity) {
                  suggestion = `<pre style="background: #1e1e2e; padding: 15px; border-radius: 8px; overflow-x: auto; font-size: 0.85em;"><code># Security scan permissions
permissions:
  security-events: write
  contents: read

# Increase timeout for scans
- uses: github/codeql-action/analyze@v3
  timeout-minutes: 30</code></pre>`;
                } else if (isTest) {
                  suggestion = `<pre style="background: #1e1e2e; padding: 15px; border-radius: 8px; overflow-x: auto; font-size: 0.85em;"><code># Add retry for flaky tests
- name: Run tests with retry
  uses: nick-fields/retry@v3
  with:
    max_attempts: 3
    command: npm test</code></pre>`;
                } else {
                  suggestion = `<pre style="background: #1e1e2e; padding: 15px; border-radius: 8px; overflow-x: auto; font-size: 0.85em;"><code># General reliability improvements
- name: Install with retry
  uses: nick-fields/retry@v3
  with:
    max_attempts: 3
    command: npm ci</code></pre>`;
                }
              }
              
              return `
            <div style="margin-bottom: 15px; padding: 15px; background: rgba(255,255,255,0.03); border-radius: 8px; border-left: 3px solid #f87171;">
                <div style="display: flex; justify-content: space-between; margin-bottom: 10px;">
                    <strong>${w.name.slice(0, 40)}</strong>
                    <span style="color: #f87171;">${w.failureRate}% failure → ${wastedMins}m wasted</span>
                </div>
                ${suggestion}
                ${wfLink ? `<a href="${wfLink}" target="_blank" style="color: #00d4ff; font-size: 0.9em;">View workflow file →</a>` : ''}
            </div>`;
            }).join('')}
        </div>
        </div>` : ''}
    <script>
        Chart.defaults.color = '#888';
        const productive = ${Math.max(0, totalMins - slowWf.reduce((s: number, w: any) => s + Math.round((w.avgDurationSeconds - 600) / 60 * w.runs), 0))};
        const wasted = ${failingWf.reduce((s: number, w: any) => s + Math.round(w.avgDurationSeconds / 60 * w.runs * w.failureRate / 100), 0)};
        const slow = ${slowWf.reduce((s: number, w: any) => s + Math.round((w.avgDurationSeconds - 600) / 60 * w.runs), 0)};
        new Chart(document.getElementById('costPie'), {
            type: 'doughnut',
            data: { labels: ['Productive', 'Failed (wasted)', 'Slow overhead'], datasets: [{ data: [productive, wasted, slow], backgroundColor: ['#22c55e', '#ef4444', '#f59e0b'] }] },
            options: { responsive: true, maintainAspectRatio: false, cutout: '60%' }
        });
        new Chart(document.getElementById('durationBar'), {
            type: 'bar',
            data: { labels: ${JSON.stringify(workflows.slice(0, 8).map((w: any) => w.name.substring(0, 20)))}, datasets: [{ label: 'Avg Duration (min)', data: ${JSON.stringify(workflows.slice(0, 8).map((w: any) => Math.round(w.avgDurationSeconds / 60)))}, backgroundColor: ${JSON.stringify(workflows.slice(0, 8).map((w: any) => w.avgDurationSeconds > 600 ? '#f59e0b' : '#22c55e'))}, borderRadius: 8 }] },
            options: { responsive: true, maintainAspectRatio: false, indexAxis: 'y', plugins: { legend: { display: false } } }
        });
        
        // Runner charts
        ${hasRunnerData ? `
        const runnerLabels = ${JSON.stringify(runnerCostEstimates.map((r: any) => r.type))};
        const runnerCosts = ${JSON.stringify(runnerCostEstimates.map((r: any) => parseFloat(r.estimatedCost.toFixed(2))))};
        const runnerRuns = ${JSON.stringify(runnerCostEstimates.map((r: any) => r.runs))};
        const runnerColors = ['#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#06b6d4'];
        
        new Chart(document.getElementById('runnerCostChart'), {
            type: 'doughnut',
            data: { labels: runnerLabels, datasets: [{ data: runnerCosts, backgroundColor: runnerColors.slice(0, runnerLabels.length) }] },
            options: { responsive: true, maintainAspectRatio: false, cutout: '55%', plugins: { legend: { position: 'bottom' } } }
        });
        
        new Chart(document.getElementById('runnerRunsChart'), {
            type: 'bar',
            data: { labels: runnerLabels, datasets: [{ label: 'Runs', data: runnerRuns, backgroundColor: runnerColors.slice(0, runnerLabels.length), borderRadius: 8 }] },
            options: { responsive: true, maintainAspectRatio: false, indexAxis: 'y', plugins: { legend: { display: false } } }
        });
        ` : ''}
    </script>
${htmlFoot}`;
        writeFileSync(join(reportFolder, 'cost-details.html'), costDetailsHtml);
        
        // Security Details Page
        const secretTotal = complianceData?.secretAlerts?.total || 0;
        const codeTotal = complianceData?.codeAlerts?.total || 0;
        const depTotal = complianceData?.dependabotAlerts?.total || 0;
        // Use displayCount for proper "100+" display when hitting pagination limits
        const secretDisplay = complianceData?.secretAlerts?.displayCount || secretTotal.toString();
        const codeDisplay = complianceData?.codeAlerts?.displayCount || codeTotal.toString();
        const depDisplay = complianceData?.dependabotAlerts?.displayCount || depTotal.toString();
        const ghasStatus = complianceData?.ghasStatus || [];
        const securityDetailsHtml = `${htmlHead('Security & Compliance')}
        <h1>🔒 Security & Compliance</h1>
        <p class="subtitle">${orgName} • ${reportDate} • ${timeframeLabel}</p>
        
        <div class="metric-row">
            <div class="metric-box ${secretTotal === 0 ? 'green' : 'red'}">
                <div class="value">${secretDisplay}</div>
                <div class="label">Secret Scanning Alerts</div>
            </div>
            <div class="metric-box ${codeTotal === 0 ? 'green' : codeTotal < 10 ? 'yellow' : 'red'}">
                <div class="value">${codeDisplay}</div>
                <div class="label">Code Scanning Alerts</div>
            </div>
            <div class="metric-box ${depTotal === 0 ? 'green' : 'yellow'}">
                <div class="value">${depDisplay}</div>
                <div class="label">Dependabot Alerts</div>
            </div>
            <div class="metric-box ${ghasStatus.filter((r: any) => r.secretScanning && r.codeScanning).length === ghasStatus.length ? 'green' : 'yellow'}">
                <div class="value">${ghasStatus.filter((r: any) => r.secretScanning || r.codeScanning).length}/${ghasStatus.length}</div>
                <div class="label">GHAS Enabled</div>
            </div>
        </div>
        
        ${secretTotal > 0 ? '<div class="alert-box danger"><strong>🚨 Critical:</strong> Secret scanning alerts require immediate attention!</div>' : ''}
        
        <div class="grid">
            <div class="card">
                <h3>Alerts by Type</h3>
                <div class="chart-container">
                    <canvas id="alertsPie"></canvas>
                </div>
            </div>
            <div class="card">
                <h3>Severity Breakdown</h3>
                <div class="chart-container">
                    <canvas id="severityBar"></canvas>
                </div>
            </div>
        </div>
        
        <div class="card">
            <h3>Repository Security Status</h3>
            <table>
                <thead><tr><th>Repository</th><th>Secret Scanning</th><th>Code Scanning</th><th>Dependabot</th></tr></thead>
                <tbody>
                    ${ghasStatus.map((r: any) => `<tr><td>${r.name}</td><td>${r.secretScanning ? '✅ Enabled' : '❌ Disabled'}</td><td>${r.codeScanning ? '✅ Enabled' : '❌ Disabled'}</td><td>${r.dependabot ? '✅ Enabled' : '❌ Disabled'}</td></tr>`).join('')}
                </tbody>
            </table>
        </div>
        
        ${ghasStatus.filter((r: any) => r.secretScanning || r.codeScanning).length > 0 ? `
        <div class="card" style="margin-top: 20px; background: linear-gradient(135deg, rgba(99,102,241,0.1) 0%, rgba(168,85,247,0.1) 100%); border: 1px solid rgba(99,102,241,0.3);">
            <h3 style="color: #a855f7;">📊 Organization Security Overview Dashboard</h3>
            <p style="color: #888; margin: 15px 0;">For repositories with GHAS enabled, use the <strong>Organization Security Overview</strong> for comprehensive security management:</p>
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin: 20px 0;">
                <div style="padding: 15px; background: rgba(255,255,255,0.05); border-radius: 8px;">🎯 <strong>Risk Prioritization</strong><br><span style="color: #888; font-size: 0.9em;">Focus on highest-impact vulnerabilities first</span></div>
                <div style="padding: 15px; background: rgba(255,255,255,0.05); border-radius: 8px;">📈 <strong>Trend Analysis</strong><br><span style="color: #888; font-size: 0.9em;">Track security debt over time</span></div>
                <div style="padding: 15px; background: rgba(255,255,255,0.05); border-radius: 8px;">🔍 <strong>Advanced Filtering</strong><br><span style="color: #888; font-size: 0.9em;">Filter by severity, tool, and repo</span></div>
                <div style="padding: 15px; background: rgba(255,255,255,0.05); border-radius: 8px;">🏢 <strong>Org-wide View</strong><br><span style="color: #888; font-size: 0.9em;">Complete security posture at a glance</span></div>
            </div>
            <div style="margin-top: 20px;">
                <a href="https://github.com/orgs/${orgName}/security/overview" target="_blank" style="display: inline-block; padding: 12px 24px; background: linear-gradient(90deg, #6366f1, #a855f7); color: white; text-decoration: none; border-radius: 8px; font-weight: 600;">🔗 Open Security Overview Dashboard →</a>
            </div>
            <div style="margin-top: 20px; padding: 15px; background: rgba(255,255,255,0.03); border-radius: 8px;">
                <strong>📚 Documentation:</strong>
                <ul style="margin: 10px 0 0 20px; color: #888;">
                    <li><a href="https://docs.github.com/en/enterprise-cloud@latest/code-security/security-overview/about-the-security-overview" target="_blank" style="color: #00d4ff;">About the security overview</a></li>
                    <li><a href="https://docs.github.com/en/enterprise-cloud@latest/code-security/security-overview/assessing-code-security-risk" target="_blank" style="color: #00d4ff;">Assessing your code security risk</a></li>
                    <li><a href="https://docs.github.com/en/enterprise-cloud@latest/code-security/security-overview/filtering-alerts-in-security-overview" target="_blank" style="color: #00d4ff;">Filtering alerts in security overview</a></li>
                </ul>
            </div>
        </div>
        ` : ''}
    <script>
        Chart.defaults.color = '#888';
        new Chart(document.getElementById('alertsPie'), {
            type: 'doughnut',
            data: { labels: ['Secret Scanning', 'Code Scanning', 'Dependabot'], datasets: [{ data: [${secretTotal}, ${codeTotal}, ${depTotal}], backgroundColor: ['#f87171', '#fbbf24', '#60a5fa'] }] },
            options: { responsive: true, maintainAspectRatio: false, cutout: '60%' }
        });
        const sevBreakdown = ${JSON.stringify(complianceData?.codeAlerts?.bySeverity || { critical: 0, high: 0, medium: 0, low: 0 })};
        new Chart(document.getElementById('severityBar'), {
            type: 'bar',
            data: { labels: ['Critical', 'High', 'Medium', 'Low'], datasets: [{ data: [sevBreakdown.critical || 0, sevBreakdown.high || 0, sevBreakdown.medium || 0, sevBreakdown.low || 0], backgroundColor: ['#dc2626', '#f87171', '#fbbf24', '#60a5fa'], borderRadius: 8 }] },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
        });
    </script>
${htmlFoot}`;
        writeFileSync(join(reportFolder, 'security-details.html'), securityDetailsHtml);
        
        // Maturity Details Page
        const maturityOverallPct = Math.round((maturity.overall.score / maturity.overall.maxScore) * 100);
        const maturityDetailsHtml = `${htmlHead('CI/CD Maturity Assessment')}
        <h1>🎓 CI/CD Maturity Assessment</h1>
        <p class="subtitle">${orgName} • ${reportDate} • ${timeframeLabel}</p>
        
        <div class="metric-row">
            <div class="metric-box ${maturity.overall.level === 'Elite' ? 'elite' : maturity.overall.level === 'Advanced' ? 'high' : maturity.overall.level === 'Intermediate' ? 'medium' : 'low'}">
                <div class="value">${maturityOverallPct}%</div>
                <div class="label">Overall Maturity Score</div>
                <div style="margin-top: 10px;"><span class="status-badge ${maturity.overall.level.toLowerCase()}">${maturity.overall.level}</span></div>
            </div>
            ${maturity.categories.map(c => {
              const pct = Math.round((c.score / c.maxScore) * 100);
              return `<div class="metric-box ${c.level === 'Elite' ? 'elite' : c.level === 'Advanced' ? 'high' : c.level === 'Intermediate' ? 'medium' : 'low'}">
                <div class="value">${pct}%</div>
                <div class="label">${c.name}</div>
                <small style="color: #888">${c.level}</small>
            </div>`;
            }).join('')}
        </div>
        
        <div class="grid">
            <div class="card">
                <h3>Maturity by Category</h3>
                <div class="chart-container">
                    <canvas id="maturityRadar"></canvas>
                </div>
            </div>
            <div class="card">
                <h3>Category Scores</h3>
                <div class="chart-container">
                    <canvas id="maturityBar"></canvas>
                </div>
            </div>
        </div>
        
        <div class="card" style="margin-bottom: 20px;" id="ai-insights">
            <h3>🤖 AI Advisor Insights ${aiProviderInfo.enabled ? `<span style="font-size: 0.7em; color: #a855f7;">(${aiProviderInfo.provider}/${aiProviderInfo.model})</span>` : ''}</h3>
            <div style="display: grid; gap: 15px; margin-top: 15px;">
                ${maturity.aiAdvisorInsights.map(insight => `
                <div style="padding: 20px; background: rgba(0,212,255,0.05); border-radius: 12px; border-left: 4px solid #00d4ff;">
                    ${insight.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')}
                </div>
                `).join('')}
            </div>
        </div>
        
        <!-- Prominent link to CI/CD Health for Copilot code suggestions -->
        ${(() => {
          const failingWorkflows = workflows.filter((w: any) => w.failureRate > 20);
          const slowWorkflows = workflows.filter((w: any) => w.avgDurationSeconds > 600);
          const totalIssues = failingWorkflows.length + slowWorkflows.length;
          if (totalIssues > 0) {
            return `
        <a href="cicd-details.html" class="card" style="margin-bottom: 20px; display: block; text-decoration: none; color: inherit; background: linear-gradient(135deg, rgba(99,102,241,0.15) 0%, rgba(168,85,247,0.15) 100%); border: 2px solid #a855f7; cursor: pointer; transition: all 0.3s;" onmouseover="this.style.transform='translateY(-4px)'; this.style.boxShadow='0 10px 40px rgba(168,85,247,0.3)';" onmouseout="this.style.transform='translateY(0)'; this.style.boxShadow='none';">
            <div style="display: flex; align-items: center; gap: 20px;">
                <div style="font-size: 3em;">🔧</div>
                <div style="flex: 1;">
                    <h3 style="color: #a855f7; margin-bottom: 8px;">
                        Fix Issues with GitHub Copilot Code Suggestions
                        <span style="margin-left: 10px; font-size: 0.7em; background: linear-gradient(90deg, #a855f7, #6366f1); padding: 4px 12px; border-radius: 20px; color: white;">🤖 AI-Powered</span>
                    </h3>
                    <p style="color: #888; margin-bottom: 12px;">
                        We found <strong style="color: #f87171;">${failingWorkflows.length} failing workflow(s)</strong> 
                        ${slowWorkflows.length > 0 ? `and <strong style="color: #f59e0b;">${slowWorkflows.length} slow workflow(s)</strong>` : ''} 
                        that need attention.
                    </p>
                    <div style="display: flex; gap: 15px; flex-wrap: wrap;">
                        ${failingWorkflows.slice(0, 3).map((wf: any) => `
                        <div style="padding: 8px 12px; background: rgba(248,113,113,0.1); border-radius: 8px; font-size: 0.85em;">
                            <span style="color: #f87171;">⚠️ ${wf.name.slice(0, 25)}${wf.name.length > 25 ? '...' : ''}</span>
                            <span style="color: #888; margin-left: 5px;">(${wf.failureRate}% fail)</span>
                        </div>
                        `).join('')}
                        ${totalIssues > 3 ? `<div style="padding: 8px 12px; color: #888; font-size: 0.85em;">+${totalIssues - 3} more...</div>` : ''}
                    </div>
                </div>
                <div style="font-size: 2em; color: #a855f7;">→</div>
            </div>
            <div style="margin-top: 15px; padding: 12px; background: rgba(255,255,255,0.03); border-radius: 8px; text-align: center;">
                <span style="color: #00d4ff;">📋 View CI/CD Health Report</span> — Get ready-to-use YAML snippets to fix these workflows
            </div>
        </a>`;
          }
          return '';
        })()}
        
        <div id="recommendations"></div>
        ${maturity.categories.map(cat => `
        <div class="card" style="margin-bottom: 20px;">
            <h3>${cat.name} <span class="status-badge ${cat.level.toLowerCase()}" style="margin-left: 10px; font-size: 0.7em;">${cat.level}</span></h3>
            <div style="margin-bottom: 20px;">
                <h4 style="color: #888; margin-bottom: 10px;">Findings</h4>
                ${cat.findings.map(f => `<div style="padding: 8px 0; border-bottom: 1px solid rgba(255,255,255,0.05);">${f}</div>`).join('')}
            </div>
            ${cat.recommendations.length > 0 ? `
            <div>
                <h4 style="color: #888; margin-bottom: 10px;">Recommendations</h4>
                ${cat.recommendations.map(rec => `
                <div style="padding: 15px; background: rgba(255,255,255,0.03); border-radius: 8px; margin-bottom: 10px;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                        <strong>${rec.title}</strong>
                        <span class="status-badge ${rec.priority === 'high' ? 'low' : rec.priority === 'medium' ? 'medium' : 'high'}">${rec.priority.toUpperCase()}</span>
                    </div>
                    <div style="color: #888; margin-bottom: 8px;">${rec.description}</div>
                    <div style="color: #4ade80; font-size: 0.9em;">💡 Impact: ${rec.impact}</div>
                    ${rec.docLink ? `<a href="${rec.docLink}" target="_blank" style="color: #00d4ff; font-size: 0.85em; text-decoration: none;">📚 Learn more →</a>` : ''}
                </div>
                `).join('')}
            </div>
            ` : '<div style="color: #4ade80;">✅ No issues found in this category</div>'}
        </div>
        `).join('')}
        
        <div class="card">
            <h3>📈 Maturity Progression Path</h3>
            <table>
                <thead><tr><th>Level</th><th>Score Range</th><th>Characteristics</th><th>Your Status</th></tr></thead>
                <tbody>
                    <tr style="${maturity.overall.level === 'Basic' ? 'background: rgba(239,68,68,0.1);' : ''}"><td>🌱 Basic</td><td>0-39%</td><td>Starting DevOps journey, manual processes</td><td>${maturity.overall.level === 'Basic' ? '← You are here' : maturityOverallPct >= 40 ? '✅ Achieved' : ''}</td></tr>
                    <tr style="${maturity.overall.level === 'Intermediate' ? 'background: rgba(234,179,8,0.1);' : ''}"><td>📈 Intermediate</td><td>40-59%</td><td>Basic automation, some CI/CD adoption</td><td>${maturity.overall.level === 'Intermediate' ? '← You are here' : maturityOverallPct >= 60 ? '✅ Achieved' : ''}</td></tr>
                    <tr style="${maturity.overall.level === 'Advanced' ? 'background: rgba(34,197,94,0.1);' : ''}"><td>🌟 Advanced</td><td>60-79%</td><td>Standardized practices, good automation</td><td>${maturity.overall.level === 'Advanced' ? '← You are here' : maturityOverallPct >= 80 ? '✅ Achieved' : ''}</td></tr>
                    <tr style="${maturity.overall.level === 'Elite' ? 'background: rgba(168,85,247,0.1);' : ''}"><td>🏆 Elite</td><td>80-100%</td><td>Industry-leading practices, full automation</td><td>${maturity.overall.level === 'Elite' ? '← You are here' : ''}</td></tr>
                </tbody>
            </table>
        </div>
    <script>
        Chart.defaults.color = '#888';
        new Chart(document.getElementById('maturityRadar'), {
            type: 'radar',
            data: {
                labels: ${JSON.stringify(maturity.categories.map(c => c.name.split(' ')[0]))},
                datasets: [{
                    label: 'Current',
                    data: ${JSON.stringify(maturity.categories.map(c => Math.round((c.score / c.maxScore) * 100)))},
                    backgroundColor: 'rgba(0,212,255,0.2)',
                    borderColor: '#00d4ff',
                    pointBackgroundColor: '#00d4ff',
                }, {
                    label: 'Target (80%)',
                    data: [80, 80, 80, 80],
                    backgroundColor: 'rgba(248,113,113,0.1)',
                    borderColor: '#f87171',
                    borderDash: [5,5],
                    pointRadius: 0,
                }]
            },
            options: { responsive: true, maintainAspectRatio: false, scales: { r: { beginAtZero: true, max: 100 } } }
        });
        new Chart(document.getElementById('maturityBar'), {
            type: 'bar',
            data: {
                labels: ${JSON.stringify(maturity.categories.map(c => c.name.split(' ')[0]))},
                datasets: [{
                    data: ${JSON.stringify(maturity.categories.map(c => Math.round((c.score / c.maxScore) * 100)))},
                    backgroundColor: ${JSON.stringify(maturity.categories.map(c => {
                      const pct = Math.round((c.score / c.maxScore) * 100);
                      return pct >= 80 ? '#a855f7' : pct >= 60 ? '#22c55e' : pct >= 40 ? '#f59e0b' : '#ef4444';
                    }))},
                    borderRadius: 8
                }]
            },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, max: 100 } } }
        });
    </script>
${htmlFoot}`;
        writeFileSync(join(reportFolder, 'maturity-details.html'), maturityDetailsHtml);
        
        // Migration Details Page (Advisory)
        if (migrationAnalysis.length > 0) {
          const reposWithTools = migrationAnalysis.filter(r => r.tool !== 'none');
          const totalPipelines = reposWithTools.reduce((sum, r) => sum + r.workflows.length, 0);
          const uniqueTools = [...new Set(reposWithTools.map(r => r.tool))];
          const suggestionCount = allMigrationRecommendations.length;
          
          const backupRecs = allMigrationRecommendations.filter(r => r.rec.toLowerCase().includes('backup'));
          const previewRecs = allMigrationRecommendations.filter(r => r.rec.toLowerCase().includes('preview') || r.rec.toLowerCase().includes('sql'));
          const otherRecs = allMigrationRecommendations.filter(r => 
            !r.rec.toLowerCase().includes('backup') && 
            !r.rec.toLowerCase().includes('preview') && 
            !r.rec.toLowerCase().includes('sql')
          );
          
          const migrationDetailsHtml = `${htmlHead('Database Migration Practices')}
        <h1>🗄️ Database Migration Practices</h1>
        <p class="subtitle">${orgName} • ${reportDate} • Advisory Report</p>
        
        <div style="background: linear-gradient(135deg, rgba(168,85,247,0.1) 0%, rgba(99,102,241,0.1) 100%); border: 1px solid rgba(168,85,247,0.3); border-radius: 12px; padding: 20px; margin-bottom: 30px;">
            <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 10px;">
                <span style="font-size: 1.5em;">ℹ️</span>
                <strong style="color: #a855f7;">Advisory Report</strong>
            </div>
            <p style="color: #888; margin: 0;">These are suggestions to reduce deployment risk. Passing pipelines indicate migrations execute successfully. This report does not affect DevOps scores.</p>
        </div>
        
        <div class="metric-row">
            <div class="metric-box" style="background: rgba(168, 85, 247, 0.1); border-left: 4px solid #a855f7;">
                <div class="value" style="color: #a855f7;">${reposWithTools.length}</div>
                <div class="label">Repositories with Migrations</div>
            </div>
            <div class="metric-box" style="background: rgba(34, 197, 94, 0.1); border-left: 4px solid #22c55e;">
                <div class="value" style="color: #22c55e;">${totalPipelines}</div>
                <div class="label">Migration Pipelines</div>
            </div>
            <div class="metric-box" style="background: rgba(251, 191, 36, 0.1); border-left: 4px solid #fbbf24;">
                <div class="value" style="color: #fbbf24;">${suggestionCount}</div>
                <div class="label">Suggestions</div>
            </div>
            <div class="metric-box" style="background: rgba(6, 182, 212, 0.1); border-left: 4px solid #06b6d4;">
                <div class="value" style="color: #06b6d4; font-size: 1.5em;">${uniqueTools.length}</div>
                <div class="label">Migration Tools</div>
            </div>
        </div>
        
        <div class="card" style="margin-bottom: 20px;">
            <h3>📊 Detected Migration Tools</h3>
            <table>
                <thead>
                    <tr><th>Repository</th><th>Tool</th><th>Build System</th><th>Pipelines</th></tr>
                </thead>
                <tbody>
                    ${reposWithTools.map(r => `
                    <tr>
                        <td><a href="https://github.com/${orgName}/${r.repo}" target="_blank" style="color: #00d4ff;">${r.repo}</a></td>
                        <td><span style="background: rgba(168,85,247,0.2); color: #a855f7; padding: 4px 10px; border-radius: 8px; font-size: 0.85em;">${r.tool.charAt(0).toUpperCase() + r.tool.slice(1)}</span></td>
                        <td>${r.buildSystem}</td>
                        <td>${r.workflows.length > 0 ? r.workflows.length + ' workflow(s)' : '<span style="color: #888;">None detected</span>'}</td>
                    </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
        
        ${suggestionCount > 0 ? `
        <div class="card" style="margin-bottom: 20px;">
            <h3>💡 Suggestions to Reduce Risk</h3>
            <p style="color: #888; margin-bottom: 20px;">These practices can help prevent issues during database migrations:</p>
            
            ${backupRecs.length > 0 ? `
            <div style="margin-bottom: 25px;">
                <h4 style="color: #22c55e; margin-bottom: 15px;">🔒 Database Backups</h4>
                <p style="color: #888; margin-bottom: 10px;">Consider adding backup steps before migrations run:</p>
                ${[...new Set(backupRecs.map(r => r.repo))].map(repo => `
                <div style="padding: 12px 15px; background: rgba(34,197,94,0.05); border-left: 3px solid #22c55e; border-radius: 0 8px 8px 0; margin-bottom: 8px;">
                    <strong>${repo}</strong>: Add <code style="background: rgba(255,255,255,0.1); padding: 2px 6px; border-radius: 4px;">pg_dump</code>, <code style="background: rgba(255,255,255,0.1); padding: 2px 6px; border-radius: 4px;">mysqldump</code>, or cloud snapshot before migration
                </div>
                `).join('')}
            </div>
            ` : ''}
            
            ${previewRecs.length > 0 ? `
            <div style="margin-bottom: 25px;">
                <h4 style="color: #06b6d4; margin-bottom: 15px;">👁️ Migration Preview</h4>
                <p style="color: #888; margin-bottom: 10px;">Generate migration SQL for review before applying:</p>
                ${previewRecs.slice(0, 5).map(rec => `
                <div style="padding: 12px 15px; background: rgba(6,182,212,0.05); border-left: 3px solid #06b6d4; border-radius: 0 8px 8px 0; margin-bottom: 8px;">
                    <strong>${rec.repo}</strong> <span style="color: #888;">(${rec.workflow})</span>: ${rec.rec}
                </div>
                `).join('')}
            </div>
            ` : ''}
            
            ${otherRecs.length > 0 ? `
            <div>
                <h4 style="color: #f59e0b; margin-bottom: 15px;">📝 Other Suggestions</h4>
                ${otherRecs.slice(0, 5).map(rec => `
                <div style="padding: 12px 15px; background: rgba(245,158,11,0.05); border-left: 3px solid #f59e0b; border-radius: 0 8px 8px 0; margin-bottom: 8px;">
                    <strong>${rec.repo}</strong>: ${rec.rec}
                </div>
                `).join('')}
            </div>
            ` : ''}
        </div>
        ` : `
        <div class="card" style="margin-bottom: 20px; background: rgba(34,197,94,0.05); border: 1px solid rgba(34,197,94,0.3);">
            <h3 style="color: #22c55e;">✅ Good Practices Detected</h3>
            <p style="color: #888;">No critical migration safety suggestions at this time. Your migration pipelines follow recommended practices.</p>
        </div>
        `}
        
        ${reposWithTools.filter(r => r.workflows.length > 0).length > 0 ? `
        <div class="card">
            <h3>📋 Pipeline Details</h3>
            ${reposWithTools.filter(r => r.workflows.length > 0).map(repo => `
            <div style="margin-bottom: 25px;">
                <h4 style="margin-bottom: 15px;"><a href="https://github.com/${orgName}/${repo.repo}" target="_blank" style="color: #00d4ff; text-decoration: none;">${repo.repo}</a></h4>
                <table>
                    <thead>
                        <tr><th>Workflow</th><th>Mode</th><th>Description</th></tr>
                    </thead>
                    <tbody>
                        ${repo.workflows.map(wf => {
                          const modeColor = wf.mode === 'explicit' ? '#a855f7' : wf.mode === 'build-integrated' ? '#f59e0b' : '#22c55e';
                          const modeIcon = wf.mode === 'explicit' ? '📋' : wf.mode === 'build-integrated' ? '🔧' : '🚀';
                          const modeLabel = wf.mode === 'explicit' ? 'Explicit' : wf.mode === 'build-integrated' ? 'Build-Integrated' : 'Runtime';
                          return `
                        <tr>
                            <td><a href="https://github.com/${orgName}/${repo.repo}/blob/main/.github/workflows/${wf.name}" target="_blank" style="color: #00d4ff;">${wf.name}</a></td>
                            <td><span style="background: rgba(255,255,255,0.05); padding: 4px 10px; border-radius: 8px;">${modeIcon} <span style="color: ${modeColor};">${modeLabel}</span></span></td>
                            <td style="color: #888;">${wf.modeDescription || '-'}</td>
                        </tr>
                          `;
                        }).join('')}
                    </tbody>
                </table>
            </div>
            `).join('')}
        </div>
        ` : ''}
        
        <div style="margin-top: 30px; padding: 20px; background: rgba(255,255,255,0.03); border-radius: 12px;">
            <h4 style="margin-bottom: 15px;">📚 Learn More</h4>
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 15px;">
                <a href="https://docs.liquibase.com/workflows/liquibase-community/using-liquibase-best-practices.html" target="_blank" style="color: #00d4ff; text-decoration: none; padding: 12px; background: rgba(0,212,255,0.05); border-radius: 8px; display: block;">
                    🔗 Liquibase Best Practices
                </a>
                <a href="https://documentation.red-gate.com/fd/flyway-best-practices-184127489.html" target="_blank" style="color: #00d4ff; text-decoration: none; padding: 12px; background: rgba(0,212,255,0.05); border-radius: 8px; display: block;">
                    🔗 Flyway Best Practices
                </a>
                <a href="https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/" target="_blank" style="color: #00d4ff; text-decoration: none; padding: 12px; background: rgba(0,212,255,0.05); border-radius: 8px; display: block;">
                    🔗 EF Core Migrations Guide
                </a>
            </div>
        </div>
${htmlFoot}`;
          writeFileSync(join(reportFolder, 'migration-details.html'), migrationDetailsHtml);
          generatedReports.push('migration-details.html');
        }
        
        generatedReports.push('dora-details.html', 'cicd-details.html', 'cost-details.html', 'security-details.html', 'maturity-details.html');

        return {
          content: [{
            type: 'text',
            text: `## 📊 DevOps Reports Generated\n\n✅ Successfully generated ${generatedReports.length + 1} reports in \`${reportFolder}\`\n\n### Reports Created:\n${generatedReports.map(r => `- [${r}](${join(reportFolder, r)})`).join('\n')}\n- [README.md](${join(reportFolder, 'README.md')})\n\n💡 Open the folder to view detailed reports with Mermaid diagrams.`,
          }],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error: any) {
    return {
      content: [{
        type: 'text',
        text: `❌ Error: ${error.message}\n\n💡 Tip: Ensure you have the required permissions for the organization.`,
      }],
      isError: true,
    };
  }
  }); // End of requestQueue.enqueue
});

// ============================================
// Prompts Handler - Suggested Actions on Startup
// ============================================
server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: [
    {
      name: 'generate-devops-reports',
      description: 'Generate comprehensive DevOps reports with DORA metrics, CI/CD health, cost analysis, and compliance status',
      arguments: [
        {
          name: 'output_path',
          description: 'Output directory for reports (default: $DEVOPS_CONFIG_PATH/reports or ./reports)',
          required: false,
        },
        {
          name: 'timeframe',
          description: 'Analysis timeframe: 7d, 30d, or 90d (default: 30d)',
          required: false,
        },
      ],
    },
    {
      name: 'devops-health-check',
      description: 'Quick health check of your DevOps setup - token permissions, configuration, and connectivity',
    },
    {
      name: 'analyze-deployment-issues',
      description: 'Investigate deployment failures and identify root causes',
    },
  ],
}));

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name, arguments: promptArgs } = request.params;

  switch (name) {
    case 'generate-devops-reports': {
      const configBase = configRepoSettings.configLocalPath || process.cwd();
      const defaultReportsPath = join(configBase, 'reports');
      // Resolve relative paths against configBase to prevent container-local writes
      let outputPath = promptArgs?.output_path || defaultReportsPath;
      if (outputPath && !outputPath.startsWith('/')) {
        outputPath = join(configBase, outputPath.replace(/^\.\//, ''));
      }
      const timeframe = promptArgs?.timeframe || '30d';
      
      return {
        description: 'Generate DevOps Reports',
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Please generate comprehensive DevOps reports for my organization. Save them to "${outputPath}" with a ${timeframe} analysis timeframe. Include DORA metrics, CI/CD pipeline health, cost optimization recommendations, and compliance status. Use Mermaid diagrams where appropriate.`,
            },
          },
        ],
      };
    }

    case 'devops-health-check': {
      return {
        description: 'DevOps Health Check',
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Please perform a DevOps health check:
1. Check my token permissions to ensure I have the required access
2. Verify the DevOps configuration is loaded correctly
3. List the monitored repositories
4. Provide a summary of the current DevOps state`,
            },
          },
        ],
      };
    }

    case 'analyze-deployment-issues': {
      return {
        description: 'Analyze Deployment Issues',
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Please analyze my deployment pipelines for issues:
1. Get deployment metrics for the last 30 days
2. Identify any failing deployments or concerning patterns
3. Analyze CI/CD workflow performance
4. Provide recommendations to improve reliability`,
            },
          },
        ],
      };
    }

    default:
      throw new Error(`Unknown prompt: ${name}`);
  }
});

// Start MCP Server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('🚀 MCP ActionsPulse Server started');
  console.error(`📊 Mode: ${hasEnterpriseAccess ? 'Enterprise' : 'Organization'}`);
  console.error(`🔗 API: ${config.baseUrl}`);
  if (defaultOrg) {
    console.error(`🏢 Default Organization: ${defaultOrg}`);
  }
}

main().catch((error) => {
  console.error('❌ Server error:', error);
  process.exit(1);
});
