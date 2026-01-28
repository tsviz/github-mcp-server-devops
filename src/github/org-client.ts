import { Octokit } from '@octokit/rest';
import { graphql } from '@octokit/graphql';
import { subHours, subDays } from 'date-fns';

export interface GitHubClientConfig {
  token?: string;
  appId?: string;
  privateKey?: string;
  installationId?: string;
  baseUrl?: string;
}

export interface EnterpriseConfig {
  enterpriseSlug?: string;
  enterpriseUrl?: string;
}

// Define all possible PAT scopes and their purposes
const PAT_SCOPES = {
  // Classic PAT scopes
  'repo': 'Full control of private repositories',
  'repo:status': 'Access commit status',
  'repo_deployment': 'Access deployment status',
  'public_repo': 'Access public repositories',
  'repo:invite': 'Access repository invitations',
  'security_events': 'Read/write security events',
  'admin:org': 'Full control of orgs and teams',
  'write:org': 'Read/write org and team membership',
  'read:org': 'Read org and team membership',
  'admin:public_key': 'Full control of user public keys',
  'write:public_key': 'Write user public keys',
  'read:public_key': 'Read user public keys',
  'admin:repo_hook': 'Full control of repository hooks',
  'write:repo_hook': 'Write repository hooks',
  'read:repo_hook': 'Read repository hooks',
  'admin:org_hook': 'Full control of organization hooks',
  'gist': 'Create gists',
  'notifications': 'Access notifications',
  'user': 'Update all user data',
  'read:user': 'Read all user profile data',
  'user:email': 'Access user email addresses',
  'user:follow': 'Follow and unfollow users',
  'delete_repo': 'Delete repositories',
  'write:discussion': 'Read/write team discussions',
  'read:discussion': 'Read team discussions',
  'write:packages': 'Upload packages to GitHub Package Registry',
  'read:packages': 'Download packages from GitHub Package Registry',
  'delete:packages': 'Delete packages from GitHub Package Registry',
  'admin:gpg_key': 'Full control of user GPG keys',
  'write:gpg_key': 'Write user GPG keys',
  'read:gpg_key': 'Read user GPG keys',
  'codespace': 'Full control of codespaces',
  'workflow': 'Update GitHub Action workflows',
  'admin:enterprise': 'Full control of enterprise',
  'manage_runners:enterprise': 'Manage enterprise runners',
  'manage_billing:enterprise': 'Read/write enterprise billing data',
  'read:enterprise': 'Read enterprise profile data',
  'audit_log': 'Read audit log',
  'copilot': 'Copilot access',
  'project': 'Full control of projects',
  'read:project': 'Read access to projects',
};

export class GitHubOrgClient {
  private octokit: Octokit;
  private graphqlClient: typeof graphql;
  private isEnterpriseEnabled: boolean = false;
  private enterpriseSlug?: string;
  private baseUrl: string;

  constructor(config: GitHubClientConfig, enterpriseConfig?: EnterpriseConfig) {
    this.baseUrl = config.baseUrl || process.env.GITHUB_API_URL || 'https://api.github.com';
    
    // Initialize with personal access token (simplest auth)
    this.octokit = new Octokit({
      auth: config.token || process.env.GITHUB_TOKEN,
      baseUrl: this.baseUrl,
    });

    // Initialize GraphQL client for more efficient queries
    this.graphqlClient = graphql.defaults({
      headers: {
        authorization: `token ${config.token || process.env.GITHUB_TOKEN}`,
      },
      ...(this.baseUrl !== 'https://api.github.com' && { baseUrl: this.baseUrl + '/graphql' }),
    });

    // Check if enterprise features are available
    if (enterpriseConfig?.enterpriseSlug) {
      this.enterpriseSlug = enterpriseConfig.enterpriseSlug;
    }
  }

  async verifyAccess(): Promise<{ hasOrgAccess: boolean; hasEnterpriseAccess: boolean; errorType?: string }> {
    let hasOrgAccess = false;
    let hasEnterpriseAccess = false;
    let errorType: string | undefined;

    try {
      // Verify basic API access
      await this.octokit.rest.users.getAuthenticated();
      hasOrgAccess = true;

      // Check for enterprise access if slug is provided
      if (this.enterpriseSlug) {
        try {
          await this.octokit.request('GET /enterprises/{enterprise}', {
            enterprise: this.enterpriseSlug,
          });
          await this.octokit.request('GET /enterprises/{enterprise}/settings/billing/actions', {
            enterprise: this.enterpriseSlug,
          });
          hasEnterpriseAccess = true;
          this.isEnterpriseEnabled = true;
        } catch {
          // Enterprise access not available, continue with org-level
          console.error('ℹ️ Enterprise access not available, using organization-level APIs');
        }
      }
    } catch (error: any) {
      const msg = error.message || '';
      if (msg.includes('rate limit')) {
        errorType = 'rate_limit';
        console.error('⏳ GitHub API rate limit exceeded. Please wait before retrying.');
        console.error(`   Reset time can be checked at: https://api.github.com/rate_limit`);
      } else if (msg.includes('Bad credentials') || msg.includes('401')) {
        errorType = 'auth';
        console.error('❌ Invalid GitHub token. Please check your GITHUB_TOKEN.');
      } else {
        errorType = 'unknown';
        console.error('❌ Failed to verify GitHub access:', msg);
      }
    }

    return { hasOrgAccess, hasEnterpriseAccess, errorType };
  }

  hasEnterpriseAccess(): boolean {
    return this.isEnterpriseEnabled;
  }

  // ============================================
  // Token Permission Analysis
  // ============================================

  async getTokenPermissions(orgName?: string): Promise<any> {
    const result: any = {
      tokenType: 'unknown',
      scopes: [],
      missingScopes: [],
      permissions: {},
      recommendations: [],
      rateLimits: {},
    };

    try {
      // Make a request and check response headers for scopes
      const response = await this.octokit.rest.users.getAuthenticated();
      
      // Get OAuth scopes from headers (classic PAT)
      const scopesHeader = (response.headers as any)['x-oauth-scopes'];
      const acceptedScopesHeader = (response.headers as any)['x-accepted-oauth-scopes'];
      
      // Get rate limit info
      const rateLimitRemaining = (response.headers as any)['x-ratelimit-remaining'];
      const rateLimitLimit = (response.headers as any)['x-ratelimit-limit'];
      const rateLimitReset = (response.headers as any)['x-ratelimit-reset'];

      result.user = {
        login: response.data.login,
        name: response.data.name,
        type: response.data.type,
      };

      result.rateLimits = {
        remaining: parseInt(rateLimitRemaining) || 0,
        limit: parseInt(rateLimitLimit) || 5000,
        resetsAt: rateLimitReset ? new Date(parseInt(rateLimitReset) * 1000).toISOString() : null,
        usedPercent: rateLimitLimit ? Math.round((1 - parseInt(rateLimitRemaining) / parseInt(rateLimitLimit)) * 100) : 0,
      };

      if (scopesHeader) {
        // Classic PAT - has scopes
        result.tokenType = 'classic-pat';
        result.scopes = scopesHeader.split(',').map((s: string) => s.trim()).filter(Boolean);
        
        // Map scopes to descriptions
        result.permissions = {};
        for (const scope of result.scopes) {
          result.permissions[scope] = {
            granted: true,
            description: (PAT_SCOPES as any)[scope] || 'Unknown scope',
          };
        }

        // Check for missing recommended scopes
        const recommendedScopes = ['repo', 'read:org', 'workflow', 'read:packages'];
        result.missingScopes = recommendedScopes.filter(s => !result.scopes.includes(s));
        
        if (result.missingScopes.length > 0) {
          result.recommendations.push({
            type: 'missing-scopes',
            message: `Consider adding these scopes: ${result.missingScopes.join(', ')}`,
            impact: 'Some DevOps metrics may not be available',
          });
        }
      } else {
        // Fine-grained PAT or GitHub App - no traditional scopes
        result.tokenType = 'fine-grained-pat-or-app';
        result.recommendations.push({
          type: 'info',
          message: 'Using fine-grained PAT or GitHub App. Permissions are managed at the token/app level.',
        });
      }

      // Test specific capabilities
      const capabilities = await this.testCapabilities(orgName);
      result.capabilities = capabilities;

      // Add recommendations based on capabilities
      for (const [capability, status] of Object.entries(capabilities)) {
        if (!(status as any).available && (status as any).recommendation) {
          result.recommendations.push({
            type: 'capability',
            capability,
            message: (status as any).recommendation,
          });
        }
      }

    } catch (error: any) {
      result.error = error.message;
      result.recommendations.push({
        type: 'error',
        message: 'Token validation failed. Ensure GITHUB_TOKEN is set correctly.',
      });
    }

    return result;
  }

  private async testCapabilities(orgName?: string): Promise<any> {
    const capabilities: any = {};
    const org = orgName || process.env.GITHUB_ORG;

    // Test org access
    if (org) {
      try {
        await this.octokit.rest.orgs.get({ org });
        capabilities.orgRead = { available: true, description: 'Read organization info' };
      } catch (error: any) {
        capabilities.orgRead = { 
          available: false, 
          error: error.status === 404 ? 'Org not found' : error.message,
          recommendation: 'Add read:org scope or grant org access to fine-grained PAT',
        };
      }

      // Test listing org repositories
      let testRepo: string | undefined;
      try {
        const { data: repos } = await this.octokit.rest.repos.listForOrg({ org, per_page: 1 });
        capabilities.reposRead = { available: true, description: 'List organization repositories', count: repos.length };
        if (repos.length > 0) {
          testRepo = repos[0].name;
        }
      } catch (error: any) {
        capabilities.reposRead = { 
          available: false, 
          error: error.message,
          recommendation: 'Grant repository access to fine-grained PAT',
        };
      }

      // Test org-level workflow runs access
      try {
        await this.octokit.request('GET /orgs/{org}/actions/runs', { org, per_page: 1 });
        capabilities.actionsOrgLevel = { available: true, description: 'Read org-level Actions workflow runs' };
      } catch (error: any) {
        capabilities.actionsOrgLevel = { 
          available: false, 
          error: error.message,
          recommendation: 'Org-level actions API requires admin:org or specific org permissions',
        };
      }

      // Test repo-level workflow runs access (more common permission)
      if (testRepo) {
        try {
          const { data } = await this.octokit.rest.actions.listWorkflowRunsForRepo({ 
            owner: org, 
            repo: testRepo, 
            per_page: 1 
          });
          capabilities.actionsRead = { 
            available: true, 
            description: 'Read repo-level Actions workflow runs',
            testRepo,
            sampleRunCount: data.total_count,
          };
        } catch (error: any) {
          capabilities.actionsRead = { 
            available: false, 
            error: error.message,
            testRepo,
            recommendation: 'Add actions:read permission to fine-grained PAT',
          };
        }

        // Test repo-level issues access
        try {
          const { data } = await this.octokit.rest.issues.listForRepo({ 
            owner: org, 
            repo: testRepo, 
            state: 'all',
            per_page: 1 
          });
          capabilities.issuesRead = { 
            available: true, 
            description: 'Read repository issues',
            testRepo,
          };
        } catch (error: any) {
          capabilities.issuesRead = { 
            available: false, 
            error: error.message,
            testRepo,
            recommendation: 'Add issues:read permission to fine-grained PAT',
          };
        }
      } else {
        capabilities.actionsRead = { 
          available: false, 
          error: 'No accessible repositories found',
          recommendation: 'Grant repository access to fine-grained PAT',
        };
      }

      // Test self-hosted runners access
      try {
        await this.octokit.rest.actions.listSelfHostedRunnersForOrg({ org, per_page: 1 });
        capabilities.runnersRead = { available: true, description: 'Read self-hosted runners' };
      } catch (error: any) {
        capabilities.runnersRead = { 
          available: false, 
          error: error.message,
          recommendation: 'Add admin:org scope or organization_self_hosted_runners:read permission',
        };
      }

      // Test billing access
      try {
        await this.octokit.rest.billing.getGithubActionsBillingOrg({ org });
        capabilities.billingRead = { available: true, description: 'Read billing information' };
      } catch (error: any) {
        capabilities.billingRead = { 
          available: false, 
          error: error.message,
          recommendation: 'Requires org owner/billing manager role',
        };
      }

      // Test secret scanning access
      try {
        await this.octokit.rest.secretScanning.listAlertsForOrg({ org, per_page: 1 });
        capabilities.secretScanning = { available: true, description: 'Read secret scanning alerts' };
      } catch (error: any) {
        capabilities.secretScanning = { 
          available: false, 
          error: error.status === 404 ? 'GHAS not enabled' : error.message,
          recommendation: 'Requires GitHub Advanced Security (GHAS)',
        };
      }

      // Test code scanning access
      try {
        await this.octokit.rest.codeScanning.listAlertsForOrg({ org, per_page: 1 });
        capabilities.codeScanning = { available: true, description: 'Read code scanning alerts' };
      } catch (error: any) {
        capabilities.codeScanning = { 
          available: false, 
          error: error.status === 404 ? 'GHAS not enabled' : error.message,
          recommendation: 'Requires GitHub Advanced Security (GHAS)',
        };
      }
    }

    // Test GraphQL access
    try {
      await this.graphqlClient(`query { viewer { login } }`);
      capabilities.graphql = { available: true, description: 'GraphQL API access' };
    } catch (error: any) {
      capabilities.graphql = { 
        available: false, 
        error: error.message,
        recommendation: 'GraphQL access should work with any valid token',
      };
    }

    return capabilities;
  }

  // ============================================
  // Organization-Level APIs (works for all plans)
  // ============================================

  async getActionsUsageMetrics(
    orgName: string,
    timeframe: string,
    breakdown?: string
  ): Promise<any> {
    const since = this.getTimeframeCutoff(timeframe);

    // Get billing data (available for org owners)
    let billingData = null;
    try {
      const { data } = await this.octokit.rest.billing.getGithubActionsBillingOrg({
        org: orgName,
      });
      billingData = data;
    } catch {
      // Billing data not available (requires org owner permissions)
    }

    // Get workflow runs - try org-level first, fallback to repo-level aggregation
    let workflowRuns: { total_count: number; workflow_runs: any[] } = { total_count: 0, workflow_runs: [] };
    
    try {
      const { data } = await this.octokit.request('GET /orgs/{org}/actions/runs', {
        org: orgName,
        created: `>=${since.toISOString().split('T')[0]}`,
        per_page: 100,
      }) as { data: { total_count: number; workflow_runs: any[] } };
      workflowRuns = data;
    } catch {
      // Fallback: aggregate from accessible repos
      const repos = await this.getOrgRepoNames(orgName);
      const allRuns: any[] = [];
      
      for (const repo of repos.slice(0, 10)) {
        try {
          const { data } = await this.octokit.rest.actions.listWorkflowRunsForRepo({
            owner: orgName,
            repo,
            created: `>=${since.toISOString().split('T')[0]}`,
            per_page: 50,
          });
          allRuns.push(...data.workflow_runs);
          workflowRuns.total_count += data.total_count;
        } catch {
          // Skip repos without actions access
        }
      }
      workflowRuns.workflow_runs = allRuns;
    }

    // Analyze workflow runs
    const workflowStats = this.analyzeWorkflowRuns(workflowRuns.workflow_runs, breakdown);

    // Get storage usage
    let storageData = null;
    try {
      const { data } = await this.octokit.rest.billing.getSharedStorageBillingOrg({
        org: orgName,
      });
      storageData = data;
    } catch {
      // Storage billing not available
    }

    return {
      billing: billingData,
      workflowStats,
      storage: storageData,
      timeframe,
      breakdown,
      totalRuns: workflowRuns.total_count,
      runsAnalyzed: workflowRuns.workflow_runs.length,
    };
  }

