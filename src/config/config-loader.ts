/**
 * Config Loader Service for ActionsPulse MCP Server
 * 
 * Loads configuration from a central devops-config-repo or local path.
 * Supports:
 * - Remote loading from GitHub repository
 * - Local file fallback for development
 * - Auto-discovery of policy files
 * - Hot reload capability
 */

import { Octokit } from '@octokit/rest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as yaml from 'yaml';
import {
  DevOpsConfig,
  LoadedConfig,
  ConfigLoaderOptions,
  ConfigError,
  WorkflowPolicy,
  SecurityPolicy,
  CostPolicy,
  MigrationPolicy,
  RepositoryInventory,
  DashboardConfig,
} from './types.js';

// Default configuration when no config repo is available
const DEFAULT_CONFIG: DevOpsConfig = {
  version: '1.0.0',
  organization: {
    name: 'Default Organization',
    github_org: '',
    environments: ['development', 'staging', 'production'],
  },
  paths: {
    policies: 'policies/',
    repositories: 'repositories/',
    workflows: 'workflows/',
    dashboards: 'dashboards/',
  },
  defaults: {
    enforcement: 'advisory',
    autoFix: false,
    notifyOnViolation: false,
  },
};

// Standard discovery paths for config files
const DISCOVERY_PATHS = {
  main: [
    '.devops-config.json',
    '.devops-config.yaml',
    '.devops-config.yml',
    'devops-config.json',
    'devops-config.yaml',
  ],
  policies: [
    'policies/workflow-policies.yaml',
    'policies/workflow-policies.yml',
    'policies/security-policies.yaml',
    'policies/security-policies.yml',
    'policies/cost-policies.yaml',
    'policies/cost-policies.yml',
    'policies/migration-policies.yaml',
    'policies/migration-policies.yml',
    'policies/compliance-policies.yaml',
    'policies/compliance-policies.yml',
  ],
  repositories: [
    'repositories/inventory.yaml',
    'repositories/inventory.yml',
    'repositories/inventory.json',
  ],
  dashboards: [
    'dashboards/executive.yaml',
    'dashboards/devops.yaml',
    'dashboards/developer.yaml',
    'dashboards/dba.yaml',
    'dashboards/infrastructure.yaml',
  ],
};

export class ConfigLoader {
  private octokit: Octokit | null = null;
  private options: ConfigLoaderOptions;
  private loadedConfig: LoadedConfig | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;

  constructor(options: ConfigLoaderOptions) {
    this.options = {
      configRepo: 'devops-config',
      branch: 'main',
      autoReload: false,
      reloadIntervalMs: 5 * 60 * 1000, // 5 minutes
      ...options,
    };

    if (this.options.token) {
      this.octokit = new Octokit({
        auth: this.options.token,
      });
    }
  }

  /**
   * Load configuration from source (remote or local)
   */
  async load(): Promise<LoadedConfig> {
    const errors: ConfigError[] = [];
    let source: 'remote' | 'local' | 'default' = 'default';

    // Try local path first if specified
    if (this.options.localPath) {
      try {
        const config = await this.loadFromLocal(this.options.localPath);
        this.loadedConfig = config;
        this.setupAutoReload();
        return config;
      } catch (error: any) {
        errors.push({
          file: this.options.localPath,
          message: `Failed to load from local path: ${error.message}`,
          severity: 'warning',
        });
      }
    }

    // Try remote config repo
    if (this.octokit && this.options.org) {
      try {
        const config = await this.loadFromRemote();
        this.loadedConfig = config;
        this.setupAutoReload();
        return config;
      } catch (error: any) {
        errors.push({
          file: `${this.options.org}/${this.options.configRepo}`,
          message: `Failed to load from remote: ${error.message}`,
          severity: 'warning',
        });
      }
    }

    // Fallback to defaults
    console.error('ℹ️ Using default configuration (no devops-config-repo found)');
    const defaultConfig = this.createDefaultConfig(errors);
    this.loadedConfig = defaultConfig;
    return defaultConfig;
  }

  /**
   * Get the currently loaded configuration
   */
  getConfig(): LoadedConfig | null {
    return this.loadedConfig;
  }

