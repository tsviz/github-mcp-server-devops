import { App } from '@octokit/app';
import { Octokit } from '@octokit/rest';
import { graphql } from '@octokit/graphql';
import { subHours, subDays } from 'date-fns';

export class GitHubEnterpriseClient {
  private app: App;
  private octokit!: Octokit;
  private graphqlClient: typeof graphql;
  private enterpriseSlug: string;
  private isEnterpriseServer: boolean;
  private installationId: number;

  constructor(config: {
    appId: string;
    privateKey: string;
    installationId: string;
    enterpriseSlug: string;
    enterpriseUrl?: string;
  }) {
    this.enterpriseSlug = config.enterpriseSlug;
    this.isEnterpriseServer = config.enterpriseUrl !== 'https://api.github.com';
    this.installationId = parseInt(config.installationId);
    
    this.app = new App({
      appId: config.appId,
      privateKey: config.privateKey,
      ...(this.isEnterpriseServer && { baseUrl: config.enterpriseUrl }),
    });
    
    // Initialize octokit asynchronously
    this.initOctokit();
    
    // Initialize GraphQL client for advanced queries
    this.graphqlClient = graphql.defaults({
      headers: {
        authorization: `token ${process.env.GITHUB_TOKEN || ''}`,
      },
      ...(this.isEnterpriseServer && { baseUrl: config.enterpriseUrl + '/graphql' }),
    });
  }

  private async initOctokit(): Promise<void> {
    const installationOctokit = await this.app.getInstallationOctokit(this.installationId);
    this.octokit = installationOctokit as unknown as Octokit;
  }

  async verifyEnterpriseAccess(): Promise<boolean> {
    try {
      // Check if we have access to enterprise-specific endpoints
      const { data } = await this.octokit.request('GET /enterprises/{enterprise}', {
        enterprise: this.enterpriseSlug,
      });
      
      // Verify we have access to billing/usage endpoints (Enterprise only)
      await this.octokit.request('GET /enterprises/{enterprise}/settings/billing/actions', {
        enterprise: this.enterpriseSlug,
      });
      
      return true;
    } catch (error: any) {
      if (error.status === 404 || error.status === 403) {
        console.error('❌ Enterprise access not available. This requires GitHub Enterprise Cloud or Server.');
        return false;
      }
      throw error;
    }
  }

  async getActionsUsageMetrics(
    orgName: string,
    timeframe: string,
    breakdown?: string
  ): Promise<any> {
    // Enterprise-exclusive API endpoint for Actions usage metrics
    const { data: billingData } = await this.octokit.request(
      'GET /orgs/{org}/settings/billing/actions',
      { org: orgName }
    );
    
    // Get detailed workflow billing breakdown (Enterprise only)
    const { data: workflowBilling } = await this.octokit.request(
      'GET /orgs/{org}/actions/billing/workflows',
      { org: orgName }
    );
    
    // Get runner minutes by OS (Enterprise only)
    const { data: runnerMinutes } = await this.octokit.request(
      'GET /orgs/{org}/settings/billing/actions/runners',
      { org: orgName }
    );
    
    // GraphQL query for detailed metrics (Enterprise features)
    const detailedMetrics = await this.graphqlClient(`
      query($org: String!, $from: DateTime!, $to: DateTime!) {
        organization(login: $org) {
          actionsBilling {
            totalMinutesUsed
            totalPaidMinutesUsed
            includedMinutes
            minutesUsedBreakdown {
              UBUNTU
              MACOS
              WINDOWS
            }
          }
          repositories(first: 100) {
            nodes {
              name
              actionsBilling {
                totalMinutesUsed
                workflows {
                  name
                  minutesUsed
                  runs
                  averageDuration
                }
              }
            }
          }
        }
      }
    `, {
      org: orgName,
      from: this.getTimeframeCutoff(timeframe).toISOString(),
      to: new Date().toISOString(),
    });
    
    // Get storage metrics (Enterprise only)
    const { data: storageMetrics } = await this.octokit.request(
      'GET /orgs/{org}/settings/billing/shared-storage',
      { org: orgName }
    );
    
    return {
      billing: billingData,
      workflowBilling,
      runnerMinutes,
      detailedMetrics: (detailedMetrics as Record<string, unknown>).organization,
      storage: storageMetrics,
      timeframe,
      breakdown,
    };
  }