  async getActionsPerformanceMetrics(
    orgName: string,
    repoName?: string,
    workflowId?: string,
    timeframe: string = '24h'
  ): Promise<any> {
    const since = this.getTimeframeCutoff(timeframe);

    if (repoName) {
      // Get performance for specific repo
      return this.getRepoPerformanceMetrics(orgName, repoName, workflowId, since);
    }

    // Try org-level endpoint first (requires org admin), fall back to repo-level aggregation
    try {
      const { data: workflowRuns } = await this.octokit.request('GET /orgs/{org}/actions/runs', {
        org: orgName,
        created: `>=${since.toISOString().split('T')[0]}`,
        per_page: 100,
      }) as { data: { total_count: number; workflow_runs: any[] } };

      return this.calculatePerformanceMetrics(workflowRuns.workflow_runs);
    } catch (orgError: any) {
      // Fallback: aggregate from accessible repos
      const repos = await this.getOrgRepoNames(orgName);
      const allRuns: any[] = [];
      
      for (const repo of repos.slice(0, 10)) {
        try {
          const { data } = await this.octokit.rest.actions.listWorkflowRunsForRepo({
            owner: orgName,
            repo,
            created: `>=${since.toISOString().split('T')[0]}`,
            per_page: 50,
          });
          allRuns.push(...data.workflow_runs);
        } catch {
          // Skip repos without actions access
        }
      }
      
      return this.calculatePerformanceMetrics(allRuns);
    }
  }

  private async getRepoPerformanceMetrics(
    owner: string,
    repo: string,
    workflowId: string | undefined,
    since: Date
  ): Promise<any> {
    const params: any = {
      owner,
      repo,
      created: `>=${since.toISOString().split('T')[0]}`,
      per_page: 100,
    };

    let runs;
    if (workflowId) {
      const { data } = await this.octokit.rest.actions.listWorkflowRuns({
        ...params,
        workflow_id: workflowId,
      });
      runs = data.workflow_runs;
    } else {
      const { data } = await this.octokit.rest.actions.listWorkflowRunsForRepo(params);
      runs = data.workflow_runs;
    }

    return this.calculatePerformanceMetrics(runs);
  }

  async getRunnerUtilization(
    orgName: string,
    runnerType: 'self-hosted' | 'github-hosted' | 'all' = 'all'
  ): Promise<any> {
    const result: any = {
      selfHostedRunners: null,
      runnerGroups: null,
      summary: {},
    };

    // Get self-hosted runners (available for all plans with admin access)
    if (runnerType !== 'github-hosted') {
      try {
        const { data: runners } = await this.octokit.rest.actions.listSelfHostedRunnersForOrg({
          org: orgName,
          per_page: 100,
        });
        result.selfHostedRunners = runners;
        result.summary.selfHosted = {
          total: runners.total_count,
          online: runners.runners.filter((r) => r.status === 'online').length,
          busy: runners.runners.filter((r) => r.busy).length,
          idle: runners.runners.filter((r) => r.status === 'online' && !r.busy).length,
        };
      } catch {
        console.error('ℹ️ Self-hosted runner data not available');
      }
    }

    // Get runner groups (org-level feature, using request API)
    try {
      const { data: groups } = await this.octokit.request('GET /orgs/{org}/actions/runner-groups', {
        org: orgName,
      });
      result.runnerGroups = groups;
    } catch {
      // Runner groups not available
    }

    return result;
  }

  /**
   * Fetch GitHub-hosted runners for an organization
   * Returns machine specs (CPU, memory, storage) for custom-named larger runners
   * API: GET /orgs/{org}/actions/hosted-runners
   * Requires: manage_runners:org scope or Administration org permission
   */
  async getHostedRunners(orgName: string): Promise<any> {
    try {
      const { data } = await this.octokit.request('GET /orgs/{org}/actions/hosted-runners', {
        org: orgName,
        per_page: 100,
      });
      
      return {
        success: true,
        totalCount: data.total_count || data.runners?.length || 0,
        runners: (data.runners || []).map((runner: any) => ({
          id: runner.id,
          name: runner.name,
          platform: runner.platform,
          status: runner.status,
          machine_size_details: runner.machine_size_details || {
            id: 'unknown',
            cpu_cores: 0,
            memory_gb: 0,
            storage_gb: 0,
          },
          image: runner.image,
          maximum_runners: runner.maximum_runners,
          last_active_on: runner.last_active_on,
        })),
      };
    } catch (error: any) {
      // This API requires specific permissions or Enterprise Cloud
      if (error.status === 404) {
        return {
          success: false,
          error: 'Hosted runners API not available. Requires GitHub Enterprise Cloud and manage_runners:org scope.',
          runners: [],
        };
      }
      if (error.status === 403) {
        return {
          success: false,
          error: 'Permission denied. Requires Administration org permission or manage_runners:org scope.',
          runners: [],
        };
      }
      return {
        success: false,
        error: error.message || 'Unknown error fetching hosted runners',
        runners: [],
      };
    }
  }

  /**
   * Get hosted runner specs lookup for cost calculation
   * Builds a name -> specs map for quick lookup during job cost analysis
   */
  async getHostedRunnerSpecsLookup(orgName: string): Promise<{
    success: boolean;
    lookup: Record<string, { cpuCores: number; memoryGb: number; platform: string; costPerMin: number }>;
    error?: string;
  }> {
    const result = await this.getHostedRunners(orgName);
    
    if (!result.success || !result.runners?.length) {
      return {
        success: false,
        lookup: {},
        error: result.error || 'No hosted runners found',
      };
    }
    
    // Build lookup with cost inference
    const lookup: Record<string, { cpuCores: number; memoryGb: number; platform: string; costPerMin: number }> = {};
    
    // Import pricing inference at runtime to avoid circular deps
    const { inferRunnerFromSpecs } = await import('../pricing/github-runner-catalog.js');
    
    for (const runner of result.runners) {
      const specs = runner.machine_size_details;
      const platform = runner.platform || 'linux-x64';
      
      // Infer cost from machine specs
      const inferred = inferRunnerFromSpecs(specs.cpu_cores, platform, specs.memory_gb);
      const costPerMin = inferred?.costPerMin || 0.008; // Default to standard Linux
      
      lookup[runner.name] = {
        cpuCores: specs.cpu_cores,
        memoryGb: specs.memory_gb,
        platform,
        costPerMin,
      };
    }
    
    return {
      success: true,
      lookup,
    };
  }

  async getActionsCacheMetrics(
    orgName: string,
    repoName?: string,
    timeframe: string = '24h'
  ): Promise<any> {
    // Get organization cache usage
    let orgCacheUsage = null;
    try {
      const { data } = await this.octokit.rest.actions.getActionsCacheUsageForOrg({
        org: orgName,
      });
      orgCacheUsage = data;
    } catch {
      console.error('ℹ️ Organization cache usage not available');
    }

    // Get repo-specific cache if requested
    let repoCacheUsage = null;
    let cacheList = null;
    if (repoName) {
      try {
        const { data: usage } = await this.octokit.rest.actions.getActionsCacheUsage({
          owner: orgName,
          repo: repoName,
        });
        repoCacheUsage = usage;

        const { data: caches } = await this.octokit.rest.actions.getActionsCacheList({
          owner: orgName,
          repo: repoName,
          per_page: 100,
        });
        cacheList = caches;
      } catch {
        // Repo cache data not available
      }
    }

    return {
      organizationUsage: orgCacheUsage,
      repositoryUsage: repoCacheUsage,
      cacheList,
      timeframe,
    };
  }

  async getWorkflowInsights(
    orgName: string,
    repoName: string,
    workflowName: string
  ): Promise<any> {
    // List workflows to find the one we want
    const { data: workflows } = await this.octokit.rest.actions.listRepoWorkflows({
      owner: orgName,
      repo: repoName,
    });

    const workflow = workflows.workflows.find(
      (w) => w.name === workflowName || w.path.includes(workflowName)
    );

    if (!workflow) {
      throw new Error(`Workflow "${workflowName}" not found in ${orgName}/${repoName}`);
    }

    // Get recent runs
    const { data: runs } = await this.octokit.rest.actions.listWorkflowRuns({
      owner: orgName,
      repo: repoName,
      workflow_id: workflow.id,
      per_page: 50,
    });

    // Get timing for recent runs
    const runDetails = await Promise.all(
      runs.workflow_runs.slice(0, 10).map(async (run) => {
        try {
          const { data: timing } = await this.octokit.rest.actions.getWorkflowRunUsage({
            owner: orgName,
            repo: repoName,
            run_id: run.id,
          });
          return { run, timing };
        } catch {
          return { run, timing: null };
        }
      })
    );

    return {
      workflow,
      recentRuns: runDetails,
      totalRuns: runs.total_count,
      successRate: this.calculateSuccessRate(runs.workflow_runs),
    };
  }

  async getTeamProductivityMetrics(
    orgName: string,
    teamSlug?: string,
    timeframe: string = '7d'
  ): Promise<any> {
    const since = this.getTimeframeCutoff(timeframe);

    // Get workflow runs as productivity indicator with error handling
    let workflowRuns: { total_count: number; workflow_runs: any[] } = { total_count: 0, workflow_runs: [] };
    let error: string | undefined;

    try {
      const { data } = await this.octokit.request('GET /orgs/{org}/actions/runs', {
        org: orgName,
        created: `>=${since.toISOString().split('T')[0]}`,
        per_page: 100,
      }) as { data: { total_count: number; workflow_runs: any[] } };
      workflowRuns = data;
    } catch (err: any) {
      error = `Could not fetch workflow runs for org '${orgName}': ${err.message}. Ensure PAT has 'repo' and 'read:org' scopes.`;
      console.error(`ℹ️ ${error}`);
    }

    // Group by actor (user who triggered)
    const byActor = new Map<string, any[]>();
    for (const run of workflowRuns.workflow_runs) {
      const actor = run.actor?.login || 'unknown';
      if (!byActor.has(actor)) {
        byActor.set(actor, []);
      }
      byActor.get(actor)!.push(run);
    }

    // Calculate metrics per actor
    const actorMetrics = Array.from(byActor.entries()).map(([actor, runs]) => ({
      actor,
      totalRuns: runs.length,
      successRate: this.calculateSuccessRate(runs),
      avgDuration: this.calculateAvgDuration(runs),
    }));

    return {
      timeframe,
      error,
      totalWorkflowRuns: workflowRuns.total_count,
      actorMetrics: actorMetrics.sort((a, b) => b.totalRuns - a.totalRuns),
      teamSlug,
    };
  }

  async getComplianceAuditData(
    orgName: string,
    includeSecretsScan: boolean,
    repoFilter?: string[]
  ): Promise<any> {
    const result: any = {
      organization: null,
      secretAlerts: null,
      codeAlerts: null,
      dependabotAlerts: null,
      ghasStatus: [],
      repositories: [],
    };

    // Get organization info
    try {
      const { data: org } = await this.octokit.rest.orgs.get({ org: orgName });
      result.organization = {
        name: org.name,
        login: org.login,
        twoFactorRequirementEnabled: org.two_factor_requirement_enabled,
        defaultRepositoryPermission: org.default_repository_permission,
        membersCanCreateRepositories: org.members_can_create_repositories,
      };
    } catch {
      // Org info not available
    }

    // Get secret scanning alerts if requested and available
    if (includeSecretsScan) {
      try {
        const { data: secrets } = await this.octokit.rest.secretScanning.listAlertsForOrg({
          org: orgName,
          state: 'open',
          per_page: 100,
        });
        const hasMore = secrets.length >= 100;
        result.secretAlerts = {
          total: secrets.length,
          hasMore, // Indicates there may be more alerts beyond pagination limit
          displayCount: hasMore ? '100+' : String(secrets.length),
          alerts: secrets.slice(0, 10), // Return first 10 for summary
        };
      } catch {
        console.error('ℹ️ Secret scanning not available (requires GHAS)');
      }

      // Get code scanning alerts
      try {
        const { data: codeAlerts } = await this.octokit.rest.codeScanning.listAlertsForOrg({
          org: orgName,
          state: 'open',
          per_page: 100,
        });
        const hasMore = codeAlerts.length >= 100;
        result.codeAlerts = {
          total: codeAlerts.length,
          hasMore,
          displayCount: hasMore ? '100+' : String(codeAlerts.length),
          bySeverity: this.groupBySeverity(codeAlerts),
        };
      } catch {
        console.error('ℹ️ Code scanning not available (requires GHAS)');
      }

      // Get Dependabot alerts (available with GHAS or Dependabot enabled)
      try {
        const { data: dependabotAlerts } = await this.octokit.rest.dependabot.listAlertsForOrg({
          org: orgName,
          state: 'open',
          per_page: 100,
        });
        const hasMore = dependabotAlerts.length >= 100;
        result.dependabotAlerts = {
          total: dependabotAlerts.length,
          hasMore,
          displayCount: hasMore ? '100+' : String(dependabotAlerts.length),
          bySeverity: this.groupDependabotBySeverity(dependabotAlerts),
        };
      } catch {
        console.error('ℹ️ Dependabot alerts not available');
      }
    }

    // Get repository security settings - use filter if provided
    try {
      let repoList: any[];
      
      if (repoFilter && repoFilter.length > 0) {
        // Fetch specific repos from the filter
        repoList = await Promise.all(
          repoFilter.map(async (repoName) => {
            try {
              const { data } = await this.octokit.rest.repos.get({
                owner: orgName,
                repo: repoName,
              });
              return data;
            } catch {
              return null;
            }
          })
        ).then(repos => repos.filter(r => r !== null));
      } else {
        // Fall back to top 10 most recently pushed
        const { data: repos } = await this.octokit.rest.repos.listForOrg({
          org: orgName,
          per_page: 10,
          sort: 'pushed',
        });
        repoList = repos;
      }

      result.repositories = await Promise.all(
        repoList.map(async (repo) => {
          let branchProtection = null;
          try {
            const { data } = await this.octokit.rest.repos.getBranchProtection({
              owner: orgName,
              repo: repo.name,
              branch: repo.default_branch || 'main',
            });
            branchProtection = {
              requirePullRequest: !!data.required_pull_request_reviews,
              requiredReviewers: data.required_pull_request_reviews?.required_approving_review_count || 0,
              requireStatusChecks: !!data.required_status_checks,
              enforceAdmins: data.enforce_admins?.enabled || false,
            };
          } catch {
            // Branch protection not set or not accessible
          }

          // Check GHAS enablement status for each repo
          let ghasStatus = {
            name: repo.name,
            secretScanning: repo.security_and_analysis?.secret_scanning?.status === 'enabled',
            secretScanningPushProtection: repo.security_and_analysis?.secret_scanning_push_protection?.status === 'enabled',
            codeScanning: false,
            dependabot: repo.security_and_analysis?.dependabot_security_updates?.status === 'enabled',
          };

          // Check if code scanning is configured by looking for code scanning analyses
          if (includeSecretsScan) {
            try {
              const { data: analyses } = await this.octokit.rest.codeScanning.listRecentAnalyses({
                owner: orgName,
                repo: repo.name,
                per_page: 1,
              });
              ghasStatus.codeScanning = analyses.length > 0;
            } catch {
              // Code scanning not configured or not accessible
            }
          }

          result.ghasStatus.push(ghasStatus);

          return {
            name: repo.name,
            visibility: repo.visibility,
            defaultBranch: repo.default_branch,
            branchProtection,
          };
        })
      );
    } catch {
      // Repos not accessible
    }

    return result;
  }