  /**
   * Force reload configuration
   */
  async reload(): Promise<LoadedConfig> {
    return this.load();
  }

  /**
   * Stop auto-reload timer
   */
  stop(): void {
    if (this.reloadTimer) {
      clearInterval(this.reloadTimer);
      this.reloadTimer = null;
    }
  }

  /**
   * Load configuration from local filesystem
   */
  private async loadFromLocal(basePath: string): Promise<LoadedConfig> {
    const errors: ConfigError[] = [];

    // Find and load main config
    let mainConfig = DEFAULT_CONFIG;
    for (const configPath of DISCOVERY_PATHS.main) {
      try {
        const fullPath = path.join(basePath, configPath);
        const content = await fs.readFile(fullPath, 'utf-8');
        mainConfig = this.parseConfig(content, configPath);
        console.error(`✅ Loaded config from: ${fullPath}`);
        break;
      } catch {
        // Try next path
      }
    }

    // Update org from environment if not set
    if (!mainConfig.organization.github_org && this.options.org) {
      mainConfig.organization.github_org = this.options.org;
    }

    // Load policies
    const workflowPolicies = await this.loadPoliciesFromLocal<WorkflowPolicy>(
      basePath,
      'workflow',
      errors
    );
    const securityPolicies = await this.loadPoliciesFromLocal<SecurityPolicy>(
      basePath,
      'security',
      errors
    );
    const costPolicies = await this.loadPoliciesFromLocal<CostPolicy>(
      basePath,
      'cost',
      errors
    );
    const migrationPolicies = await this.loadPoliciesFromLocal<MigrationPolicy>(
      basePath,
      'migration',
      errors
    );

    // Load repository inventory
    const repositoryInventory = await this.loadInventoryFromLocal(basePath, errors);

    // Load dashboards
    const dashboards = await this.loadDashboardsFromLocal(basePath, errors);

    return {
      main: mainConfig,
      workflowPolicies,
      securityPolicies,
      costPolicies,
      migrationPolicies,
      repositoryInventory,
      dashboards,
      loadedAt: new Date(),
      source: 'local',
      errors,
    };
  }

  /**
   * Load configuration from GitHub repository
   */
  private async loadFromRemote(): Promise<LoadedConfig> {
    if (!this.octokit || !this.options.org) {
      throw new Error('GitHub client not configured');
    }

    const errors: ConfigError[] = [];
    const owner = this.options.org;
    const repo = this.options.configRepo!;
    const branch = this.options.branch!;

    // Find and load main config
    let mainConfig = DEFAULT_CONFIG;
    for (const configPath of DISCOVERY_PATHS.main) {
      try {
        const content = await this.fetchFileFromGitHub(owner, repo, configPath, branch);
        mainConfig = this.parseConfig(content, configPath);
        console.error(`✅ Loaded config from: ${owner}/${repo}/${configPath}`);
        break;
      } catch {
        // Try next path
      }
    }

    // Update org from environment if not set
    if (!mainConfig.organization.github_org) {
      mainConfig.organization.github_org = owner;
    }

    // Load policies
    const workflowPolicies = await this.loadPoliciesFromRemote<WorkflowPolicy>(
      owner,
      repo,
      branch,
      'workflow',
      errors
    );
    const securityPolicies = await this.loadPoliciesFromRemote<SecurityPolicy>(
      owner,
      repo,
      branch,
      'security',
      errors
    );
    const costPolicies = await this.loadPoliciesFromRemote<CostPolicy>(
      owner,
      repo,
      branch,
      'cost',
      errors
    );
    const migrationPolicies = await this.loadPoliciesFromRemote<MigrationPolicy>(
      owner,
      repo,
      branch,
      'migration',
      errors
    );

    // Load repository inventory
    const repositoryInventory = await this.loadInventoryFromRemote(
      owner,
      repo,
      branch,
      errors
    );

    // Load dashboards
    const dashboards = await this.loadDashboardsFromRemote(owner, repo, branch, errors);

    return {
      main: mainConfig,
      workflowPolicies,
      securityPolicies,
      costPolicies,
      migrationPolicies,
      repositoryInventory,
      dashboards,
      loadedAt: new Date(),
      source: 'remote',
      errors,
    };
  }