  async getActionsPerformanceMetrics(
    orgName: string,
    repoName?: string,
    workflowId?: string,
    timeframe: string = '24h'
  ): Promise<any> {
    const since = this.getTimeframeCutoff(timeframe);
    
    // Enterprise GraphQL query for performance metrics
    const performanceData = await this.graphqlClient(`
      query($org: String!, $repo: String, $since: DateTime!) {
        organization(login: $org) {
          repository(name: $repo) @include(if: $repo) {
            workflowRuns(first: 100, since: $since) {
              nodes {
                workflow {
                  name
                  id
                }
                queueTime
                executionTime
                totalTime
                conclusion
                startedAt
                completedAt
                jobs {
                  nodes {
                    name
                    startedAt
                    completedAt
                    steps {
                      name
                      startedAt
                      completedAt
                      conclusion
                    }
                    runner {
                      name
                      os
                      isHosted
                    }
                  }
                }
              }
            }
          }
          # Organization-wide metrics (Enterprise only)
          actionsMetrics(since: $since) {
            averageQueueTime
            p95QueueTime
            p99QueueTime
            averageExecutionTime
            p95ExecutionTime
            p99ExecutionTime
            totalRuns
            failureRate
            successRate
            cancelledRate
            runnerUtilization {
              hosted {
                utilization
                availableMinutes
                usedMinutes
              }
              selfHosted {
                utilization
                totalRunners
                busyRunners
                idleRunners
              }
            }
          }
        }
      }
    `, {
      org: orgName,
      repo: repoName || '',
      since: since.toISOString(),
    });
    
    // Get job-level performance insights (Enterprise API)
    if (workflowId) {
      const { data: jobMetrics } = await this.octokit.request(
        'GET /orgs/{org}/actions/workflows/{workflow_id}/timing',
        {
          org: orgName,
          workflow_id: workflowId,
        }
      );
      
      return {
        ...(performanceData as Record<string, unknown>).organization as Record<string, unknown>,
        workflowJobMetrics: jobMetrics,
      };
    }
    
    return (performanceData as Record<string, unknown>).organization;
  }

  async getRunnerUtilization(
    orgName: string,
    runnerType: 'self-hosted' | 'github-hosted' | 'all'
  ): Promise<any> {
    // Get self-hosted runners (Enterprise)
    const { data: selfHostedRunners } = await this.octokit.request(
      'GET /orgs/{org}/actions/runners',
      { org: orgName, per_page: 100 }
    );
    
    // Get runner groups (Enterprise only)
    const { data: runnerGroups } = await this.octokit.request(
      'GET /orgs/{org}/actions/runner-groups',
      { org: orgName }
    );
    
    // Enterprise GraphQL for detailed runner metrics
    const runnerMetrics = await this.graphqlClient(`
      query($org: String!) {
        organization(login: $org) {
          runners {
            totalCount
            nodes {
              name
              os
              status
              busy
              labels
              runnerGroup {
                name
                visibility
              }
            }
          }
          runnerUtilizationMetrics {
            period
            data {
              timestamp
              busyRunners
              totalRunners
              queuedJobs
              averageQueueTime
              peakUtilization
            }
          }
          # Enterprise-specific: Runner cost analysis
          runnerCostAnalysis {
            selfHosted {
              monthlyCost
              costPerMinute
              totalMinutes
            }
            gitHubHosted {
              monthlyCost
              includedMinutes
              paidMinutes
              costPerMinute {
                ubuntu
                windows
                macos
              }
            }
          }
        }
      }
    `, { org: orgName });
    
    return {
      selfHostedRunners: runnerType !== 'github-hosted' ? selfHostedRunners : null,
      runnerGroups,
      metrics: (runnerMetrics as Record<string, unknown>).organization,
      runnerType,
    };
  }

  async getActionsCacheMetrics(
    orgName: string,
    repoName: string | undefined,
    timeframe: string = '24h'
  ): Promise<any> {
    const since = this.getTimeframeCutoff(timeframe);
    
    // Enterprise API for cache analytics
    const { data: cacheUsage } = await this.octokit.request(
      'GET /orgs/{org}/actions/cache/usage',
      { org: orgName }
    );
    
    // Repository-specific cache metrics if specified
    if (repoName) {
      const { data: repoCacheUsage } = await this.octokit.request(
        'GET /repos/{owner}/{repo}/actions/cache/usage',
        { owner: orgName, repo: repoName }
      );
      
      // Get cache hit/miss rates (Enterprise GraphQL)
      const cacheAnalytics = await this.graphqlClient(`
        query($org: String!, $repo: String!, $since: DateTime!) {
          repository(owner: $org, name: $repo) {
            cacheAnalytics(since: $since) {
              hitRate
              missRate
              evictionRate
              averageCacheSize
              totalCacheSize
              cacheEntries {
                key
                size
                hitCount
                lastAccessed
                created
              }
              savingsAnalysis {
                timeSaved
                bandwidthSaved
                estimatedCostSavings
              }
            }
          }
        }
      `, {
        org: orgName,
        repo: repoName,
        since: since.toISOString(),
      });
      
      return {
        organizationUsage: cacheUsage,
        repositoryUsage: repoCacheUsage,
        analytics: ((cacheAnalytics as Record<string, unknown>).repository as Record<string, unknown>).cacheAnalytics,
      };
    }
    
    return {
      organizationUsage: cacheUsage,
      timeframe,
    };
  }