  async getComprehensiveUsageData(orgName: string): Promise<any> {
    const [usage, performance, runners, cache] = await Promise.all([
      this.getActionsUsageMetrics(orgName, '30d'),
      this.getActionsPerformanceMetrics(orgName, undefined, undefined, '30d'),
      this.getRunnerUtilization(orgName, 'all'),
      this.getActionsCacheMetrics(orgName, undefined, '30d'),
    ]);

    return {
      usage,
      performance,
      runners,
      cache,
      organization: orgName,
      timestamp: new Date().toISOString(),
    };
  }

  async getOrganizationCount(): Promise<number> {
    try {
      const { data } = await this.octokit.rest.orgs.listForAuthenticatedUser();
      return data.length;
    } catch {
      return 1;
    }
  }

  // ============================================
  // Enterprise-Only APIs (optional, enhanced features)
  // ============================================

  async getEnterpriseActionsUsage(): Promise<any> {
    if (!this.isEnterpriseEnabled || !this.enterpriseSlug) {
      return null;
    }

    try {
      const { data } = await this.octokit.request(
        'GET /enterprises/{enterprise}/settings/billing/actions',
        { enterprise: this.enterpriseSlug }
      );
      return data;
    } catch {
      return null;
    }
  }

  // ============================================
  // Helper Methods
  // ============================================

  // ============================================
  // Enhanced GitHub Insights-Style Metrics
  // (Approximates GitHub UI's pre-aggregated data)
  // ============================================

  /**
   * Get detailed usage metrics matching GitHub's Actions Usage Metrics UI
   * Includes: per-workflow, per-job, per-repo, per-OS, per-runner-type breakdowns
   */
  async getDetailedUsageMetrics(
    orgName: string,
    timeframe: string = '30d',
    repoFilter?: string[]
  ): Promise<any> {
    const since = this.getTimeframeCutoff(timeframe);
    const repos = repoFilter || await this.getOrgRepoNames(orgName);

    // Get billing data
    let billingData: any = null;
    try {
      const { data } = await this.octokit.rest.billing.getGithubActionsBillingOrg({ org: orgName });
      billingData = {
        totalMinutesUsed: data.total_minutes_used,
        includedMinutes: data.included_minutes,
        paidMinutesUsed: data.total_paid_minutes_used,
        minutesByOS: data.minutes_used_breakdown,
      };
    } catch { /* Billing not available */ }

    // Aggregate metrics across repos
    const byWorkflow: Record<string, any> = {};
    const byRepository: Record<string, any> = {};
    const byRunnerOS: Record<string, any> = {};
    const byRunnerType: Record<string, any> = { 'github-hosted': { runs: 0, minutes: 0 }, 'self-hosted': { runs: 0, minutes: 0 } };
    const byJob: Record<string, any> = {};

    for (const repoName of repos.slice(0, 15)) {
      try {
        // Get workflow runs
        const { data: runsData } = await this.octokit.rest.actions.listWorkflowRunsForRepo({
          owner: orgName,
          repo: repoName,
          created: `>=${since.toISOString().split('T')[0]}`,
          per_page: 100,
        });

        // Initialize repo stats
        if (!byRepository[repoName]) {
          byRepository[repoName] = { runs: 0, minutes: 0, success: 0, failure: 0 };
        }

        for (const run of runsData.workflow_runs) {
          const workflowName = run.name || 'Unknown';
          const workflowPath = run.path || '';
          const durationMinutes = run.run_started_at && run.updated_at
            ? (new Date(run.updated_at).getTime() - new Date(run.run_started_at).getTime()) / 60000
            : 0;

          // Skip non-workflow items (Dependabot alerts, external security tools)
          // These are identified by:
          // - Names containing "npm_and_yarn", "pip", "composer" (Dependabot package updates)
          // - Names that are file paths like ".devcontainer/devcontainer.json"
          // - Event type is "dependabot" or "code_scanning_default_setup"
          const isNonWorkflow = 
            run.event === 'dependabot' ||
            run.event === 'code_scanning_default_setup' ||
            workflowName.includes('npm_and_yarn') ||
            workflowName.includes('pip in /') ||
            workflowName.includes('composer in /') ||
            workflowName.includes('maven in /') ||
            workflowName.includes('gradle in /') ||
            workflowName.includes('nuget in /') ||
            workflowName.includes('cargo in /') ||
            workflowName.includes('gomod in /') ||
            (workflowName.startsWith('.') && workflowName.endsWith('.json')) ||
            workflowName.length > 100; // Very long names are typically Dependabot grouped updates

          // By workflow (skip non-workflow items)
          if (!isNonWorkflow) {
            if (!byWorkflow[workflowName]) {
              byWorkflow[workflowName] = { runs: 0, minutes: 0, success: 0, failure: 0, repos: new Set(), path: workflowPath, firstRepo: repoName };
            }
            byWorkflow[workflowName].runs++;
            byWorkflow[workflowName].minutes += durationMinutes;
            byWorkflow[workflowName].repos.add(repoName);
            if (run.conclusion === 'success') byWorkflow[workflowName].success++;
            if (run.conclusion === 'failure') byWorkflow[workflowName].failure++;
          }

          // By repository
          byRepository[repoName].runs++;
          byRepository[repoName].minutes += durationMinutes;
          if (run.conclusion === 'success') byRepository[repoName].success++;
          if (run.conclusion === 'failure') byRepository[repoName].failure++;

          // Get job details for more granular breakdown (sample first 5 runs per repo)
          if (byRepository[repoName].runs <= 5) {
            try {
              const { data: jobsData } = await this.octokit.rest.actions.listJobsForWorkflowRun({
                owner: orgName,
                repo: repoName,
                run_id: run.id,
              });

              for (const job of jobsData.jobs) {
                // By job name
                const jobName = job.name;
                if (!byJob[jobName]) {
                  byJob[jobName] = { runs: 0, minutes: 0, success: 0, failure: 0 };
                }
                byJob[jobName].runs++;
                if (job.started_at && job.completed_at) {
                  byJob[jobName].minutes += (new Date(job.completed_at).getTime() - new Date(job.started_at).getTime()) / 60000;
                }
                if (job.conclusion === 'success') byJob[jobName].success++;
                if (job.conclusion === 'failure') byJob[jobName].failure++;

                // Skip jobs that never ran (skipped, cancelled before starting)
                if (!job.started_at) continue;

                // Determine runner name for aggregation
                // - For custom/larger runners: use runner_name (e.g., "tsvi-linux8cores")
                // - For standard GitHub-hosted: use label (e.g., "ubuntu-latest") since runner_name is just instance ID
                const rawRunnerName = (job as any).runner_name || '';
                const isStandardHostedRunner = rawRunnerName.startsWith('GitHub Actions ') || rawRunnerName.match(/^Hosted Agent/);
                
                // Helper to find OS-related label
                const findOSLabel = () => job.labels?.find((l: string) => 
                  ['ubuntu', 'windows', 'macos', 'linux'].some(os => l.toLowerCase().includes(os)));
                
                // Build descriptive fallback name
                const getFallbackName = () => {
                  if (job.labels?.length) return job.labels[0];
                  if (rawRunnerName.toLowerCase().includes('linux')) return 'linux-runner';
                  if (rawRunnerName.toLowerCase().includes('windows')) return 'windows-runner';
                  if (rawRunnerName.toLowerCase().includes('mac')) return 'macos-runner';
                  return 'unidentified-runner';
                };
                
                const runnerOS = isStandardHostedRunner
                  ? (findOSLabel() || job.labels?.[0] || 'github-hosted')
                  : (rawRunnerName || findOSLabel() || getFallbackName());
                if (!byRunnerOS[runnerOS]) {
                  byRunnerOS[runnerOS] = { runs: 0, minutes: 0 };
                }
                byRunnerOS[runnerOS].runs++;
                if (job.completed_at) {
                  byRunnerOS[runnerOS].minutes += (new Date(job.completed_at).getTime() - new Date(job.started_at).getTime()) / 60000;
                }

                // By runner type
                const isSelfHosted = job.labels?.some((l: string) => l === 'self-hosted');
                const runnerTypeKey = isSelfHosted ? 'self-hosted' : 'github-hosted';
                byRunnerType[runnerTypeKey].runs++;
                if (job.started_at && job.completed_at) {
                  byRunnerType[runnerTypeKey].minutes += (new Date(job.completed_at).getTime() - new Date(job.started_at).getTime()) / 60000;
                }
              }
            } catch { /* Job details not available */ }
          }
        }
      } catch { /* Repo not accessible */ }
    }

    // Convert Set to count for workflow repos
    for (const wf of Object.values(byWorkflow)) {
      wf.repoCount = wf.repos.size;
      delete wf.repos;
    }

    return {
      timeframe,
      billing: billingData,
      byWorkflow: Object.entries(byWorkflow)
        .map(([name, stats]) => ({ name, ...stats, minutes: Math.round(stats.minutes) }))
        .sort((a, b) => b.minutes - a.minutes),
      byRepository: Object.entries(byRepository)
        .map(([name, stats]) => ({ name, ...stats, minutes: Math.round(stats.minutes) }))
        .sort((a, b) => b.minutes - a.minutes),
      byJob: Object.entries(byJob)
        .map(([name, stats]) => ({ name, ...stats, minutes: Math.round(stats.minutes) }))
        .sort((a, b) => b.minutes - a.minutes)
        .slice(0, 20),
      byRunnerOS: Object.entries(byRunnerOS)
        .map(([os, stats]) => ({ os, ...stats, minutes: Math.round(stats.minutes) }))
        .sort((a, b) => b.minutes - a.minutes),
      byRunnerType: Object.entries(byRunnerType)
        .map(([type, stats]) => ({ type, ...stats, minutes: Math.round(stats.minutes) })),
      summary: {
        totalWorkflows: Object.keys(byWorkflow).length,
        totalRepos: Object.keys(byRepository).length,
        totalRuns: Object.values(byRepository).reduce((sum: number, r: any) => sum + r.runs, 0),
        totalMinutes: Math.round(Object.values(byRepository).reduce((sum: number, r: any) => sum + r.minutes, 0)),
      },
    };
  }