  /**
   * Fetch a file from GitHub repository
   */
  private async fetchFileFromGitHub(
    owner: string,
    repo: string,
    filePath: string,
    branch: string
  ): Promise<string> {
    if (!this.octokit) {
      throw new Error('GitHub client not configured');
    }

    const { data } = await this.octokit.rest.repos.getContent({
      owner,
      repo,
      path: filePath,
      ref: branch,
    });

    if ('content' in data && data.type === 'file') {
      return Buffer.from(data.content, 'base64').toString('utf-8');
    }

    throw new Error(`Not a file: ${filePath}`);
  }

  /**
   * Load policies from local filesystem
   */
  private async loadPoliciesFromLocal<T>(
    basePath: string,
    policyType: string,
    errors: ConfigError[]
  ): Promise<T[]> {
    const policies: T[] = [];
    const policyPath = path.join(basePath, 'policies');

    try {
      const files = await fs.readdir(policyPath);
      for (const file of files) {
        if (file.includes(policyType) && (file.endsWith('.yaml') || file.endsWith('.yml') || file.endsWith('.json'))) {
          try {
            const content = await fs.readFile(path.join(policyPath, file), 'utf-8');
            const policy = this.parseConfig<T>(content, file);
            policies.push(policy);
          } catch (error: any) {
            errors.push({
              file,
              message: `Failed to parse: ${error.message}`,
              severity: 'warning',
            });
          }
        }
      }
    } catch {
      // Policies directory doesn't exist
    }

    return policies;
  }

  /**
   * Load policies from GitHub repository
   */
  private async loadPoliciesFromRemote<T>(
    owner: string,
    repo: string,
    branch: string,
    policyType: string,
    errors: ConfigError[]
  ): Promise<T[]> {
    const policies: T[] = [];

    try {
      const { data: files } = await this.octokit!.rest.repos.getContent({
        owner,
        repo,
        path: 'policies',
        ref: branch,
      });

      if (Array.isArray(files)) {
        for (const file of files) {
          if (
            file.name.includes(policyType) &&
            file.type === 'file' &&
            (file.name.endsWith('.yaml') || file.name.endsWith('.yml') || file.name.endsWith('.json'))
          ) {
            try {
              const content = await this.fetchFileFromGitHub(owner, repo, file.path, branch);
              const policy = this.parseConfig<T>(content, file.name);
              policies.push(policy);
            } catch (error: any) {
              errors.push({
                file: file.path,
                message: `Failed to parse: ${error.message}`,
                severity: 'warning',
              });
            }
          }
        }
      }
    } catch {
      // Policies directory doesn't exist
    }

    return policies;
  }

  /**
   * Load repository inventory from local filesystem
   */
  private async loadInventoryFromLocal(
    basePath: string,
    errors: ConfigError[]
  ): Promise<RepositoryInventory | null> {
    for (const inventoryPath of DISCOVERY_PATHS.repositories) {
      try {
        const fullPath = path.join(basePath, inventoryPath);
        const content = await fs.readFile(fullPath, 'utf-8');
        return this.parseConfig<RepositoryInventory>(content, inventoryPath);
      } catch {
        // Try next path
      }
    }
    return null;
  }

  /**
   * Load repository inventory from GitHub
   */
  private async loadInventoryFromRemote(
    owner: string,
    repo: string,
    branch: string,
    errors: ConfigError[]
  ): Promise<RepositoryInventory | null> {
    for (const inventoryPath of DISCOVERY_PATHS.repositories) {
      try {
        const content = await this.fetchFileFromGitHub(owner, repo, inventoryPath, branch);
        return this.parseConfig<RepositoryInventory>(content, inventoryPath);
      } catch {
        // Try next path
      }
    }
    return null;
  }