  async getComprehensiveUsageData(orgName: string): Promise<any> {
    // Comprehensive enterprise data collection
    const [
      billing,
      performance,
      runners,
      cache,
      security,
    ] = await Promise.all([
      this.getActionsUsageMetrics(orgName, '30d'),
      this.getActionsPerformanceMetrics(orgName, undefined, undefined, '30d'),
      this.getRunnerUtilization(orgName, 'all'),
      this.getActionsCacheMetrics(orgName, undefined, '30d'),
      this.getSecurityInsights(orgName),
    ]);
    
    return {
      billing,
      performance,
      runners,
      cache,
      security,
      organization: orgName,
      timestamp: new Date().toISOString(),
    };
  }

  async getWorkflowInsights(
    orgName: string,
    repoName: string,
    workflowName: string
  ): Promise<any> {
    // Enterprise GraphQL for deep workflow analysis
    const insights = await this.graphqlClient(`
      query($org: String!, $repo: String!, $workflow: String!) {
        repository(owner: $org, name: $repo) {
          workflow(name: $workflow) {
            runs(last: 100) {
              nodes {
                conclusion
                startedAt
                completedAt
                attempt
                jobs {
                  nodes {
                    name
                    startedAt
                    completedAt
                    steps {
                      name
                      number
                      startedAt
                      completedAt
                      conclusion
                    }
                    dependencies {
                      name
                    }
                  }
                }
                # Enterprise: Cost analysis per run
                costAnalysis {
                  totalCost
                  runnerCost
                  storageCost
                  minutesUsed {
                    ubuntu
                    macos
                    windows
                  }
                }
              }
            }
            # Enterprise: Workflow optimization suggestions
            optimizationSuggestions {
              type
              description
              estimatedSavings
              implementation
            }
          }
        }
      }
    `, {
      org: orgName,
      repo: repoName,
      workflow: workflowName,
    });
    
    return ((insights as Record<string, unknown>).repository as Record<string, unknown>).workflow;
  }

  async getTeamProductivityMetrics(
    orgName: string,
    teamSlug: string | undefined,
    timeframe: string = '7d'
  ): Promise<any> {
    const since = this.getTimeframeCutoff(timeframe);
    
    // Enterprise API for team-based metrics
    const teamMetrics = await this.graphqlClient(`
      query($org: String!, $team: String, $since: DateTime!) {
        organization(login: $org) {
          team(slug: $team) @include(if: $team) {
            members {
              nodes {
                login
                contributionMetrics(since: $since) {
                  totalCommits
                  totalPullRequests
                  totalReviews
                  actionsMetrics {
                    workflowRuns
                    successRate
                    averageDuration
                    totalMinutesUsed
                  }
                }
              }
            }
          }
          teams @skip(if: $team) {
            nodes {
              slug
              name
              productivityMetrics(since: $since) {
                velocity
                cycleTime
                deploymentFrequency
                failureRate
                mttr
                totalActionsMinutes
                costPerDeploy
              }
            }
          }
        }
      }
    `, {
      org: orgName,
      team: teamSlug || '',
      since: since.toISOString(),
    });
    
    return (teamMetrics as Record<string, unknown>).organization;
  }

  async getComplianceAuditData(
    orgName: string,
    includeSecretscan: boolean
  ): Promise<any> {
    // Enterprise compliance and audit APIs
    const { data: auditLog } = await this.octokit.request(
      'GET /orgs/{org}/audit-log',
      {
        org: orgName,
        include: 'all',
        per_page: 100,
      }
    );
    
    // Get security alerts if requested
    let securityData = null;
    if (includeSecretscan) {
      const { data: secretAlerts } = await this.octokit.request(
        'GET /orgs/{org}/secret-scanning/alerts',
        { org: orgName, state: 'open' }
      );
      
      const { data: codeAlerts } = await this.octokit.request(
        'GET /orgs/{org}/code-scanning/alerts',
        { org: orgName, state: 'open' }
      );
      
      securityData = {
        secretAlerts,
        codeAlerts,
      };
    }
    
    // Enterprise GraphQL for compliance metrics
    const complianceMetrics = await this.graphqlClient(`
      query($org: String!) {
        organization(login: $org) {
          complianceMetrics {
            workflowApprovalCompliance
            secretScanningCompliance
            branchProtectionCompliance
            requiredReviewersCompliance
            actionsPermissionsCompliance
            runnerGroupCompliance
          }
          repositories {
            totalCount
            compliantCount
            nodes {
              name
              complianceScore
              violations {
                type
                severity
                description
              }
            }
          }
        }
      }
    `, { org: orgName });
    
    return {
      auditLog,
      securityData,
      complianceMetrics: (complianceMetrics as Record<string, unknown>).organization,
    };
  }

  private async getSecurityInsights(orgName: string): Promise<any> {
    // Enterprise security overview
    const { data: securityOverview } = await this.octokit.request(
      'GET /orgs/{org}/security-overview',
      { org: orgName }
    );
    
    return securityOverview;
  }

  async getOrganizationCount(): Promise<number> {
    const { data } = await this.octokit.request('GET /app/installations');
    return data.length;
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
}