  /**
   * Get detailed performance metrics matching GitHub's Actions Performance Metrics UI
   * Includes: avg run time, avg queue time, failure rates per workflow/job/repo/OS/runner
   */
  async getDetailedPerformanceMetrics(
    orgName: string,
    timeframe: string = '30d',
    repoFilter?: string[]
  ): Promise<any> {
    const since = this.getTimeframeCutoff(timeframe);
    const repos = repoFilter || await this.getOrgRepoNames(orgName);

    const byWorkflow: Record<string, any> = {};
    const byRepository: Record<string, any> = {};
    const byJob: Record<string, any> = {};
    const byRunnerOS: Record<string, any> = {};
    const byRunnerType: Record<string, any> = { 
      'github-hosted': { runs: 0, durations: [], queueTimes: [], failures: 0 }, 
      'self-hosted': { runs: 0, durations: [], queueTimes: [], failures: 0 } 
    };

    for (const repoName of repos.slice(0, 15)) {
      try {
        const { data: runsData } = await this.octokit.rest.actions.listWorkflowRunsForRepo({
          owner: orgName,
          repo: repoName,
          created: `>=${since.toISOString().split('T')[0]}`,
          per_page: 100,
        });

        // Initialize repo stats
        if (!byRepository[repoName]) {
          byRepository[repoName] = { runs: 0, durations: [], queueTimes: [], failures: 0 };
        }

        for (const run of runsData.workflow_runs) {
          const workflowName = run.name || 'Unknown';
          const workflowPath = run.path || '';
          
          // Skip non-workflow items (Dependabot alerts, external security tools)
          const isNonWorkflow = 
            run.event === 'dependabot' ||
            run.event === 'code_scanning_default_setup' ||
            workflowName.includes('npm_and_yarn') ||
            workflowName.includes('pip in /') ||
            workflowName.includes('composer in /') ||
            workflowName.includes('maven in /') ||
            workflowName.includes('gradle in /') ||
            workflowName.includes('nuget in /') ||
            workflowName.includes('cargo in /') ||
            workflowName.includes('gomod in /') ||
            (workflowName.startsWith('.') && workflowName.endsWith('.json')) ||
            workflowName.length > 100;
          
          if (isNonWorkflow) continue;
          
          // Calculate run duration and queue time
          const queueTimeSeconds = run.created_at && run.run_started_at
            ? (new Date(run.run_started_at).getTime() - new Date(run.created_at).getTime()) / 1000
            : 0;
          const durationSeconds = run.run_started_at && run.updated_at
            ? (new Date(run.updated_at).getTime() - new Date(run.run_started_at).getTime()) / 1000
            : 0;

          // By workflow
          if (!byWorkflow[workflowName]) {
            byWorkflow[workflowName] = { runs: 0, durations: [], queueTimes: [], failures: 0, path: workflowPath, firstRepo: repoName };
          }
          byWorkflow[workflowName].runs++;
          if (durationSeconds > 0) byWorkflow[workflowName].durations.push(durationSeconds);
          if (queueTimeSeconds > 0) byWorkflow[workflowName].queueTimes.push(queueTimeSeconds);
          if (run.conclusion === 'failure') byWorkflow[workflowName].failures++;

          // By repository
          byRepository[repoName].runs++;
          if (durationSeconds > 0) byRepository[repoName].durations.push(durationSeconds);
          if (queueTimeSeconds > 0) byRepository[repoName].queueTimes.push(queueTimeSeconds);
          if (run.conclusion === 'failure') byRepository[repoName].failures++;

          // Get job-level performance (sample first 5 runs per repo)
          if (byRepository[repoName].runs <= 5) {
            try {
              const { data: jobsData } = await this.octokit.rest.actions.listJobsForWorkflowRun({
                owner: orgName,
                repo: repoName,
                run_id: run.id,
              });

              for (const job of jobsData.jobs) {
                const jobName = job.name;
                const jobQueueTime = job.created_at && job.started_at
                  ? (new Date(job.started_at).getTime() - new Date(job.created_at).getTime()) / 1000
                  : 0;
                const jobDuration = job.started_at && job.completed_at
                  ? (new Date(job.completed_at).getTime() - new Date(job.started_at).getTime()) / 1000
                  : 0;

                // By job
                if (!byJob[jobName]) {
                  byJob[jobName] = { runs: 0, durations: [], queueTimes: [], failures: 0 };
                }
                byJob[jobName].runs++;
                if (jobDuration > 0) byJob[jobName].durations.push(jobDuration);
                if (jobQueueTime > 0) byJob[jobName].queueTimes.push(jobQueueTime);
                if (job.conclusion === 'failure') byJob[jobName].failures++;

                // Skip jobs that never ran (skipped, cancelled before starting)
                if (!job.started_at) continue;

                // Determine runner name for aggregation
                // - For custom/larger runners: use runner_name (e.g., "tsvi-linux8cores")
                // - For standard GitHub-hosted: use label (e.g., "ubuntu-latest") since runner_name is just instance ID
                const rawRunnerName2 = (job as any).runner_name || '';
                const isStandardHostedRunner2 = rawRunnerName2.startsWith('GitHub Actions ') || rawRunnerName2.match(/^Hosted Agent/);
                
                // Helper to find OS-related label
                const findOSLabel2 = () => job.labels?.find((l: string) => 
                  ['ubuntu', 'windows', 'macos', 'linux'].some(os => l.toLowerCase().includes(os)));
                
                // Build descriptive fallback name
                const getFallbackName2 = () => {
                  if (job.labels?.length) return job.labels[0];
                  if (rawRunnerName2.toLowerCase().includes('linux')) return 'linux-runner';
                  if (rawRunnerName2.toLowerCase().includes('windows')) return 'windows-runner';
                  if (rawRunnerName2.toLowerCase().includes('mac')) return 'macos-runner';
                  return 'unidentified-runner';
                };
                
                const runnerOS = isStandardHostedRunner2
                  ? (findOSLabel2() || job.labels?.[0] || 'github-hosted')
                  : (rawRunnerName2 || findOSLabel2() || getFallbackName2());
                if (!byRunnerOS[runnerOS]) {
                  byRunnerOS[runnerOS] = { runs: 0, durations: [], queueTimes: [], failures: 0 };
                }
                byRunnerOS[runnerOS].runs++;
                if (jobDuration > 0) byRunnerOS[runnerOS].durations.push(jobDuration);
                if (jobQueueTime > 0) byRunnerOS[runnerOS].queueTimes.push(jobQueueTime);
                if (job.conclusion === 'failure') byRunnerOS[runnerOS].failures++;

                // By runner type
                const isSelfHosted = job.labels?.some((l: string) => l === 'self-hosted');
                const runnerTypeKey = isSelfHosted ? 'self-hosted' : 'github-hosted';
                byRunnerType[runnerTypeKey].runs++;
                if (jobDuration > 0) byRunnerType[runnerTypeKey].durations.push(jobDuration);
                if (jobQueueTime > 0) byRunnerType[runnerTypeKey].queueTimes.push(jobQueueTime);
                if (job.conclusion === 'failure') byRunnerType[runnerTypeKey].failures++;
              }
            } catch { /* Job details not available */ }
          }
        }
      } catch { /* Repo not accessible */ }
    }

    // Helper to calculate aggregated stats
    const calcStats = (data: any) => ({
      runs: data.runs,
      avgDurationSeconds: data.durations.length 
        ? Math.round(data.durations.reduce((a: number, b: number) => a + b, 0) / data.durations.length)
        : 0,
      p95DurationSeconds: data.durations.length ? Math.round(this.percentile(data.durations, 95)) : 0,
      avgQueueTimeSeconds: data.queueTimes.length
        ? Math.round(data.queueTimes.reduce((a: number, b: number) => a + b, 0) / data.queueTimes.length)
        : 0,
      p95QueueTimeSeconds: data.queueTimes.length ? Math.round(this.percentile(data.queueTimes, 95)) : 0,
      failureRate: data.runs ? Math.round((data.failures / data.runs) * 100) : 0,
      failures: data.failures,
    });

    return {
      timeframe,
      byWorkflow: Object.entries(byWorkflow)
        .map(([name, data]) => ({ name, path: data.path, firstRepo: data.firstRepo, ...calcStats(data) }))
        .sort((a, b) => b.runs - a.runs),
      byRepository: Object.entries(byRepository)
        .map(([name, data]) => ({ name, ...calcStats(data) }))
        .sort((a, b) => b.runs - a.runs),
      byJob: Object.entries(byJob)
        .map(([name, data]) => ({ name, ...calcStats(data) }))
        .sort((a, b) => b.runs - a.runs)
        .slice(0, 20),
      byRunnerOS: Object.entries(byRunnerOS)
        .map(([os, data]) => ({ os, ...calcStats(data) }))
        .sort((a, b) => b.runs - a.runs),
      byRunnerType: Object.entries(byRunnerType)
        .map(([type, data]) => ({ type, ...calcStats(data) })),
      summary: {
        totalRuns: Object.values(byRepository).reduce((sum: number, r: any) => sum + r.runs, 0),
        overallAvgDuration: Math.round(
          Object.values(byRepository).reduce((sum: number, r: any) => 
            sum + r.durations.reduce((a: number, b: number) => a + b, 0), 0
          ) / Math.max(1, Object.values(byRepository).reduce((sum: number, r: any) => sum + r.durations.length, 0))
        ),
        overallAvgQueueTime: Math.round(
          Object.values(byRepository).reduce((sum: number, r: any) => 
            sum + r.queueTimes.reduce((a: number, b: number) => a + b, 0), 0
          ) / Math.max(1, Object.values(byRepository).reduce((sum: number, r: any) => sum + r.queueTimes.length, 0))
        ),
        overallFailureRate: Math.round(
          Object.values(byRepository).reduce((sum: number, r: any) => sum + r.failures, 0) /
          Math.max(1, Object.values(byRepository).reduce((sum: number, r: any) => sum + r.runs, 0)) * 100
        ),
      },
    };
  }

  private analyzeWorkflowRuns(runs: any[], breakdown?: string): any {
    const stats: any = {
      total: runs.length,
      byStatus: {},
      byConclusion: {},
      byWorkflow: {},
      byEvent: {},
    };

    for (const run of runs) {
      // By status
      stats.byStatus[run.status] = (stats.byStatus[run.status] || 0) + 1;

      // By conclusion
      if (run.conclusion) {
        stats.byConclusion[run.conclusion] = (stats.byConclusion[run.conclusion] || 0) + 1;
      }

      // By workflow
      const workflowName = run.name || 'unknown';
      if (!stats.byWorkflow[workflowName]) {
        stats.byWorkflow[workflowName] = { count: 0, success: 0, failure: 0 };
      }
      stats.byWorkflow[workflowName].count++;
      if (run.conclusion === 'success') stats.byWorkflow[workflowName].success++;
      if (run.conclusion === 'failure') stats.byWorkflow[workflowName].failure++;

      // By event
      stats.byEvent[run.event] = (stats.byEvent[run.event] || 0) + 1;
    }

    return stats;
  }

  private calculatePerformanceMetrics(runs: any[]): any {
    const completedRuns = runs.filter((r) => r.conclusion && r.run_started_at);

    const durations = completedRuns.map((run) => {
      const start = new Date(run.run_started_at).getTime();
      const end = new Date(run.updated_at).getTime();
      return (end - start) / 1000; // in seconds
    });

    const successRuns = completedRuns.filter((r) => r.conclusion === 'success');
    const failedRuns = completedRuns.filter((r) => r.conclusion === 'failure');

    return {
      totalRuns: runs.length,
      completedRuns: completedRuns.length,
      successRate: completedRuns.length ? (successRuns.length / completedRuns.length * 100).toFixed(1) : 0,
      failureRate: completedRuns.length ? (failedRuns.length / completedRuns.length * 100).toFixed(1) : 0,
      avgDurationSeconds: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0,
      minDurationSeconds: durations.length ? Math.round(Math.min(...durations)) : 0,
      maxDurationSeconds: durations.length ? Math.round(Math.max(...durations)) : 0,
      p95DurationSeconds: durations.length ? Math.round(this.percentile(durations, 95)) : 0,
    };
  }

  private calculateSuccessRate(runs: any[]): number {
    const completed = runs.filter((r) => r.conclusion);
    if (!completed.length) return 0;
    const success = completed.filter((r) => r.conclusion === 'success').length;
    return Math.round((success / completed.length) * 100);
  }

  private calculateAvgDuration(runs: any[]): number {
    const completedRuns = runs.filter((r) => r.run_started_at && r.updated_at);
    if (!completedRuns.length) return 0;

    const durations = completedRuns.map((run) => {
      const start = new Date(run.run_started_at).getTime();
      const end = new Date(run.updated_at).getTime();
      return (end - start) / 1000;
    });

    return Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
  }