  /**
   * Load dashboards from local filesystem
   */
  private async loadDashboardsFromLocal(
    basePath: string,
    errors: ConfigError[]
  ): Promise<DashboardConfig[]> {
    const dashboards: DashboardConfig[] = [];
    const dashboardPath = path.join(basePath, 'dashboards');

    try {
      const files = await fs.readdir(dashboardPath);
      for (const file of files) {
        if (file.endsWith('.yaml') || file.endsWith('.yml') || file.endsWith('.json')) {
          try {
            const content = await fs.readFile(path.join(dashboardPath, file), 'utf-8');
            const dashboard = this.parseConfig<DashboardConfig>(content, file);
            dashboards.push(dashboard);
          } catch (error: any) {
            errors.push({
              file,
              message: `Failed to parse dashboard: ${error.message}`,
              severity: 'warning',
            });
          }
        }
      }
    } catch {
      // Dashboards directory doesn't exist
    }

    return dashboards;
  }

  /**
   * Load dashboards from GitHub repository
   */
  private async loadDashboardsFromRemote(
    owner: string,
    repo: string,
    branch: string,
    errors: ConfigError[]
  ): Promise<DashboardConfig[]> {
    const dashboards: DashboardConfig[] = [];

    try {
      const { data: files } = await this.octokit!.rest.repos.getContent({
        owner,
        repo,
        path: 'dashboards',
        ref: branch,
      });

      if (Array.isArray(files)) {
        for (const file of files) {
          if (
            file.type === 'file' &&
            (file.name.endsWith('.yaml') || file.name.endsWith('.yml') || file.name.endsWith('.json'))
          ) {
            try {
              const content = await this.fetchFileFromGitHub(owner, repo, file.path, branch);
              const dashboard = this.parseConfig<DashboardConfig>(content, file.name);
              dashboards.push(dashboard);
            } catch (error: any) {
              errors.push({
                file: file.path,
                message: `Failed to parse dashboard: ${error.message}`,
                severity: 'warning',
              });
            }
          }
        }
      }
    } catch {
      // Dashboards directory doesn't exist
    }

    return dashboards;
  }

  /**
   * Parse configuration content (JSON or YAML)
   */
  private parseConfig<T = any>(content: string, filename: string): T {
    if (filename.endsWith('.json')) {
      return JSON.parse(content);
    } else {
      return yaml.parse(content);
    }
  }

  /**
   * Create default configuration
   */
  private createDefaultConfig(errors: ConfigError[]): LoadedConfig {
    const mainConfig = { ...DEFAULT_CONFIG };
    if (this.options.org) {
      mainConfig.organization.github_org = this.options.org;
    }

    return {
      main: mainConfig,
      workflowPolicies: [],
      securityPolicies: [],
      costPolicies: [],
      migrationPolicies: [],
      repositoryInventory: null,
      dashboards: [],
      loadedAt: new Date(),
      source: 'default',
      errors,
    };
  }

  /**
   * Setup auto-reload timer
   */
  private setupAutoReload(): void {
    if (this.options.autoReload && this.options.reloadIntervalMs) {
      this.stop(); // Clear any existing timer
      this.reloadTimer = setInterval(async () => {
        try {
          console.error('🔄 Auto-reloading configuration...');
          await this.load();
          console.error('✅ Configuration reloaded');
        } catch (error: any) {
          console.error(`❌ Failed to reload configuration: ${error.message}`);
        }
      }, this.options.reloadIntervalMs);
    }
  }

  /**
   * Get configuration summary for display
   */
  getSummary(): string {
    if (!this.loadedConfig) {
      return 'No configuration loaded';
    }

    const config = this.loadedConfig;
    const lines = [
      `📋 **Configuration Summary**`,
      `- Source: ${config.source}`,
      `- Organization: ${config.main.organization.name} (${config.main.organization.github_org})`,
      `- Loaded at: ${config.loadedAt.toISOString()}`,
      ``,
      `📜 **Policies Loaded:**`,
      `- Workflow Policies: ${config.workflowPolicies.length}`,
      `- Security Policies: ${config.securityPolicies.length}`,
      `- Cost Policies: ${config.costPolicies.length}`,
      ``,
      `📊 **Repository Inventory:** ${config.repositoryInventory ? 'Loaded' : 'Not configured'}`,
      `📈 **Dashboards:** ${config.dashboards.length}`,
    ];

    if (config.errors.length > 0) {
      lines.push('', `⚠️ **Warnings:** ${config.errors.length}`);
      for (const error of config.errors.slice(0, 5)) {
        lines.push(`  - ${error.file}: ${error.message}`);
      }
    }

    return lines.join('\n');
  }
}