  private groupBySeverity(alerts: any[]): Record<string, number> {
    const result: Record<string, number> = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
    };
    for (const alert of alerts) {
      // Code scanning uses rule.security_severity_level or rule.severity
      const severity = (
        alert.rule?.security_severity_level ||
        alert.rule?.severity ||
        'unknown'
      ).toLowerCase();
      if (result[severity] !== undefined) {
        result[severity]++;
      }
    }
    return result;
  }

  private groupDependabotBySeverity(alerts: any[]): Record<string, number> {
    const result: Record<string, number> = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
    };
    for (const alert of alerts) {
      // Dependabot uses security_vulnerability.severity or security_advisory.severity
      const severity = (
        alert.security_vulnerability?.severity ||
        alert.security_advisory?.severity ||
        'unknown'
      ).toLowerCase();
      if (result[severity] !== undefined) {
        result[severity]++;
      }
    }
    return result;
  }

  private percentile(arr: number[], p: number): number {
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[idx] || 0;
  }

  private getTimeframeCutoff(timeframe: string): Date {
    const now = new Date();
    switch (timeframe) {
      case '1h': return subHours(now, 1);
      case '6h': return subHours(now, 6);
      case '24h': return subHours(now, 24);
      case '7d': return subDays(now, 7);
      case '30d': return subDays(now, 30);
      case '90d': return subDays(now, 90);
      default: return subDays(now, 7);
    }
  }

  // ============================================
  // Pull Request & Issue APIs (for DORA metrics)
  // ============================================

  async getPullRequestMetrics(
    orgName: string,
    timeframe: string = '30d',
    repoName?: string
  ): Promise<any> {
    const since = this.getTimeframeCutoff(timeframe);
    const sinceISO = since.toISOString();

    if (repoName) {
      // Get PRs for specific repo
      try {
        return await this.getRepoPullRequestMetrics(orgName, repoName, sinceISO);
      } catch (error: any) {
        console.error(`ℹ️ Could not get PRs for ${orgName}/${repoName}: ${error.message}`);
        return this.analyzePullRequests([], timeframe);
      }
    }

    // Get PRs across org (sample from top repos)
    let repos: any[] = [];
    try {
      const { data } = await this.octokit.rest.repos.listForOrg({
        org: orgName,
        sort: 'pushed',
        per_page: 10,
      });
      repos = data;
    } catch (error: any) {
      console.error(`ℹ️ Could not list repos for org ${orgName}: ${error.message}`);
      return this.analyzePullRequests([], timeframe);
    }

    const allPRs: any[] = [];
    const skippedRepos: string[] = [];
    for (const repo of repos) {
      try {
        const prData = await this.getRepoPullRequestMetrics(orgName, repo.name, sinceISO);
        allPRs.push(...prData.pullRequests);
      } catch (error: any) {
        // Skip repos without PR access but track them
        skippedRepos.push(repo.name);
      }
    }

    if (skippedRepos.length > 0) {
      console.error(`ℹ️ Skipped ${skippedRepos.length} repos without PR access: ${skippedRepos.slice(0, 3).join(', ')}${skippedRepos.length > 3 ? '...' : ''}`);
    }

    return this.analyzePullRequests(allPRs, timeframe);
  }

  private async getRepoPullRequestMetrics(
    owner: string,
    repo: string,
    since: string
  ): Promise<any> {
    // Get merged PRs
    const { data: mergedPRs } = await this.octokit.rest.pulls.list({
      owner,
      repo,
      state: 'closed',
      sort: 'updated',
      direction: 'desc',
      per_page: 100,
    });

    // Filter to recently merged
    const recentMerged = mergedPRs.filter(
      (pr) => pr.merged_at && new Date(pr.merged_at) >= new Date(since)
    );

    // Get open PRs
    const { data: openPRs } = await this.octokit.rest.pulls.list({
      owner,
      repo,
      state: 'open',
      per_page: 50,
    });

    return {
      repo: `${owner}/${repo}`,
      pullRequests: [...recentMerged, ...openPRs],
      merged: recentMerged,
      open: openPRs,
    };
  }

  private analyzePullRequests(prs: any[], timeframe: string): any {
    const merged = prs.filter((pr) => pr.merged_at);
    const open = prs.filter((pr) => pr.state === 'open');

    // Calculate lead times (time from first commit to merge)
    const leadTimes = merged
      .filter((pr) => pr.created_at && pr.merged_at)
      .map((pr) => {
        const created = new Date(pr.created_at).getTime();
        const mergedAt = new Date(pr.merged_at).getTime();
        return (mergedAt - created) / (1000 * 60 * 60); // hours
      });

    // Calculate time to first review
    const reviewTimes: number[] = [];
    // Note: Would need additional API calls for review data

    // Calculate PR size distribution
    const sizes = merged.map((pr) => ({
      additions: pr.additions || 0,
      deletions: pr.deletions || 0,
      total: (pr.additions || 0) + (pr.deletions || 0),
    }));

    return {
      timeframe,
      summary: {
        totalMerged: merged.length,
        totalOpen: open.length,
        avgLeadTimeHours: leadTimes.length
          ? Math.round(leadTimes.reduce((a, b) => a + b, 0) / leadTimes.length)
          : 0,
        medianLeadTimeHours: leadTimes.length
          ? Math.round(this.percentile(leadTimes, 50))
          : 0,
        p95LeadTimeHours: leadTimes.length
          ? Math.round(this.percentile(leadTimes, 95))
          : 0,
      },
      sizeDistribution: {
        small: sizes.filter((s) => s.total < 50).length,
        medium: sizes.filter((s) => s.total >= 50 && s.total < 200).length,
        large: sizes.filter((s) => s.total >= 200 && s.total < 500).length,
        xlarge: sizes.filter((s) => s.total >= 500).length,
      },
      openPRs: open.map((pr) => ({
        number: pr.number,
        title: pr.title,
        author: pr.user?.login,
        createdAt: pr.created_at,
        ageHours: Math.round(
          (Date.now() - new Date(pr.created_at).getTime()) / (1000 * 60 * 60)
        ),
      })),
    };
  }

  async getIssueMetrics(
    orgName: string,
    timeframe: string = '30d',
    repoName?: string,
    labelFilter?: string
  ): Promise<any> {
    const since = this.getTimeframeCutoff(timeframe);
    const sinceISO = since.toISOString();

    if (repoName) {
      return this.getRepoIssueMetrics(orgName, repoName, sinceISO, labelFilter);
    }

    // Get issues across org (sample from top repos)
    let repos: any[] = [];
    try {
      const { data } = await this.octokit.rest.repos.listForOrg({
        org: orgName,
        sort: 'pushed',
        per_page: 10,
      });
      repos = data;
    } catch (error: any) {
      // If we can't list repos, return empty metrics with error info
      return {
        summary: { 
          medianTimeToCloseHours: 0, 
          bugCount: 0,
          error: `Cannot list org repos: ${error.message}`,
        },
        issues: [],
      };
    }

    const allIssues: any[] = [];
    let successCount = 0;
    for (const repo of repos) {
      try {
        const issueData = await this.getRepoIssueMetrics(orgName, repo.name, sinceISO, labelFilter);
        allIssues.push(...issueData.issues);
        successCount++;
      } catch {
        // Skip repos without issue access
      }
    }

    const result = this.analyzeIssues(allIssues, timeframe);
    result.reposScanned = repos.length;
    result.reposWithAccess = successCount;
    return result;
  }

  private async getRepoIssueMetrics(
    owner: string,
    repo: string,
    since: string,
    labelFilter?: string
  ): Promise<any> {
    // Get closed issues
    const { data: closedIssues } = await this.octokit.rest.issues.listForRepo({
      owner,
      repo,
      state: 'closed',
      since,
      labels: labelFilter,
      per_page: 100,
    });

    // Filter out PRs (GitHub API returns PRs in issues endpoint)
    const issuesOnly = closedIssues.filter((issue) => !issue.pull_request);

    // Get open issues
    const { data: openIssues } = await this.octokit.rest.issues.listForRepo({
      owner,
      repo,
      state: 'open',
      labels: labelFilter,
      per_page: 50,
    });

    const openIssuesOnly = openIssues.filter((issue) => !issue.pull_request);

    return {
      repo: `${owner}/${repo}`,
      issues: [...issuesOnly, ...openIssuesOnly],
      closed: issuesOnly,
      open: openIssuesOnly,
    };
  }

  private analyzeIssues(issues: any[], timeframe: string): any {
    const closed = issues.filter((issue) => issue.state === 'closed');
    const open = issues.filter((issue) => issue.state === 'open');

    // Calculate time to close
    const closeTimes = closed
      .filter((issue) => issue.created_at && issue.closed_at)
      .map((issue) => {
        const created = new Date(issue.created_at).getTime();
        const closedAt = new Date(issue.closed_at).getTime();
        return (closedAt - created) / (1000 * 60 * 60); // hours
      });

    // Categorize by labels
    const labelCounts: Record<string, number> = {};
    for (const issue of issues) {
      for (const label of issue.labels || []) {
        const labelName = typeof label === 'string' ? label : label.name;
        if (labelName) {
          labelCounts[labelName] = (labelCounts[labelName] || 0) + 1;
        }
      }
    }

    // Find bugs vs features
    const bugs = issues.filter((issue) =>
      issue.labels?.some((l: any) =>
        (typeof l === 'string' ? l : l.name)?.toLowerCase().includes('bug')
      )
    );

    return {
      timeframe,
      summary: {
        totalClosed: closed.length,
        totalOpen: open.length,
        avgTimeToCloseHours: closeTimes.length
          ? Math.round(closeTimes.reduce((a, b) => a + b, 0) / closeTimes.length)
          : 0,
        medianTimeToCloseHours: closeTimes.length
          ? Math.round(this.percentile(closeTimes, 50))
          : 0,
        bugCount: bugs.length,
      },
      labelDistribution: Object.entries(labelCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([label, count]) => ({ label, count })),
      oldestOpenIssues: open
        .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
        .slice(0, 5)
        .map((issue) => ({
          number: issue.number,
          title: issue.title,
          createdAt: issue.created_at,
          ageDays: Math.round(
            (Date.now() - new Date(issue.created_at).getTime()) / (1000 * 60 * 60 * 24)
          ),
          labels: issue.labels?.map((l: any) => (typeof l === 'string' ? l : l.name)),
        })),
    };
  }

  async getDoraMetrics(
    orgName: string,
    repoName?: string,
    timeframe: string = '30d'
  ): Promise<any> {
    // Gather data from multiple sources with error handling
    const errors: string[] = [];
    let prMetrics: any = { summary: { medianLeadTimeHours: 0, totalMerged: 0 } };
    let issueMetrics: any = { summary: { medianTimeToCloseHours: 0, bugCount: 0 } };
    let workflowMetrics: any = { totalRuns: 0, completedRuns: 0, successRate: '0' };

    try {
      const results = await Promise.allSettled([
        this.getPullRequestMetrics(orgName, timeframe, repoName),
        this.getIssueMetrics(orgName, timeframe, repoName),
        this.getActionsPerformanceMetrics(orgName, repoName, undefined, timeframe),
      ]);

      if (results[0].status === 'fulfilled') {
        prMetrics = results[0].value;
      } else {
        errors.push(`PR metrics: ${results[0].reason?.message || 'Failed to fetch'}`);
      }

      if (results[1].status === 'fulfilled') {
        issueMetrics = results[1].value;
      } else {
        errors.push(`Issue metrics: ${results[1].reason?.message || 'Failed to fetch'}`);
      }

      if (results[2].status === 'fulfilled') {
        workflowMetrics = results[2].value;
      } else {
        errors.push(`Workflow metrics: ${results[2].reason?.message || 'Failed to fetch'}`);
      }
    } catch (error: any) {
      errors.push(`DORA calculation: ${error.message}`);
    }

    // Calculate DORA metrics with null-safety
    const deploymentFrequency = this.calculateDeploymentFrequency(
      workflowMetrics,
      timeframe
    );
    const leadTimeForChanges = prMetrics?.summary?.medianLeadTimeHours || 0;
    const changeFailureRate = this.calculateChangeFailureRate(
      issueMetrics,
      prMetrics
    );
    const timeToRestore = issueMetrics?.summary?.medianTimeToCloseHours || 0;

    // Determine performance levels
    const levels = {
      deploymentFrequency: this.getDeploymentFrequencyLevel(deploymentFrequency),
      leadTime: this.getLeadTimeLevel(leadTimeForChanges),
      changeFailureRate: this.getChangeFailureRateLevel(changeFailureRate),
      timeToRestore: this.getTimeToRestoreLevel(timeToRestore),
    };

    return {
      timeframe,
      errors: errors.length > 0 ? errors : undefined,
      metrics: {
        deploymentFrequency: {
          value: deploymentFrequency,
          unit: 'deploys/day',
          level: levels.deploymentFrequency,
        },
        leadTimeForChanges: {
          value: leadTimeForChanges,
          unit: 'hours',
          level: levels.leadTime,
        },
        changeFailureRate: {
          value: changeFailureRate,
          unit: '%',
          level: levels.changeFailureRate,
        },
        timeToRestore: {
          value: timeToRestore,
          unit: 'hours',
          level: levels.timeToRestore,
        },
      },
      overallLevel: this.calculateOverallDoraLevel(levels),
      details: {
        pullRequests: prMetrics?.summary || {},
        issues: issueMetrics?.summary || {},
        workflows: {
          totalRuns: workflowMetrics?.totalRuns || 0,
          successRate: workflowMetrics?.successRate || '0%',
        },
      },
    };
  }

  private calculateDeploymentFrequency(
    workflowMetrics: any,
    timeframe: string
  ): number {
    const days = timeframe === '7d' ? 7 : timeframe === '30d' ? 30 : 90;
    // Estimate deployments from successful workflow runs
    const successfulRuns = Math.round(
      (workflowMetrics.completedRuns * parseFloat(workflowMetrics.successRate || '0')) / 100
    );
    return Math.round((successfulRuns / days) * 10) / 10;
  }

  private calculateChangeFailureRate(
    issueMetrics: any,
    prMetrics: any
  ): number {
    // Estimate: bugs / merged PRs
    const bugs = issueMetrics.summary.bugCount || 0;
    const merged = prMetrics.summary.totalMerged || 1;
    return Math.round((bugs / merged) * 100);
  }

  private getDeploymentFrequencyLevel(freq: number): string {
    if (freq >= 1) return 'Elite';
    if (freq >= 0.14) return 'High'; // weekly
    if (freq >= 0.03) return 'Medium'; // monthly
    return 'Low';
  }

  private getLeadTimeLevel(hours: number, hasValidData: boolean = true): string {
    // If no valid data or hours is 0, mark as insufficient data
    if (!hasValidData || hours === 0 || hours === null || hours === undefined) {
      return 'Insufficient Data';
    }
    if (hours <= 24) return 'Elite';
    if (hours <= 168) return 'High'; // 1 week
    if (hours <= 720) return 'Medium'; // 1 month
    return 'Low';
  }

  private getChangeFailureRateLevel(rate: number): string {
    if (rate <= 15) return 'Elite';
    if (rate <= 30) return 'High';
    if (rate <= 45) return 'Medium';
    return 'Low';
  }

  private getTimeToRestoreLevel(hours: number): string {
    if (hours <= 1) return 'Elite';
    if (hours <= 24) return 'High';
    if (hours <= 168) return 'Medium'; // 1 week
    return 'Low';
  }

  private calculateOverallDoraLevel(levels: Record<string, string>): string {
    const scores: Record<string, number> = {
      'Elite': 4,
      'High': 3,
      'Medium': 2,
      'Low': 1,
      'Insufficient Data': 0, // Exclude from scoring
    };
    
    // Filter out metrics with insufficient data for fair scoring
    const validLevels = Object.values(levels).filter(level => level !== 'Insufficient Data');
    
    if (validLevels.length === 0) {
      return 'Insufficient Data';
    }
    
    const avg = validLevels.reduce((sum, level) => sum + (scores[level] || 0), 0) / validLevels.length;
    
    if (avg >= 3.5) return 'Elite';
    if (avg >= 2.5) return 'High';
    if (avg >= 1.5) return 'Medium';
    return 'Low';
  }

  // ============================================
  // Deployments API (Critical for accurate DORA)
  // ============================================

  async getDeploymentMetrics(
    orgName: string,
    timeframe: string = '30d',
    environment?: string,
    repoFilter?: string[]
  ): Promise<any> {
    const since = this.getTimeframeCutoff(timeframe);
    const repos = repoFilter || await this.getOrgRepoNames(orgName);

    const allDeployments: any[] = [];
    const environmentStats: Record<string, any> = {};

    for (const repoName of repos.slice(0, 20)) {
      try {
        // Get deployments
        const { data: deployments } = await this.octokit.repos.listDeployments({
          owner: orgName,
          repo: repoName,
          environment: environment,
          per_page: 100,
        });

        for (const deployment of deployments) {
          if (new Date(deployment.created_at) < since) continue;

          // Get deployment statuses
          const { data: statuses } = await this.octokit.repos.listDeploymentStatuses({
            owner: orgName,
            repo: repoName,
            deployment_id: deployment.id,
            per_page: 10,
          });

          const latestStatus = statuses[0];
          const env = deployment.environment || 'unknown';

          if (!environmentStats[env]) {
            environmentStats[env] = {
              total: 0,
              success: 0,
              failure: 0,
              inProgress: 0,
              durations: [],
            };
          }

          environmentStats[env].total++;

          if (latestStatus?.state === 'success') {
            environmentStats[env].success++;
            // Calculate deployment duration if possible
            if (deployment.created_at && latestStatus.created_at) {
              const duration = new Date(latestStatus.created_at).getTime() - new Date(deployment.created_at).getTime();
              environmentStats[env].durations.push(duration / 1000);
            }
          } else if (latestStatus?.state === 'failure' || latestStatus?.state === 'error') {
            environmentStats[env].failure++;
          } else if (latestStatus?.state === 'in_progress' || latestStatus?.state === 'pending') {
            environmentStats[env].inProgress++;
          }

          allDeployments.push({
            id: deployment.id,
            repo: repoName,
            environment: env,
            ref: deployment.ref,
            sha: deployment.sha?.substring(0, 7),
            creator: deployment.creator?.login,
            createdAt: deployment.created_at,
            status: latestStatus?.state || 'unknown',
            description: deployment.description,
          });
        }
      } catch (err) {
        // Repository may not have deployments
      }
    }

    // Calculate aggregated metrics
    const totalDeployments = allDeployments.length;
    const daysInTimeframe = this.getTimeframeDays(timeframe);
    const deploymentFrequency = totalDeployments / daysInTimeframe;

    const environments = Object.entries(environmentStats).map(([env, stats]) => ({
      name: env,
      total: stats.total,
      successRate: stats.total ? Math.round((stats.success / stats.total) * 100) : 0,
      failureRate: stats.total ? Math.round((stats.failure / stats.total) * 100) : 0,
      avgDurationSeconds: stats.durations.length 
        ? Math.round(stats.durations.reduce((a: number, b: number) => a + b, 0) / stats.durations.length)
        : 0,
    }));

    // Production deployments specifically
    const prodEnvs = ['production', 'prod', 'prd'];
    const productionStats = Object.entries(environmentStats)
      .filter(([env]) => prodEnvs.some(p => env.toLowerCase().includes(p)))
      .reduce((acc, [_, stats]) => ({
        total: acc.total + stats.total,
        success: acc.success + stats.success,
        failure: acc.failure + stats.failure,
      }), { total: 0, success: 0, failure: 0 });

    return {
      timeframe,
      summary: {
        totalDeployments,
        deploymentFrequency: deploymentFrequency.toFixed(2),
        frequencyUnit: 'per day',
        productionDeployments: productionStats.total,
        productionSuccessRate: productionStats.total 
          ? Math.round((productionStats.success / productionStats.total) * 100) 
          : 0,
        changeFailureRate: productionStats.total
          ? Math.round((productionStats.failure / productionStats.total) * 100)
          : 0,
      },
      environments,
      recentDeployments: allDeployments
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 10),
    };
  }

  // ============================================
  // Environments API
  // ============================================

  async getEnvironmentMetrics(orgName: string, repoFilter?: string[]): Promise<any> {
    const repos = repoFilter || await this.getOrgRepoNames(orgName);
    const environments: any[] = [];

    for (const repoName of repos.slice(0, 20)) {
      try {
        const { data } = await this.octokit.request('GET /repos/{owner}/{repo}/environments', {
          owner: orgName,
          repo: repoName,
        });

        for (const env of data.environments || []) {
          environments.push({
            repo: repoName,
            name: env.name,
            url: env.html_url,
            createdAt: env.created_at,
            updatedAt: env.updated_at,
            protectionRules: env.protection_rules?.map((rule: any) => ({
              type: rule.type,
              waitTimer: rule.wait_timer,
              reviewers: rule.reviewers?.length || 0,
            })) || [],
            deploymentBranchPolicy: env.deployment_branch_policy ? {
              protectedBranches: env.deployment_branch_policy.protected_branches,
              customBranchPolicies: env.deployment_branch_policy.custom_branch_policies,
            } : null,
          });
        }
      } catch (err) {
        // Repository may not have environments configured
      }
    }

    // Aggregate environment statistics
    const envByName: Record<string, any[]> = {};
    for (const env of environments) {
      if (!envByName[env.name]) {
        envByName[env.name] = [];
      }
      envByName[env.name].push(env);
    }

    const summary = Object.entries(envByName).map(([name, envs]) => ({
      name,
      count: envs.length,
      repos: envs.map(e => e.repo),
      hasProtection: envs.some(e => e.protectionRules.length > 0),
      hasReviewers: envs.some(e => e.protectionRules.some((r: any) => r.reviewers > 0)),
      hasWaitTimer: envs.some(e => e.protectionRules.some((r: any) => r.waitTimer > 0)),
    }));

    return {
      totalEnvironments: environments.length,
      uniqueEnvironmentNames: Object.keys(envByName).length,
      environmentSummary: summary,
      environments,
    };
  }

  // ============================================
  // Discussions API
  // ============================================

  async getDiscussionMetrics(
    orgName: string,
    timeframe: string = '30d',
    repoName?: string
  ): Promise<any> {
    // Note: Discussions require GraphQL API for full access
    // This uses the REST API which has limited discussion support
    const since = this.getTimeframeCutoff(timeframe);
    const repos = repoName ? [repoName] : await this.getOrgRepoNames(orgName);

    const discussions: any[] = [];
    let totalAnswered = 0;
    let totalUnanswered = 0;
    const categoryStats: Record<string, number> = {};

    for (const repo of repos.slice(0, 10)) {
      try {
        // Try to get discussions via REST (limited)
        const { data } = await this.octokit.request('GET /repos/{owner}/{repo}/discussions', {
          owner: orgName,
          repo: repo,
          per_page: 50,
        });

        for (const discussion of data || []) {
          if (new Date(discussion.created_at) < since) continue;

          const category = discussion.category?.name || 'Uncategorized';
          categoryStats[category] = (categoryStats[category] || 0) + 1;

          if (discussion.answer_chosen_at) {
            totalAnswered++;
          } else {
            totalUnanswered++;
          }

          discussions.push({
            repo,
            number: discussion.number,
            title: discussion.title,
            author: discussion.user?.login,
            category,
            state: discussion.state,
            isAnswered: !!discussion.answer_chosen_at,
            comments: discussion.comments,
            reactions: discussion.reactions?.total_count || 0,
            createdAt: discussion.created_at,
            updatedAt: discussion.updated_at,
          });
        }
      } catch (err) {
        // Repository may not have discussions enabled
      }
    }

    const totalDiscussions = discussions.length;
    const answerRate = totalDiscussions 
      ? Math.round((totalAnswered / totalDiscussions) * 100)
      : 0;

    return {
      timeframe,
      summary: {
        totalDiscussions,
        answered: totalAnswered,
        unanswered: totalUnanswered,
        answerRate,
        avgCommentsPerDiscussion: totalDiscussions
          ? (discussions.reduce((sum, d) => sum + d.comments, 0) / totalDiscussions).toFixed(1)
          : 0,
      },
      categoryDistribution: Object.entries(categoryStats)
        .map(([category, count]) => ({ category, count }))
        .sort((a, b) => b.count - a.count),
      recentDiscussions: discussions
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 10),
      unansweredDiscussions: discussions
        .filter(d => !d.isAnswered)
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
        .slice(0, 5),
    };
  }

  // ============================================
  // Merge Queue API
  // ============================================

  async getMergeQueueMetrics(
    orgName: string,
    repoName?: string,
    timeframe: string = '30d'
  ): Promise<any> {
    const repos = repoName ? [repoName] : await this.getOrgRepoNames(orgName);
    const mergeQueueData: any[] = [];

    for (const repo of repos.slice(0, 10)) {
      try {
        // Check repository settings for merge queue
        const { data: repoData } = await this.octokit.repos.get({
          owner: orgName,
          repo: repo,
        });

        // Get branch protection rules which include merge queue settings
        const defaultBranch = repoData.default_branch;
        
        try {
          const { data: protection } = await this.octokit.repos.getBranchProtection({
            owner: orgName,
            repo: repo,
            branch: defaultBranch,
          });

          // Get merge queue entries if enabled
          try {
            const { data: queue } = await this.octokit.request('GET /repos/{owner}/{repo}/merge-queue/{branch}', {
              owner: orgName,
              repo: repo,
              branch: defaultBranch,
            });

            mergeQueueData.push({
              repo,
              branch: defaultBranch,
              enabled: true,
              queueLength: queue.entries?.length || 0,
              entries: queue.entries?.map((entry: any) => ({
                position: entry.position,
                prNumber: entry.pull_request?.number,
                prTitle: entry.pull_request?.title,
                author: entry.pull_request?.user?.login,
                addedAt: entry.enqueued_at,
                headSha: entry.head_sha?.substring(0, 7),
              })) || [],
              groupingStrategy: protection.required_pull_request_reviews?.require_last_push_approval 
                ? 'ALLGREEN' 
                : 'HEADGREEN',
            });
          } catch {
            // Merge queue might not be enabled for this branch
            mergeQueueData.push({
              repo,
              branch: defaultBranch,
              enabled: false,
              queueLength: 0,
              entries: [],
            });
          }
        } catch {
          // No branch protection
        }
      } catch (err) {
        // Skip repos we can't access
      }
    }

    const enabledRepos = mergeQueueData.filter(r => r.enabled);
    const totalInQueue = enabledRepos.reduce((sum, r) => sum + r.queueLength, 0);

    return {
      timeframe,
      summary: {
        reposAnalyzed: mergeQueueData.length,
        reposWithMergeQueue: enabledRepos.length,
        totalPRsInQueue: totalInQueue,
        adoptionRate: mergeQueueData.length 
          ? Math.round((enabledRepos.length / mergeQueueData.length) * 100)
          : 0,
      },
      queueDetails: mergeQueueData.filter(r => r.enabled),
      reposWithoutMergeQueue: mergeQueueData
        .filter(r => !r.enabled)
        .map(r => r.repo),
    };
  }

  // ============================================
  // Enhanced DORA with Real Deployments
  // ============================================

  async getEnhancedDoraMetrics(
    orgName: string,
    timeframe: string = '30d',
    repoFilter?: string[]
  ): Promise<any> {
    // Get real deployment data with error handling
    let deploymentData: any = { summary: { deploymentFrequency: '0', changeFailureRate: 0, productionDeployments: 0 }, environments: [], recentDeployments: [] };
    let prData: any = { summary: { medianLeadTimeHours: 0 } };
    let issueData: any = { closedIssues: [] };

    const errors: string[] = [];

    try {
      deploymentData = await this.getDeploymentMetrics(orgName, timeframe, undefined, repoFilter);
    } catch (error: any) {
      errors.push(`Deployments: ${error.message}`);
    }

    try {
      prData = await this.getPullRequestMetrics(orgName, timeframe, repoFilter?.[0]);
    } catch (error: any) {
      errors.push(`Pull Requests: ${error.message}`);
    }

    try {
      issueData = await this.getIssueMetrics(orgName, timeframe, repoFilter?.[0]);
    } catch (error: any) {
      errors.push(`Issues: ${error.message}`);
    }

    // Use actual deployment data for DORA metrics with null-safety
    const deploymentFrequency = parseFloat(deploymentData?.summary?.deploymentFrequency || '0') || 0;
    const changeFailureRate = deploymentData?.summary?.changeFailureRate || 0;
    
    // Lead Time calculation with fallback approaches
    // Primary: PR lead time from created to merged
    let leadTimeHours = prData?.summary?.medianLeadTimeHours || 0;
    let leadTimeSource = 'pr-lifecycle';
    let hasValidLeadTimeData = leadTimeHours > 0;
    
    // Fallback: Calculate from deployment duration if PR data is missing
    if (!hasValidLeadTimeData && deploymentData?.environments?.length > 0) {
      const allDurations = deploymentData.environments
        .filter((e: any) => e.avgDurationSeconds > 0)
        .map((e: any) => e.avgDurationSeconds / 3600); // Convert seconds to hours
      
      if (allDurations.length > 0) {
        // Use deployment duration as a proxy (though this is deployment time, not lead time)
        // This is noted in the source indicator
        leadTimeHours = allDurations.reduce((a: number, b: number) => a + b, 0) / allDurations.length;
        leadTimeSource = 'deployment-duration-proxy';
        hasValidLeadTimeData = leadTimeHours > 0;
      }
    }
    
    // If still no data, mark as unavailable
    if (!hasValidLeadTimeData) {
      leadTimeSource = 'no-data';
    }

    // Estimate time to restore from bug issues
    const bugIssues = (issueData?.closedIssues || []).filter((i: any) => 
      i.labels?.some((l: any) => 
        ['bug', 'incident', 'outage', 'production'].includes(l.name?.toLowerCase())
      )
    );
    const avgBugResolutionHours = bugIssues.length 
      ? bugIssues.reduce((sum: number, i: any) => sum + (i.timeToCloseHours || 0), 0) / bugIssues.length
      : 24;

    const levels = {
      deploymentFrequency: this.getDeploymentFrequencyLevel(deploymentFrequency),
      leadTime: this.getLeadTimeLevel(leadTimeHours, hasValidLeadTimeData),
      changeFailureRate: this.getChangeFailureRateLevel(changeFailureRate),
      timeToRestore: this.getTimeToRestoreLevel(avgBugResolutionHours),
    };

    // Calculate failed deployments with null-safety
    const environments = deploymentData?.environments || [];
    const failedDeployments = environments
      .filter((e: any) => e?.name?.toLowerCase()?.includes('prod'))
      .reduce((sum: any, e: any) => sum + Math.round((e?.total || 0) * (e?.failureRate || 0) / 100), 0);

    return {
      timeframe,
      dataSource: 'deployments-api',
      errors: errors.length > 0 ? errors : undefined,
      metrics: {
        deploymentFrequency: {
          value: deploymentFrequency.toFixed(2),
          unit: 'per day',
          level: levels.deploymentFrequency,
          productionDeployments: deploymentData?.summary?.productionDeployments || 0,
        },
        leadTimeForChanges: {
          value: leadTimeHours,
          unit: 'hours',
          level: levels.leadTime,
          source: leadTimeSource,
          hasValidData: hasValidLeadTimeData,
        },
        changeFailureRate: {
          value: changeFailureRate,
          unit: '%',
          level: levels.changeFailureRate,
          failedDeployments,
        },
        timeToRestore: {
          value: avgBugResolutionHours,
          unit: 'hours',
          level: levels.timeToRestore,
          incidentCount: bugIssues.length,
        },
      },
      overallLevel: this.calculateOverallDoraLevel(levels),
      environments,
      recentDeployments: deploymentData?.recentDeployments || [],
    };
  }

  private getTimeframeDays(timeframe: string): number {
    switch (timeframe) {
      case '1h': return 1/24;
      case '6h': return 0.25;
      case '24h': return 1;
      case '7d': return 7;
      case '30d': return 30;
      case '90d': return 90;
      default: return 30;
    }
  }

  private async getOrgRepoNames(orgName: string): Promise<string[]> {
    try {
      const { data: repos } = await this.octokit.repos.listForOrg({
        org: orgName,
        per_page: 100,
        sort: 'pushed',
        direction: 'desc',
      });
      return repos.map(r => r.name);
    } catch {
      return [];
    }
  }

  // ============================================
  // Custom Properties API
  // ============================================

  async getOrgCustomProperties(orgName: string): Promise<any> {
    try {
      // Get organization custom property definitions
      const { data: properties } = await this.octokit.request('GET /orgs/{org}/properties/schema', {
        org: orgName,
      });

      return {
        properties: properties.map((prop: any) => ({
          name: prop.property_name,
          valueType: prop.value_type,
          required: prop.required,
          defaultValue: prop.default_value,
          description: prop.description,
          allowedValues: prop.allowed_values,
        })),
        count: properties.length,
      };
    } catch (err: any) {
      if (err.status === 404) {
        return { properties: [], count: 0, message: 'Custom properties not enabled for this organization' };
      }
      throw err;
    }
  }

  async getRepositoryCustomProperties(
    orgName: string,
    repoName?: string
  ): Promise<any> {
    const repos = repoName ? [repoName] : await this.getOrgRepoNames(orgName);
    const repoProperties: any[] = [];

    for (const repo of repos.slice(0, 50)) {
      try {
        const { data: properties } = await this.octokit.request('GET /repos/{owner}/{repo}/properties/values', {
          owner: orgName,
          repo: repo,
        });

        const propsMap: Record<string, any> = {};
        for (const prop of properties || []) {
          propsMap[prop.property_name] = prop.value;
        }

        repoProperties.push({
          repo,
          properties: propsMap,
          propertyCount: Object.keys(propsMap).length,
        });
      } catch {
        // Repository may not have custom properties
        repoProperties.push({
          repo,
          properties: {},
          propertyCount: 0,
        });
      }
    }

    return {
      totalRepos: repoProperties.length,
      reposWithProperties: repoProperties.filter(r => r.propertyCount > 0).length,
      repositories: repoProperties,
    };
  }

  async getReposByCustomProperty(
    orgName: string,
    propertyName: string,
    propertyValue?: string
  ): Promise<any> {
    try {
      // Use the custom properties search endpoint
      const queryParams: any = {
        org: orgName,
        per_page: 100,
      };

      // Get all repos and filter by custom property
      const allRepoProps = await this.getRepositoryCustomProperties(orgName);
      
      const matchingRepos = allRepoProps.repositories.filter((r: any) => {
        if (!r.properties[propertyName]) return false;
        if (propertyValue) {
          const value = r.properties[propertyName];
          if (Array.isArray(value)) {
            return value.includes(propertyValue);
          }
          return value === propertyValue;
        }
        return true;
      });

      // Group by property value
      const groupedByValue: Record<string, string[]> = {};
      for (const repo of matchingRepos) {
        const value = String(repo.properties[propertyName]);
        if (!groupedByValue[value]) {
          groupedByValue[value] = [];
        }
        groupedByValue[value].push(repo.repo);
      }

      return {
        propertyName,
        propertyValue: propertyValue || 'all',
        matchingRepos: matchingRepos.length,
        repositories: matchingRepos.map((r: any) => ({
          name: r.repo,
          value: r.properties[propertyName],
        })),
        groupedByValue,
      };
    } catch (err: any) {
      return {
        error: err.message,
        propertyName,
        matchingRepos: 0,
        repositories: [],
      };
    }
  }

  async getCustomPropertiesAnalytics(orgName: string): Promise<any> {
    // Get property definitions
    const propertyDefs = await this.getOrgCustomProperties(orgName);
    
    // Get all repo properties
    const allRepoProps = await this.getRepositoryCustomProperties(orgName);

    // Analyze property usage
    const propertyUsage: Record<string, {
      defined: number;
      undefined: number;
      values: Record<string, number>;
    }> = {};

    for (const prop of propertyDefs.properties) {
      propertyUsage[prop.name] = {
        defined: 0,
        undefined: 0,
        values: {},
      };
    }

    for (const repo of allRepoProps.repositories) {
      for (const prop of propertyDefs.properties) {
        const value = repo.properties[prop.name];
        if (value !== undefined && value !== null && value !== '') {
          propertyUsage[prop.name].defined++;
          const valueStr = Array.isArray(value) ? value.join(', ') : String(value);
          propertyUsage[prop.name].values[valueStr] = 
            (propertyUsage[prop.name].values[valueStr] || 0) + 1;
        } else {
          propertyUsage[prop.name].undefined++;
        }
      }
    }

    // Calculate coverage
    const totalRepos = allRepoProps.totalRepos;
    const propertyCoverage = Object.entries(propertyUsage).map(([name, usage]) => ({
      property: name,
      coverage: totalRepos ? Math.round((usage.defined / totalRepos) * 100) : 0,
      defined: usage.defined,
      undefined: usage.undefined,
      topValues: Object.entries(usage.values)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([value, count]) => ({ value, count })),
    }));

    return {
      totalRepositories: totalRepos,
      totalProperties: propertyDefs.count,
      propertyDefinitions: propertyDefs.properties,
      propertyCoverage,
      reposWithNoProperties: allRepoProps.repositories
        .filter((r: any) => r.propertyCount === 0)
        .map((r: any) => r.repo),
    };
  }

  /**
   * Fetch workflow file content from a repository
   */
  async getWorkflowFileContent(
    org: string,
    repo: string,
    workflowPath?: string
  ): Promise<{
    workflows: Array<{
      name: string;
      path: string;
      content: string;
      sha: string;
    }>;
    repo: string;
    error?: string;
  }> {
    const workflows: Array<{
      name: string;
      path: string;
      content: string;
      sha: string;
    }> = [];

    try {
      // If a specific path is provided, fetch just that file
      if (workflowPath) {
        const { data } = await this.octokit.rest.repos.getContent({
          owner: org,
          repo,
          path: workflowPath,
        });

        if ('content' in data && data.type === 'file') {
          const content = Buffer.from(data.content, 'base64').toString('utf-8');
          workflows.push({
            name: data.name,
            path: data.path,
            content,
            sha: data.sha,
          });
        }
      } else {
        // List all workflows in .github/workflows
        try {
          const { data: files } = await this.octokit.rest.repos.getContent({
            owner: org,
            repo,
            path: '.github/workflows',
          });

          if (Array.isArray(files)) {
            // Fetch content for each workflow file (limit to 10 to avoid rate limits)
            const yamlFiles = files
              .filter(f => f.type === 'file' && (f.name.endsWith('.yml') || f.name.endsWith('.yaml')))
              .slice(0, 10);

            for (const file of yamlFiles) {
              try {
                const { data } = await this.octokit.rest.repos.getContent({
                  owner: org,
                  repo,
                  path: file.path,
                });

                if ('content' in data && data.type === 'file') {
                  const content = Buffer.from(data.content, 'base64').toString('utf-8');
                  workflows.push({
                    name: data.name,
                    path: data.path,
                    content,
                    sha: data.sha,
                  });
                }
              } catch {
                // Skip files we can't read
              }
            }
          }
        } catch {
          return {
            workflows: [],
            repo,
            error: 'No .github/workflows directory found',
          };
        }
      }

      return { workflows, repo };
    } catch (error: any) {
      return {
        workflows: [],
        repo,
        error: error.message || 'Failed to fetch workflow files',
      };
    }
  }

  /**
   * Analyze workflow file content for optimization opportunities
   */
  analyzeWorkflowContent(content: string, fileName: string): {
    name: string;
    triggers: string[];
    jobs: Array<{
      name: string;
      runsOn: string;
      steps: number;
      hasCache: boolean;
      hasConcurrency: boolean;
      hasTimeout: boolean;
      hasMatrix: boolean;
      uses: string[];
    }>;
    issues: Array<{
      severity: 'high' | 'medium' | 'low';
      category: string;
      message: string;
      line?: number;
      suggestion?: string;
    }>;
    optimizations: Array<{
      type: string;
      description: string;
      impact: 'high' | 'medium' | 'low';
      codeExample?: string;
    }>;
  } {
    const issues: Array<{
      severity: 'high' | 'medium' | 'low';
      category: string;
      message: string;
      line?: number;
      suggestion?: string;
    }> = [];

    const optimizations: Array<{
      type: string;
      description: string;
      impact: 'high' | 'medium' | 'low';
      codeExample?: string;
    }> = [];

    // Parse YAML basics (simple regex-based analysis)
    const lines = content.split('\n');
    
    // Extract workflow name
    const nameMatch = content.match(/^name:\s*(.+)$/m);
    const workflowName = nameMatch ? nameMatch[1].trim().replace(/['"]/g, '') : fileName;

    // Extract triggers
    const triggers: string[] = [];
    const onMatch = content.match(/^on:\s*$/m) || content.match(/^on:\s*\[.+\]/m) || content.match(/^on:\s*\w+/m);
    if (onMatch) {
      // Simple trigger detection
      if (content.includes('push:')) triggers.push('push');
      if (content.includes('pull_request:') || content.includes('pull_request_target:')) triggers.push('pull_request');
      if (content.includes('schedule:')) triggers.push('schedule');
      if (content.includes('workflow_dispatch:')) triggers.push('workflow_dispatch');
      if (content.includes('workflow_call:')) triggers.push('workflow_call');
      if (content.includes('release:')) triggers.push('release');
    }

    // Extract jobs
    const jobs: Array<{
      name: string;
      runsOn: string;
      steps: number;
      hasCache: boolean;
      hasConcurrency: boolean;
      hasTimeout: boolean;
      hasMatrix: boolean;
      uses: string[];
    }> = [];

    // Simple job detection
    const jobMatches = content.matchAll(/^\s{2}(\w+[-\w]*):\s*$/gm);
    let inJobs = false;
    let currentJobIndent = -1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      if (line.match(/^jobs:\s*$/)) {
        inJobs = true;
        continue;
      }

      if (inJobs && line.match(/^\s{2}[\w-]+:\s*$/)) {
        const jobName = line.trim().replace(':', '');
        
        // Look ahead to extract job details
        let runsOn = 'unknown';
        let stepCount = 0;
        let hasCache = false;
        let hasConcurrency = false;
        let hasTimeout = false;
        let hasMatrix = false;
        const uses: string[] = [];

        for (let j = i + 1; j < lines.length && j < i + 100; j++) {
          const jobLine = lines[j];
          
          // Check if we've exited this job (new job at same indent)
          if (jobLine.match(/^\s{2}[\w-]+:\s*$/) && j !== i) break;
          
          // runs-on
          const runsOnMatch = jobLine.match(/runs-on:\s*(.+)/);
          if (runsOnMatch) runsOn = runsOnMatch[1].trim();
          
          // steps count
          if (jobLine.match(/^\s{6,8}-\s+(name:|uses:|run:)/)) stepCount++;
          
          // cache detection
          if (jobLine.includes('actions/cache@') || jobLine.includes('cache:')) hasCache = true;
          
          // concurrency
          if (jobLine.includes('concurrency:')) hasConcurrency = true;
          
          // timeout
          if (jobLine.includes('timeout-minutes:')) hasTimeout = true;
          
          // matrix
          if (jobLine.includes('matrix:')) hasMatrix = true;
          
          // uses actions
          const usesMatch = jobLine.match(/uses:\s*(.+)/);
          if (usesMatch) uses.push(usesMatch[1].trim());
        }

        jobs.push({
          name: jobName,
          runsOn,
          steps: stepCount || 1,
          hasCache,
          hasConcurrency,
          hasTimeout,
          hasMatrix,
          uses,
        });
      }
    }

    // Analyze for issues and optimizations
    
    // Check for missing caching
    const hasNodeSetup = content.includes('actions/setup-node');
    const hasPythonSetup = content.includes('actions/setup-python');
    const hasJavaSetup = content.includes('actions/setup-java');
    const hasGoSetup = content.includes('actions/setup-go');
    const hasAnyCache = content.includes('actions/cache@') || content.includes('cache:');
    
    if ((hasNodeSetup || hasPythonSetup || hasJavaSetup || hasGoSetup) && !hasAnyCache) {
      issues.push({
        severity: 'high',
        category: 'performance',
        message: 'No caching configured for package dependencies',
        suggestion: 'Add caching to reduce workflow run time significantly',
      });
      
      if (hasNodeSetup) {
        optimizations.push({
          type: 'caching',
          description: 'Add npm/yarn/pnpm caching using setup-node cache option',
          impact: 'high',
          codeExample: `- uses: actions/setup-node@v4
  with:
    node-version: '20'
    cache: 'npm'  # or 'yarn' or 'pnpm'`,
        });
      }
      
      if (hasPythonSetup) {
        optimizations.push({
          type: 'caching',
          description: 'Add pip caching using setup-python cache option',
          impact: 'high',
          codeExample: `- uses: actions/setup-python@v5
  with:
    python-version: '3.12'
    cache: 'pip'`,
        });
      }
    }

    // Check for missing concurrency
    if (!content.includes('concurrency:') && (triggers.includes('push') || triggers.includes('pull_request'))) {
      issues.push({
        severity: 'medium',
        category: 'efficiency',
        message: 'No concurrency control - parallel runs may waste resources',
        suggestion: 'Add concurrency group to cancel outdated runs',
      });
      
      optimizations.push({
        type: 'concurrency',
        description: 'Add concurrency group to cancel in-progress runs when new commits are pushed',
        impact: 'medium',
        codeExample: `concurrency:
  group: \${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: true`,
      });
    }

    // Check for missing timeout
    const jobsWithoutTimeout = jobs.filter(j => !j.hasTimeout);
    if (jobsWithoutTimeout.length > 0) {
      issues.push({
        severity: 'low',
        category: 'reliability',
        message: `${jobsWithoutTimeout.length} job(s) without timeout-minutes`,
        suggestion: 'Add timeout-minutes to prevent runaway jobs',
      });
      
      optimizations.push({
        type: 'timeout',
        description: 'Add timeout-minutes to prevent jobs from running indefinitely',
        impact: 'low',
        codeExample: `jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30  # Adjust based on expected duration`,
      });
    }

    // Check for expensive runners
    const macOSJobs = jobs.filter(j => j.runsOn.includes('macos'));
    const windowsJobs = jobs.filter(j => j.runsOn.includes('windows'));
    
    if (macOSJobs.length > 0) {
      issues.push({
        severity: 'medium',
        category: 'cost',
        message: `${macOSJobs.length} job(s) use macOS runners (10x cost of Linux)`,
        suggestion: 'Consider if macOS is required or if Linux would suffice',
      });
    }

    // Check for outdated actions
    const outdatedActions = [
      { pattern: 'actions/checkout@v2', current: 'v4' },
      { pattern: 'actions/checkout@v3', current: 'v4' },
      { pattern: 'actions/setup-node@v2', current: 'v4' },
      { pattern: 'actions/setup-node@v3', current: 'v4' },
      { pattern: 'actions/setup-python@v3', current: 'v5' },
      { pattern: 'actions/setup-python@v4', current: 'v5' },
      { pattern: 'actions/cache@v2', current: 'v4' },
      { pattern: 'actions/cache@v3', current: 'v4' },
    ];

    for (const { pattern, current } of outdatedActions) {
      if (content.includes(pattern)) {
        issues.push({
          severity: 'low',
          category: 'maintenance',
          message: `Outdated action: ${pattern} (latest: ${current})`,
          suggestion: `Update to ${pattern.split('@')[0]}@${current}`,
        });
      }
    }

    // Check for hardcoded secrets in env
    if (content.match(/\bpassword\s*[:=]\s*['"][^$]/i) || 
        content.match(/\btoken\s*[:=]\s*['"][^$]/i) ||
        content.match(/\bkey\s*[:=]\s*['"][^$]/i)) {
      issues.push({
        severity: 'high',
        category: 'security',
        message: 'Possible hardcoded secret detected',
        suggestion: 'Use GitHub secrets: ${{ secrets.SECRET_NAME }}',
      });
    }

    // Check for missing path filters on push/PR
    if ((triggers.includes('push') || triggers.includes('pull_request')) &&
        !content.includes('paths:') && !content.includes('paths-ignore:')) {
      optimizations.push({
        type: 'path-filter',
        description: 'Add path filters to skip workflow when irrelevant files change',
        impact: 'medium',
        codeExample: `on:
  push:
    branches: [main]
    paths:
      - 'src/**'
      - 'package*.json'
    paths-ignore:
      - '**.md'
      - 'docs/**'`,
      });
    }

    // Check for opportunities to use composite actions
    if (jobs.length > 2) {
      const allUses = jobs.flatMap(j => j.uses);
      const duplicateSteps = allUses.filter((u, i) => allUses.indexOf(u) !== i);
      
      if (duplicateSteps.length > 2) {
        optimizations.push({
          type: 'composite-action',
          description: 'Consider extracting repeated steps into a reusable composite action',
          impact: 'medium',
        });
      }
    }

    return {
      name: workflowName,
      triggers,
      jobs,
      issues,
      optimizations,
    };
  }

  /**
   * Get recent failed workflow runs with error details for root cause analysis
   */
  async getWorkflowFailures(
    org: string,
    repo: string,
    workflowName?: string,
    limit: number = 5
  ): Promise<{
    failures: Array<{
      id: number;
      workflow: string;
      conclusion: string;
      createdAt: string;
      headBranch: string;
      headSha: string;
      failedJobs: Array<{
        name: string;
        conclusion: string;
        steps: Array<{
          name: string;
          conclusion: string;
          number: number;
        }>;
        errorAnnotations: string[];
      }>;
      runUrl: string;
    }>;
    error?: string;
  }> {
    const failures: Array<{
      id: number;
      workflow: string;
      conclusion: string;
      createdAt: string;
      headBranch: string;
      headSha: string;
      failedJobs: Array<{
        name: string;
        conclusion: string;
        steps: Array<{
          name: string;
          conclusion: string;
          number: number;
        }>;
        errorAnnotations: string[];
      }>;
      runUrl: string;
    }> = [];

    try {
      // Get recent failed workflow runs
      const { data: runs } = await this.octokit.rest.actions.listWorkflowRunsForRepo({
        owner: org,
        repo,
        status: 'failure',
        per_page: 30,
      });

      // Filter by workflow name if provided
      let filteredRuns = runs.workflow_runs;
      if (workflowName) {
        filteredRuns = runs.workflow_runs.filter(
          r => r.name?.toLowerCase().includes(workflowName.toLowerCase())
        );
      }

      // Get job details for each failed run
      for (const run of filteredRuns.slice(0, limit)) {
        try {
          const { data: jobs } = await this.octokit.rest.actions.listJobsForWorkflowRun({
            owner: org,
            repo,
            run_id: run.id,
          });

          const failedJobs = jobs.jobs
            .filter(j => j.conclusion === 'failure')
            .map(job => ({
              name: job.name,
              conclusion: job.conclusion || 'unknown',
              steps: (job.steps || [])
                .filter(s => s.conclusion === 'failure')
                .map(s => ({
                  name: s.name,
                  conclusion: s.conclusion || 'unknown',
                  number: s.number,
                })),
              // Try to get error annotations from the run
              errorAnnotations: [] as string[],
            }));

          // Try to get check run annotations (error messages)
          for (const job of failedJobs) {
            try {
              const matchingJob = jobs.jobs.find(j => j.name === job.name);
              if (matchingJob) {
                const { data: annotations } = await this.octokit.rest.checks.listAnnotations({
                  owner: org,
                  repo,
                  check_run_id: matchingJob.id,
                  per_page: 10,
                });
                
                job.errorAnnotations = annotations
                  .filter(a => a.annotation_level === 'failure' || a.annotation_level === 'warning')
                  .map(a => `${a.path || ''}:${a.start_line || ''} - ${a.message}`)
                  .slice(0, 5);
              }
            } catch {
              // Annotations not available
            }
          }

          failures.push({
            id: run.id,
            workflow: run.name || 'Unknown',
            conclusion: run.conclusion || 'failure',
            createdAt: run.created_at,
            headBranch: run.head_branch || 'unknown',
            headSha: run.head_sha.slice(0, 7),
            failedJobs,
            runUrl: run.html_url,
          });
        } catch {
          // Skip runs we can't get jobs for
        }
      }

      return { failures };
    } catch (error: any) {
      return {
        failures: [],
        error: error.message || 'Failed to fetch workflow failures',
      };
    }
  }

  /**
   * Analyze workflow failures to identify common error patterns
   */
  analyzeFailurePatterns(
    failures: Array<{
      workflow: string;
      failedJobs: Array<{
        name: string;
        steps: Array<{ name: string; conclusion: string }>;
        errorAnnotations: string[];
      }>;
    }>
  ): {
    patterns: Array<{
      category: string;
      count: number;
      description: string;
      examples: string[];
      suggestedFix: string;
    }>;
    commonFailingSteps: Array<{ step: string; count: number }>;
    summary: string;
  } {
    
    const patterns: Map<string, {
      category: string;
      count: number;
      description: string;
      examples: string[];
      suggestedFix: string;
    }> = new Map();

    const stepFailureCounts: Map<string, number> = new Map();

    for (const failure of failures) {
      for (const job of failure.failedJobs) {
        // Count failing step names
        for (const step of job.steps) {
          const key = step.name.toLowerCase();
          stepFailureCounts.set(key, (stepFailureCounts.get(key) || 0) + 1);
        }

        // Analyze error annotations for patterns
        for (const annotation of job.errorAnnotations) {
          const lower = annotation.toLowerCase();

          // Detect common error patterns - ORDER MATTERS (most specific first)
          
          // GitHub Actions specific permission errors
          if (lower.includes('resource not accessible by integration') || lower.includes('resource not accessible')) {
            this.addPattern(patterns, 'github-permissions', 'GitHub token permissions insufficient', annotation, 
              'Add permissions block to workflow. Common fix:\n```yaml\npermissions:\n  contents: read\n  issues: write\n  pull-requests: write\n  security-events: write  # for SARIF uploads\n```');
          } else if (lower.includes('could not create check run') || lower.includes('could not create status')) {
            this.addPattern(patterns, 'github-permissions', 'Missing checks/statuses permission', annotation,
              'Add `checks: write` or `statuses: write` to workflow permissions block.');
          } else if (lower.includes('sarif') || (lower.includes('upload') && lower.includes('fail'))) {
            this.addPattern(patterns, 'sarif-upload', 'SARIF upload failed (code scanning)', annotation,
              'Add `security-events: write` permission and ensure GitHub Advanced Security is enabled:\n```yaml\npermissions:\n  security-events: write\n```');
          } else if (lower.includes('permission denied') || lower.includes('eacces')) {
            this.addPattern(patterns, 'permissions', 'File permission denied', annotation, 
              'Check file permissions or use chmod. For GitHub Actions, ensure proper permissions block.');
          } else if (lower.includes('not found') || lower.includes('enoent') || lower.includes('no such file')) {
            this.addPattern(patterns, 'missing-file', 'Missing file or directory', annotation,
              'Verify file paths and ensure files are created before use. Check checkout step runs first.');
          } else if (lower.includes('timeout') || lower.includes('timed out')) {
            this.addPattern(patterns, 'timeout', 'Operation timed out', annotation,
              'Increase timeout-minutes for the job or optimize the slow operation.');
          } else if (lower.includes('secret') || lower.includes('token') || lower.includes('unauthorized') || lower.includes('401') || lower.includes('403')) {
            this.addPattern(patterns, 'auth', 'Authentication/secret issue', annotation,
              'Verify secrets are configured in repo settings and using correct syntax: ${{ secrets.NAME }}');
          } else if (lower.includes('npm err') || lower.includes('yarn error') || lower.includes('pnpm')) {
            this.addPattern(patterns, 'npm', 'Node.js package manager error', annotation,
              'Clear npm cache, check package.json for issues, verify node version compatibility.');
          } else if (lower.includes('maven') || lower.includes('gradle') || lower.includes('build failure')) {
            this.addPattern(patterns, 'build', 'Build tool failure', annotation,
              'Check build configuration and dependencies. Run build locally to reproduce.');
          } else if (lower.includes('test failed') || lower.includes('assertion') || lower.includes('expect')) {
            this.addPattern(patterns, 'test', 'Test failures', annotation,
              'Review failing tests. Consider using retry for flaky tests: nick-fields/retry@v3');
          } else if (lower.includes('docker') || lower.includes('container')) {
            this.addPattern(patterns, 'docker', 'Docker/container issue', annotation,
              'Check Dockerfile, verify base images exist, and ensure Docker daemon is running.');
          } else if (lower.includes('rate limit') || lower.includes('api limit')) {
            this.addPattern(patterns, 'rate-limit', 'API rate limit exceeded', annotation,
              'Implement caching, reduce API calls, or use a different authentication method.');
          } else if (lower.includes('syntax error') || lower.includes('parse error')) {
            this.addPattern(patterns, 'syntax', 'Syntax/parse error', annotation,
              'Check code syntax. For YAML, validate with yamllint. For code, run linter locally.');
          } else if (annotation.length > 10) {
            this.addPattern(patterns, 'other', 'Other errors', annotation,
              'Review the full error message in the workflow run logs for more context.');
          }
        }

        // Also analyze step names for common failure patterns
        for (const step of job.steps) {
          const stepLower = step.name.toLowerCase();
          
          // Debug logging for pattern matching
          if (stepLower.includes('publish') || stepLower.includes('test')) {
          }
          
          if (stepLower.includes('checkout')) {
            this.addPattern(patterns, 'checkout', 'Checkout step failures', step.name,
              'Check repository permissions, branch existence, and submodule settings.');
          } else if (stepLower.includes('setup') && (stepLower.includes('node') || stepLower.includes('python') || stepLower.includes('java'))) {
            this.addPattern(patterns, 'setup', 'Environment setup failures', step.name,
              'Verify the language version is valid. Check if runner has required dependencies.');
          } else if (stepLower.includes('install') || stepLower.includes('dependencies')) {
            this.addPattern(patterns, 'dependencies', 'Dependency installation failures', step.name,
              'Clear package cache, check for lockfile issues, verify registry access.');
          } else if (stepLower.includes('sarif') || stepLower.includes('upload') && (stepLower.includes('result') || stepLower.includes('report') || stepLower.includes('scan'))) {
            this.addPattern(patterns, 'sarif-upload', 'SARIF/scan upload failed', step.name,
              'Add `security-events: write` permission to your workflow:\n```yaml\npermissions:\n  security-events: write\n  contents: read\n```\nAlso ensure GitHub Advanced Security is enabled for the repository.');
          } else if (stepLower.includes('codeql') || stepLower.includes('code scanning')) {
            this.addPattern(patterns, 'code-scanning', 'CodeQL/code scanning failure', step.name,
              'Check CodeQL configuration, ensure language is correct, and add `security-events: write` permission.');
          } else if (stepLower.includes('publish') && (stepLower.includes('test') || stepLower.includes('result'))) {
            this.addPattern(patterns, 'test-publish', 'Test results publish failed', step.name,
              'Add `checks: write` permission to publish test results:\n```yaml\npermissions:\n  checks: write\n  contents: read\n```');
          } else if (stepLower.includes('build')) {
            this.addPattern(patterns, 'build', 'Build step failures', step.name,
              'Check build scripts, verify environment variables, and test build locally.');
          } else if (stepLower.includes('test') || stepLower.includes('lint')) {
            this.addPattern(patterns, 'test', 'Test/lint failures', step.name,
              'Run tests locally to reproduce. Consider marking flaky tests or adding retry.');
          } else if (stepLower.includes('deploy')) {
            this.addPattern(patterns, 'deploy', 'Deployment failures', step.name,
              'Verify deployment credentials, target environment health, and permissions.');
          }
        }
      }
    }

    // Convert maps to arrays
    let patternsList = Array.from(patterns.values());

    // Consolidate permission-related patterns into a single unified suggestion
    const permissionCategories = ['github-permissions', 'test-publish', 'sarif-upload', 'code-scanning'];
    const permissionPatterns = patternsList.filter(p => permissionCategories.includes(p.category));
    
    if (permissionPatterns.length > 1) {
      // Merge all permission-related patterns into one
      const totalCount = permissionPatterns.reduce((sum, p) => sum + p.count, 0);
      const allExamples = permissionPatterns.flatMap(p => p.examples).slice(0, 3);
      
      // Build comprehensive permissions block based on what's needed
      const needsChecks = permissionPatterns.some(p => p.category === 'test-publish');
      const needsSecurityEvents = permissionPatterns.some(p => 
        p.category === 'sarif-upload' || p.category === 'code-scanning' ||
        p.suggestedFix.includes('security-events'));
      const needsPRWrite = permissionPatterns.some(p => 
        p.suggestedFix.includes('pull-requests: write'));
      const needsIssuesWrite = permissionPatterns.some(p => 
        p.suggestedFix.includes('issues: write'));
      
      let permissionsBlock = 'permissions:\n  contents: read';
      if (needsChecks) permissionsBlock += '\n  checks: write         # for test results publishing';
      if (needsSecurityEvents) permissionsBlock += '\n  security-events: write # for SARIF/code scanning uploads';
      if (needsPRWrite) permissionsBlock += '\n  pull-requests: write';
      if (needsIssuesWrite) permissionsBlock += '\n  issues: write';
      
      const consolidatedPattern = {
        category: 'permissions',
        count: totalCount,
        description: 'Workflow permissions insufficient',
        examples: allExamples,
        suggestedFix: `Add the following permissions block to your workflow:\n\`\`\`yaml\n${permissionsBlock}\n\`\`\``,
      };
      
      // Remove individual permission patterns and add consolidated one
      patternsList = patternsList.filter(p => !permissionCategories.includes(p.category));
      patternsList.unshift(consolidatedPattern);
    }

    // Sort by count
    patternsList.sort((a, b) => b.count - a.count);

    const commonFailingSteps = Array.from(stepFailureCounts.entries())
      .map(([step, count]) => ({ step, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    // Generate summary
    const totalFailures = failures.length;
    const topPattern = patternsList[0];
    const summary = totalFailures === 0
      ? 'No recent failures found.'
      : `Analyzed ${totalFailures} failed runs. Most common issue: ${topPattern?.category || 'unknown'} (${topPattern?.count || 0} occurrences).`;

    return {
      patterns: patternsList,
      commonFailingSteps,
      summary,
    };
  }

  private addPattern(
    patterns: Map<string, { category: string; count: number; description: string; examples: string[]; suggestedFix: string }>,
    category: string,
    description: string,
    example: string,
    suggestedFix: string
  ): void {
    const existing = patterns.get(category);
    if (existing) {
      existing.count++;
      if (existing.examples.length < 3 && !existing.examples.includes(example)) {
        existing.examples.push(example);
      }
    } else {
      patterns.set(category, {
        category,
        count: 1,
        description,
        examples: [example],
        suggestedFix,
      });
    }
  }
}

