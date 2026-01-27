import { GitHubOrgClient } from '../github/org-client.js';

export class MetricsCalculator {
  constructor(private githubClient: GitHubOrgClient) {}

  calculateActionsCosts(usageData: any): any {
    // GitHub Actions pricing (per minute)
    const pricing = {
      linux: 0.008,
      windows: 0.016,
      macos: 0.08,
      linux_large: 0.016,  // 2-core
      linux_xlarge: 0.032, // 4-core
    };

    const billing = usageData.billing || {};
    const totalMinutes = billing.total_minutes_used || 0;
    const includedMinutes = billing.included_minutes || 0;
    const paidMinutes = Math.max(0, totalMinutes - includedMinutes);

    // Estimate costs based on usage patterns
    const estimatedCost = paidMinutes * pricing.linux; // Conservative estimate

    const workflowStats = usageData.workflowStats || {};
    const successRate = workflowStats.byConclusion?.success 
      ? ((workflowStats.byConclusion.success / workflowStats.total) * 100).toFixed(1)
      : 'N/A';

    return {
      summary: `📊 **Usage Summary**
- Total Runs: ${usageData.totalRuns || 0}
- Total Minutes: ${totalMinutes}
- Included Minutes: ${includedMinutes}
- Paid Minutes: ${paidMinutes}
- Estimated Cost: $${estimatedCost.toFixed(2)}
- Success Rate: ${successRate}%`,
      details: `### Breakdown by Status
${Object.entries(workflowStats.byConclusion || {})
  .map(([status, count]) => `- ${status}: ${count}`)
  .join('\n')}

### Breakdown by Event
${Object.entries(workflowStats.byEvent || {})
  .map(([event, count]) => `- ${event}: ${count}`)
  .join('\n')}`,
    };
  }

  analyzePerformance(perfData: any): any {
    return {
      summary: `📈 **Performance Summary**
- Total Runs Analyzed: ${perfData.totalRuns || 0}
- Completed Runs: ${perfData.completedRuns || 0}
- Success Rate: ${perfData.successRate || 0}%
- Failure Rate: ${perfData.failureRate || 0}%`,
      insights: `### Timing Metrics
- Average Duration: ${this.formatDuration(perfData.avgDurationSeconds || 0)}
- Min Duration: ${this.formatDuration(perfData.minDurationSeconds || 0)}
- Max Duration: ${this.formatDuration(perfData.maxDurationSeconds || 0)}
- P95 Duration: ${this.formatDuration(perfData.p95DurationSeconds || 0)}

### Insights
${perfData.successRate >= 95 ? '✅ Excellent success rate!' : ''}
${perfData.successRate < 80 ? '⚠️ Success rate below 80% - investigate failures' : ''}
${perfData.avgDurationSeconds > 600 ? '⏱️ Average duration over 10 minutes - consider optimization' : ''}`,
    };
  }

  calculateRunnerUtilization(runnerData: any): any {
    const summary = runnerData.summary?.selfHosted || {};
    const utilization = summary.total > 0 
      ? ((summary.busy / summary.total) * 100).toFixed(1) 
      : 0;

    // Build GitHub-hosted focused summary
    let output = `## 🏃 Runner Analysis\n\n`;
    
    if (summary.total > 0) {
      output += `### Self-Hosted Runners Detected\n`;
      output += `- Total: ${summary.total}\n`;
      output += `- Online: ${summary.online || 0}\n`;
      output += `- Busy: ${summary.busy || 0}\n`;
      output += `- Idle: ${summary.idle || 0}\n`;
      output += `- Utilization: ${utilization}%\n\n`;
      
      output += `> ⚠️ **Consider GitHub-Hosted Runners** for most workloads.\n\n`;
    } else {
      output += `### ✅ Using GitHub-Hosted Runners\n\n`;
      output += `You're using GitHub-hosted runners, which is the recommended approach for most teams.\n\n`;
    }
    
    output += `### 🔒 GitHub-Hosted Runner Benefits\n`;
    output += `- **Ephemeral VMs** - Clean, isolated environment every run\n`;
    output += `- **Security-hardened** - Regular patches, no maintenance burden\n`;
    output += `- **OIDC Support** - Secure cloud deployments without static credentials\n`;
    output += `- **Auto-scaling** - No capacity planning needed\n`;
    output += `- **Private networking** - Connect to on-prem/private resources\n\n`;
    
    output += `### 📦 Available Runner Options\n\n`;
    output += `| OS | Standard (FREE public) | Larger Options |\n`;
    output += `|:---|:----------------------|:---------------|\n`;
    output += `| Linux | \`ubuntu-latest\` (2-4 CPU) | \`linux-4-core\` to \`linux-64-core\` |\n`;
    output += `| Linux ARM | - | \`linux-4-core-arm\` to \`linux-64-core-arm\` (25% cheaper!) |\n`;
    output += `| Windows | \`windows-latest\` (2-4 CPU) | \`windows-4-core\` to \`windows-64-core\` |\n`;
    output += `| macOS | \`macos-latest\` (M1, 3 CPU) | \`macos-*-large\` (Intel) or \`macos-*-xlarge\` (M2) |\n\n`;
    
    output += `📚 [GitHub-Hosted Runners Pricing](https://docs.github.com/en/enterprise-cloud@latest/billing/reference/actions-runner-pricing)\n`;
    
    if (runnerData.runnerGroups?.total_count > 0) {
      output += `\n### Runner Groups: ${runnerData.runnerGroups.total_count}`;
    }

    return {
      summary: output,
    };
  }

  async calculateRunnerCosts(runnerData: any): Promise<any> {
    const summary = runnerData.summary?.selfHosted || {};
    
    let output = `## 💰 Cost Analysis & Recommendations\n\n`;
    
    if (summary.total > 0) {
      output += `### Current: Self-Hosted Runners (${summary.total})\n\n`;
      output += `Self-hosted runners have hidden costs:\n`;
      output += `- Infrastructure (compute, storage, networking)\n`;
      output += `- Maintenance (patching, updates, monitoring)\n`;
      output += `- Security (hardening, compliance, access control)\n`;
      output += `- Operational overhead (on-call, troubleshooting)\n\n`;
      
      output += `### 💡 Consider Migrating to GitHub-Hosted\n\n`;
      output += `| Scenario | Self-Hosted | GitHub-Hosted |\n`;
      output += `|:---------|:------------|:--------------|\n`;
      output += `| Setup time | Hours/Days | Minutes |\n`;
      output += `| Maintenance | Ongoing | Zero |\n`;
      output += `| Security updates | Manual | Automatic |\n`;
      output += `| Scaling | Manual capacity | Auto-scaling |\n`;
      output += `| OIDC for cloud auth | Custom setup | Built-in |\n\n`;
    } else {
      output += `### ✅ Using GitHub-Hosted Runners\n\n`;
      output += `Great choice! GitHub-hosted runners provide:\n`;
      output += `- Predictable per-minute pricing\n`;
      output += `- Zero maintenance overhead\n`;
      output += `- Automatic security updates\n\n`;
    }
    
    output += `### 📊 GitHub-Hosted Pricing (Private Repos)\n\n`;
    output += `| Runner Type | Cost/min | 10 min job | 100 runs/month |\n`;
    output += `|:------------|:---------|:-----------|:---------------|\n`;
    output += `| Linux Standard | $0.006 | $0.06 | $6.00 |\n`;
    output += `| Linux 8-core | $0.022 | $0.22 | $22.00 |\n`;
    output += `| Linux ARM 8-core | $0.014 | $0.14 | **$14.00** (36% cheaper!) |\n`;
    output += `| Windows Standard | $0.010 | $0.10 | $10.00 |\n`;
    output += `| macOS Standard | $0.062 | $0.62 | $62.00 |\n\n`;
    
    output += `> 🆓 **Public repos**: Standard runners are FREE with unlimited minutes!\n\n`;
    
    output += `### 🎯 Cost Optimization Tips\n\n`;
    output += `1. **Use ARM runners** - 25-35% cheaper for Linux/Windows\n`;
    output += `2. **Enable caching** - Reduce build times by 30-50%\n`;
    output += `3. **Right-size runners** - Match runner to workload needs\n`;
    output += `4. **Concurrency controls** - Cancel redundant runs\n`;
    output += `5. **Public repos when possible** - FREE standard runners`;
    
    return {
      details: output,
    };
  }

  analyzeCacheEfficiency(cacheData: any): any {
    const orgUsage = cacheData.organizationUsage || {};
    const repoUsage = cacheData.repositoryUsage || {};
    const cacheList = cacheData.cacheList || {};

    const totalCacheSizeGB = (orgUsage.total_active_caches_size_in_bytes || 0) / (1024 * 1024 * 1024);

    return {
      summary: `💾 **Cache Analytics**
- Total Active Caches: ${orgUsage.total_active_caches_count || 'N/A'}
- Total Cache Size: ${totalCacheSizeGB.toFixed(2)} GB
${repoUsage.active_caches_size_in_bytes ? `- Repository Cache Size: ${(repoUsage.active_caches_size_in_bytes / (1024 * 1024)).toFixed(2)} MB` : ''}
${cacheList.total_count ? `- Cache Entries: ${cacheList.total_count}` : ''}`,
      recommendations: `### Optimization Opportunities
${totalCacheSizeGB > 5 ? '⚠️ Cache size exceeds 5GB - consider cleanup' : '✅ Cache size within optimal range'}
- Review cache keys for duplicates
- Set appropriate cache TTLs
- Use cache-hit detection to skip unnecessary restores`,
    };
  }

  async generateCostOptimizationReport(usageData: any, targetSavings: number): Promise<any> {
    const billing = usageData.usage?.billing || {};
    const performance = usageData.performance || {};
    const runners = usageData.runners || {};
    const cache = usageData.cache || {};
    const workflowStats = usageData.usage?.workflowStats || {};
    
    // Calculate actual costs
    const totalMinutesUsed = billing.total_minutes_used || 0;
    const includedMinutes = billing.included_minutes || 0;
    const paidMinutes = Math.max(0, totalMinutesUsed - includedMinutes);
    
    // GitHub Actions pricing per minute (as of 2024)
    const linuxRate = 0.008;
    const windowsRate = 0.016;
    const macosRate = 0.08;
    
    // Estimate costs by OS breakdown if available
    const minutesByOS = billing.minutes_used_breakdown || {};
    const linuxMinutes = minutesByOS.UBUNTU || minutesByOS.ubuntu || 0;
    const windowsMinutes = minutesByOS.WINDOWS || minutesByOS.windows || 0;
    const macosMinutes = minutesByOS.MACOS || minutesByOS.macos || 0;
    
    const estimatedCost = (linuxMinutes * linuxRate) + (windowsMinutes * windowsRate) + (macosMinutes * macosRate);
    const currentCost = estimatedCost > 0 ? estimatedCost : (paidMinutes * linuxRate);
    const targetSavingsAmount = currentCost * (targetSavings / 100);
    
    // Analyze workflow performance for specific recommendations
    const byWorkflow = performance.byWorkflow || [];
    const byRepository = performance.byRepository || [];
    const byRunnerType = performance.byRunnerType || [];
    
    // Find inefficiencies
    const slowWorkflows = byWorkflow.filter((w: any) => w.avgDurationSeconds > 600).slice(0, 5);
    const failingWorkflows = byWorkflow.filter((w: any) => w.failureRate > 30).slice(0, 5);
    const highVolumeWorkflows = byWorkflow.sort((a: any, b: any) => (b.runs || 0) - (a.runs || 0)).slice(0, 5);
    
    // Storage analysis
    const storageUsedGB = (usageData.usage?.storage?.estimated_storage_for_month || 0) / 1024;
    const cacheHitRate = cache.summary?.hitRate || 0;
    
    // Build executive summary with real data
    let executiveSummary = `## 💰 Cost Optimization Analysis\n\n`;
    executiveSummary += `### Current Usage Overview\n\n`;
    executiveSummary += `| Metric | Value |\n`;
    executiveSummary += `|--------|-------|\n`;
    executiveSummary += `| **Total Minutes Used** | ${totalMinutesUsed.toLocaleString()} min |\n`;
    executiveSummary += `| **Included Minutes** | ${includedMinutes.toLocaleString()} min |\n`;
    executiveSummary += `| **Paid Minutes** | ${paidMinutes.toLocaleString()} min |\n`;
    executiveSummary += `| **Estimated Monthly Cost** | $${currentCost.toFixed(2)} |\n`;
    executiveSummary += `| **Target Savings (${targetSavings}%)** | $${targetSavingsAmount.toFixed(2)} |\n\n`;
    
    if (Object.keys(minutesByOS).length > 0) {
      executiveSummary += `### Minutes by Platform\n\n`;
      executiveSummary += `| Platform | Minutes | Rate | Cost |\n`;
      executiveSummary += `|----------|---------|------|------|\n`;
      if (linuxMinutes > 0) {
        executiveSummary += `| 🐧 Linux | ${linuxMinutes.toLocaleString()} | $${linuxRate}/min | $${(linuxMinutes * linuxRate).toFixed(2)} |\n`;
      }
      if (windowsMinutes > 0) {
        executiveSummary += `| 🪟 Windows | ${windowsMinutes.toLocaleString()} | $${windowsRate}/min | $${(windowsMinutes * windowsRate).toFixed(2)} |\n`;
      }
      if (macosMinutes > 0) {
        executiveSummary += `| 🍎 macOS | ${macosMinutes.toLocaleString()} | $${macosRate}/min | $${(macosMinutes * macosRate).toFixed(2)} |\n`;
      }
      executiveSummary += `\n`;
    }
    
    // Build specific recommendations based on actual data
    let recommendations = `### 🎯 Specific Recommendations for Your Organization\n\n`;
    
    // Slow workflow recommendations
    if (slowWorkflows.length > 0) {
      recommendations += `#### 🐢 Slow Workflows (>10 min avg)\n\n`;
      recommendations += `These workflows consume the most minutes and are prime optimization targets:\n\n`;
      recommendations += `| Workflow | Avg Duration | Runs | Est. Minutes |\n`;
      recommendations += `|----------|--------------|------|---------------|\n`;
      for (const wf of slowWorkflows) {
        const avgMin = Math.round(wf.avgDurationSeconds / 60);
        const totalMin = avgMin * (wf.runs || 0);
        recommendations += `| ${wf.name?.slice(0, 35) || 'Unknown'} | ${avgMin}m | ${wf.runs || 0} | ~${totalMin} min |\n`;
      }
      recommendations += `\n💡 **Actions**: Enable caching, parallelize jobs, optimize test suites\n\n`;
    }
    
    // Failing workflow recommendations
    if (failingWorkflows.length > 0) {
      recommendations += `#### 🔴 High Failure Rate Workflows (>30%)\n\n`;
      recommendations += `Failed runs waste compute minutes. Fix these for immediate savings:\n\n`;
      recommendations += `| Workflow | Failure Rate | Runs | Wasted Minutes |\n`;
      recommendations += `|----------|--------------|------|----------------|\n`;
      for (const wf of failingWorkflows) {
        const avgMin = Math.round((wf.avgDurationSeconds || 60) / 60);
        const failedRuns = Math.round((wf.runs || 0) * (wf.failureRate || 0) / 100);
        const wastedMin = avgMin * failedRuns;
        recommendations += `| ${wf.name?.slice(0, 35) || 'Unknown'} | ${wf.failureRate}% | ${wf.runs || 0} | ~${wastedMin} min |\n`;
      }
      recommendations += `\n💡 **Actions**: Fix flaky tests, add better error handling, review recent changes\n\n`;
    }
    
    // High volume workflow recommendations
    if (highVolumeWorkflows.length > 0) {
      recommendations += `#### 📊 Highest Volume Workflows\n\n`;
      recommendations += `These run most frequently - small optimizations have big impact:\n\n`;
      recommendations += `| Workflow | Runs | Avg Duration | Total Time |\n`;
      recommendations += `|----------|------|--------------|------------|\n`;
      for (const wf of highVolumeWorkflows) {
        const avgMin = Math.round((wf.avgDurationSeconds || 0) / 60);
        const totalMin = avgMin * (wf.runs || 0);
        const hours = (totalMin / 60).toFixed(1);
        recommendations += `| ${wf.name?.slice(0, 35) || 'Unknown'} | ${wf.runs || 0} | ${avgMin}m | ${hours}h |\n`;
      }
      recommendations += `\n💡 **Actions**: Add concurrency controls, use path filters, skip redundant runs\n\n`;
    }
    
    // Cache recommendations
    if (cache.summary) {
      recommendations += `#### 💾 Cache Optimization\n\n`;
      recommendations += `| Metric | Value |\n`;
      recommendations += `|--------|-------|\n`;
      recommendations += `| Cache Hit Rate | ${cacheHitRate}% |\n`;
      recommendations += `| Total Cache Size | ${(cache.summary.totalSizeBytes / (1024 * 1024 * 1024)).toFixed(2)} GB |\n\n`;
      if (cacheHitRate < 50) {
        recommendations += `⚠️ **Low cache hit rate** - Review cache keys and paths. Consider:\n`;
        recommendations += `- Using \`hashFiles()\` for dependency lock files\n`;
        recommendations += `- Caching build artifacts between jobs\n`;
        recommendations += `- Implementing restore-keys for partial cache matches\n\n`;
      } else if (cacheHitRate >= 80) {
        recommendations += `✅ Cache hit rate is healthy\n\n`;
      }
    }
    
    // Runner type analysis
    if (byRunnerType.length > 0) {
      recommendations += `#### 🏃 Runner Usage Analysis\n\n`;
      recommendations += `| Runner Type | Runs | Avg Duration | Avg Queue |\n`;
      recommendations += `|-------------|------|--------------|----------|\n`;
      for (const rt of byRunnerType) {
        const avgMin = Math.round((rt.avgDurationSeconds || 0) / 60);
        recommendations += `| ${rt.type} | ${rt.runs} | ${avgMin}m | ${rt.avgQueueTimeSeconds || 0}s |\n`;
      }
      recommendations += `\n`;
      
      // Check for ARM migration opportunities
      const linuxRuns = byRunnerType.find((r: any) => r.type?.toLowerCase().includes('linux') && !r.type?.toLowerCase().includes('arm'));
      if (linuxRuns && linuxRuns.runs > 10) {
        recommendations += `💡 **ARM Migration Opportunity**: You have ${linuxRuns.runs} Linux x64 runs. Migrating to ARM runners could save 33-41%.\n\n`;
      }
    }
    
    // Generic recommendations
    recommendations += `### 🛠️ General Best Practices\n\n`;
    recommendations += `1. **Enable Caching** - Cache dependencies to reduce build times by 30-50%\n`;
    recommendations += `2. **Use ARM Runners** - Linux ARM runners are 33% cheaper than x64\n`;
    recommendations += `3. **Concurrency Controls** - Cancel redundant workflow runs with \`concurrency\` groups\n`;
    recommendations += `4. **Set Timeouts** - Prevent runaway jobs: \`timeout-minutes: 30\`\n`;
    recommendations += `5. **Path Filters** - Only run workflows when relevant files change\n`;
    recommendations += `6. **Reusable Workflows** - Reduce duplication and maintenance overhead\n`;
    
    // Savings breakdown with actual data
    let savingsBreakdown = `### 📊 Potential Savings Estimate\n\n`;
    
    const slowWorkflowMinutes = slowWorkflows.reduce((sum: number, wf: any) => {
      return sum + (Math.round((wf.avgDurationSeconds || 0) / 60) * (wf.runs || 0));
    }, 0);
    const failedMinutes = failingWorkflows.reduce((sum: number, wf: any) => {
      const avgMin = Math.round((wf.avgDurationSeconds || 60) / 60);
      const failedRuns = Math.round((wf.runs || 0) * (wf.failureRate || 0) / 100);
      return sum + (avgMin * failedRuns);
    }, 0);
    
    savingsBreakdown += `| Optimization | Est. Minutes Saved | Est. Cost Savings |\n`;
    savingsBreakdown += `|--------------|-------------------|-------------------|\n`;
    if (slowWorkflowMinutes > 0) {
      const savings = slowWorkflowMinutes * 0.3 * linuxRate; // Assume 30% reduction
      savingsBreakdown += `| Optimize slow workflows | ~${Math.round(slowWorkflowMinutes * 0.3)} min | ~$${savings.toFixed(2)} |\n`;
    }
    if (failedMinutes > 0) {
      const savings = failedMinutes * 0.5 * linuxRate; // Assume 50% reduction in failures
      savingsBreakdown += `| Fix failing workflows | ~${Math.round(failedMinutes * 0.5)} min | ~$${savings.toFixed(2)} |\n`;
    }
    if (cacheHitRate < 50 && totalMinutesUsed > 0) {
      const savings = totalMinutesUsed * 0.2 * linuxRate; // Assume 20% reduction from caching
      savingsBreakdown += `| Improve caching | ~${Math.round(totalMinutesUsed * 0.2)} min | ~$${savings.toFixed(2)} |\n`;
    }
    if (linuxMinutes > 100) {
      const armSavings = linuxMinutes * 0.33 * linuxRate;
      savingsBreakdown += `| Migrate to ARM runners | - | ~$${armSavings.toFixed(2)} |\n`;
    }
    savingsBreakdown += `\n`;
    
    savingsBreakdown += `### 💡 Quick Wins\n\n`;
    savingsBreakdown += '1. Add `concurrency: { group: ${{ github.workflow }}-${{ github.ref }}, cancel-in-progress: true }` to workflows\n';
    savingsBreakdown += `2. Use \`paths:\` and \`paths-ignore:\` filters to skip unnecessary runs\n`;
    savingsBreakdown += `3. Replace \`ubuntu-latest\` with \`ubuntu-24.04-arm\` for compatible workloads\n`;

    return {
      executive_summary: executiveSummary,
      recommendations: recommendations,
      savings_breakdown: savingsBreakdown,
    };
  }

  async generateWorkflowInsights(workflowData: any, analyzeDeps: boolean): Promise<any> {
    const workflow = workflowData.workflow || {};
    const recentRuns = workflowData.recentRuns || [];
    const successRate = workflowData.successRate || 0;

    // Analyze timing patterns
    const timings = recentRuns
      .filter((r: any) => r.timing)
      .map((r: any) => r.timing.run_duration_ms || 0);
    
    const avgTiming = timings.length 
      ? Math.round(timings.reduce((a: number, b: number) => a + b, 0) / timings.length / 1000)
      : 0;

    return {
      summary: `🔍 **Workflow Insights: ${workflow.name || 'Unknown'}**

- Path: \`${workflow.path || 'N/A'}\`
- Total Runs: ${workflowData.totalRuns || 0}
- Success Rate: ${successRate}%
- Average Duration: ${this.formatDuration(avgTiming)}`,
      bottlenecks: `### Potential Bottlenecks
${avgTiming > 600 ? '⚠️ Average duration exceeds 10 minutes' : '✅ Duration within acceptable range'}
${successRate < 90 ? '⚠️ Success rate below 90% - review failure patterns' : ''}
${recentRuns.length > 0 && recentRuns.filter((r: any) => r.run.conclusion === 'failure').length > 2 
  ? '🔴 Multiple recent failures detected' : ''}

Analyze job-level timing to identify slow steps.`,
      suggestions: `### Optimization Suggestions
1. **Parallelize Jobs** - Run independent jobs concurrently
2. **Cache Dependencies** - Use actions/cache for node_modules, pip, etc.
3. **Use Reusable Workflows** - Reduce duplication
4. **Fail Fast** - Add early validation steps
5. **Optimize Tests** - Run slow tests in parallel`,
    };
  }

  calculateTeamProductivity(productivityData: any, includeIndividuals: boolean): any {
    const metrics = productivityData.actorMetrics || [];
    const totalRuns = productivityData.totalWorkflowRuns || 0;

    const topContributors = metrics.slice(0, 5);
    const avgSuccessRate = metrics.length
      ? Math.round(metrics.reduce((a: number, m: any) => a + m.successRate, 0) / metrics.length)
      : 0;

    return {
      summary: `👥 **Team Productivity Metrics**

- Timeframe: ${productivityData.timeframe || '7d'}
- Total Workflow Runs: ${totalRuns}
- Active Contributors: ${metrics.length}
- Average Success Rate: ${avgSuccessRate}%`,
      kpis: `### Key Performance Indicators

| Metric | Value |
|--------|-------|
| Deployment Frequency | ${Math.round(totalRuns / 7)} runs/day (est.) |
| Average Success Rate | ${avgSuccessRate}% |
| Active Contributors | ${metrics.length} |`,
      individual_highlights: includeIndividuals ? `### Top Contributors

${topContributors.map((c: any, i: number) => 
  `${i + 1}. **${c.actor}** - ${c.totalRuns} runs, ${c.successRate}% success`
).join('\n')}` : null,
    };
  }

  async generateComplianceReport(auditData: any, framework?: string): Promise<any> {
    const org = auditData.organization || {};
    const secretAlerts = auditData.secretAlerts || {};
    const codeAlerts = auditData.codeAlerts || {};
    const repos = auditData.repositories || [];

    // Use displayCount for user-facing text (handles pagination limit)
    const secretDisplay = secretAlerts.displayCount || String(secretAlerts.total || 0);
    const codeDisplay = codeAlerts.displayCount || String(codeAlerts.total || 0);

    const reposWithProtection = repos.filter((r: any) => r.branchProtection).length;
    const protectionRate = repos.length 
      ? Math.round((reposWithProtection / repos.length) * 100) 
      : 0;

    return {
      executive_summary: `🔒 **Compliance Audit Report**
${framework ? `Framework: ${framework}` : ''}

**Organization**: ${org.login || 'N/A'}
- 2FA Required: ${org.twoFactorRequirementEnabled ? '✅ Yes' : '❌ No'}
- Default Repo Permission: ${org.defaultRepositoryPermission || 'N/A'}`,
      compliance_status: `### Security Configuration Status

| Setting | Status |
|---------|--------|
| 2FA Enforcement | ${org.twoFactorRequirementEnabled ? '✅ Enabled' : '⚠️ Not Required'} |
| Branch Protection | ${protectionRate}% of repos |
| Secret Scanning Alerts | ${secretDisplay} open |
| Code Scanning Alerts | ${codeDisplay} open |`,
      risk_assessment: `### Risk Assessment

${secretAlerts.total > 0 ? `🔴 **HIGH**: ${secretDisplay} open secret scanning alerts require immediate attention` : '✅ No open secret scanning alerts'}

${codeAlerts.total > 10 ? `🟡 **MEDIUM**: ${codeDisplay} code scanning alerts should be reviewed` : ''}

${protectionRate < 80 ? `⚠️ Branch protection enabled on only ${protectionRate}% of repositories` : ''}`,
      required_actions: `### Required Actions

1. ${!org.twoFactorRequirementEnabled ? '🔴 Enable 2FA requirement for all members' : '✅ 2FA requirement in place'}
2. ${secretAlerts.total > 0 ? `🔴 Remediate ${secretDisplay} secret scanning alerts` : '✅ No secret alerts'}
3. ${protectionRate < 100 ? '🟡 Enable branch protection on all repositories' : '✅ Branch protection configured'}
4. Review and update access permissions regularly
5. Enable audit log streaming for compliance tracking`,
    };
  }

  // ============================================
  // DORA Metrics Formatting
  // ============================================

  formatDoraMetrics(doraData: any): any {
    // Handle missing or incomplete data
    if (!doraData || !doraData.metrics) {
      return {
        summary: `## ⚠️ DORA Metrics - Insufficient Data

Unable to calculate DORA metrics. This could be due to:
- Missing repository access
- No deployments in the timeframe
- Insufficient permissions

${doraData?.errors ? `### Errors:\n${doraData.errors.map((e: string) => `- ${e}`).join('\n')}` : ''}`,
        benchmarks: this.getDoraReferenceTable(),
        recommendations: '💡 Ensure your PAT has access to repositories and Actions data.',
      };
    }

    const metrics = doraData.metrics;
    const levelEmoji: Record<string, string> = {
      'Elite': '🏆',
      'High': '🥇',
      'Medium': '🥈',
      'Low': '🥉',
    };

    const levelColors: Record<string, string> = {
      'Elite': '🟢',
      'High': '🟢',
      'Medium': '🟡',
      'Low': '🔴',
    };

    // Safe access to levels with defaults
    const dfLevel = metrics.deploymentFrequency?.level || 'Low';
    const ltLevel = metrics.leadTimeForChanges?.level || 'Low';
    const cfrLevel = metrics.changeFailureRate?.level || 'Low';
    const ttrLevel = metrics.timeToRestore?.level || 'Low';
    const overallLevel = doraData.overallLevel || 'Low';

    // Build error section if present
    const errorSection = doraData.errors && doraData.errors.length > 0
      ? `\n\n### ⚠️ Data Collection Issues\n${doraData.errors.map((e: string) => `- ${e}`).join('\n')}`
      : '';

    return {
      summary: `## ${levelEmoji[overallLevel] || '📊'} DORA Metrics - ${overallLevel} Performer

| Metric | Value | Level |
|--------|-------|-------|
| Deployment Frequency | ${metrics.deploymentFrequency?.value ?? 'N/A'} ${metrics.deploymentFrequency?.unit || ''} | ${levelColors[dfLevel] || '⚪'} ${dfLevel} |
| Lead Time for Changes | ${this.formatHours(metrics.leadTimeForChanges?.value || 0)} | ${levelColors[ltLevel] || '⚪'} ${ltLevel} |
| Change Failure Rate | ${metrics.changeFailureRate?.value ?? 'N/A'}% | ${levelColors[cfrLevel] || '⚪'} ${cfrLevel} |
| Time to Restore | ${this.formatHours(metrics.timeToRestore?.value || 0)} | ${levelColors[ttrLevel] || '⚪'} ${ttrLevel} |${errorSection}`,

      benchmarks: this.getDoraReferenceTable(),

      recommendations: this.generateDoraRecommendations(doraData),
    };
  }

  private getDoraReferenceTable(): string {
    return `### DORA Performance Benchmarks

| Level | Deploy Freq | Lead Time | Change Failure | Time to Restore |
|-------|-------------|-----------|----------------|-----------------|
| Elite | Multiple/day | < 1 day | < 15% | < 1 hour |
| High | Weekly-Monthly | 1 day - 1 week | 16-30% | < 1 day |
| Medium | Monthly-Quarterly | 1 week - 1 month | 31-45% | < 1 week |
| Low | < Monthly | > 1 month | > 45% | > 1 week |`;
  }

  private generateDoraRecommendations(doraData: any): string {
    // Handle missing data
    if (!doraData || !doraData.metrics) {
      return `### 💡 Recommendations

To get actionable DORA recommendations:
1. Ensure your PAT has access to org repositories
2. Configure GitHub Environments for deployments
3. Use consistent labeling for bug/incident issues`;
    }

    const recommendations: string[] = [];
    const metrics = doraData.metrics;

    // Safe access to levels
    const dfLevel = metrics.deploymentFrequency?.level || 'Low';
    const ltLevel = metrics.leadTimeForChanges?.level || 'Low';
    const cfrLevel = metrics.changeFailureRate?.level || 'Low';
    const ttrLevel = metrics.timeToRestore?.level || 'Low';

    // Deployment Frequency recommendations
    if (dfLevel === 'Low' || dfLevel === 'Medium') {
      recommendations.push(`📦 **Increase Deployment Frequency**

**Current:** ${metrics.deploymentFrequency?.value || 'N/A'} ${metrics.deploymentFrequency?.unit || ''} (${dfLevel})
**Target:** Multiple deploys per day (Elite)

**Action Plan:**
1. Implement trunk-based development with short-lived branches
2. Add automated testing to build deployment confidence
3. Use feature flags for incremental releases
4. Break large changes into smaller, deployable units

\`\`\`yaml
# Enable continuous deployment on main
name: Deploy on Push
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci && npm test
      - run: npm run deploy -- --feature-flag
\`\`\``);
    }

    // Lead Time recommendations
    if (ltLevel === 'Low' || ltLevel === 'Medium' || ltLevel === 'Insufficient Data') {
      const ltValue = metrics.leadTimeForChanges?.value || 0;
      const formattedLtValue = this.formatHours(ltValue);
      recommendations.push(`⏱️ **Reduce Lead Time for Changes**

**Current:** ${formattedLtValue} (${ltLevel})
**Target:** Less than 1 hour (Elite)

**Action Plan:**
1. Automate code review assignment with CODEOWNERS
2. Implement PR size limits (< 400 lines recommended)
3. Add parallel testing to CI pipelines
4. Use draft PRs for early feedback

\`\`\`yaml
# Fast PR checks with parallelization
name: PR Checks
on: pull_request
jobs:
  checks:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - name: Parallel checks
        run: |
          npm ci
          npm run lint & npm run typecheck & wait
          npm test -- --changedSince=origin/main
\`\`\``);
    }

    // Change Failure Rate recommendations
    if (cfrLevel === 'Low' || cfrLevel === 'Medium') {
      recommendations.push(`🛡️ **Reduce Change Failure Rate**

**Current:** ${metrics.changeFailureRate?.value || 'N/A'}% (${cfrLevel})
**Target:** Less than 5% (Elite)

**Action Plan:**
1. Increase test coverage (aim for > 80%)
2. Implement canary deployments
3. Add integration/e2e tests
4. Use staging environments that mirror production

\`\`\`yaml
# Canary deployment pattern
name: Canary Deploy
on: push
jobs:
  canary:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Deploy to 5% traffic
        run: ./deploy.sh --canary 5
      - name: Wait and monitor
        run: sleep 300 && ./check-metrics.sh
      - name: Promote or rollback
        run: ./deploy.sh --promote-or-rollback
\`\`\``);
    }

    // Time to Restore recommendations
    if (ttrLevel === 'Low' || ttrLevel === 'Medium') {
      recommendations.push(`🔧 **Reduce Time to Restore**

**Current:** ${metrics.timeToRestore?.value || 'N/A'} ${metrics.timeToRestore?.unit || ''} (${ttrLevel})
**Target:** Less than 1 hour (Elite)

**Action Plan:**
1. Implement automated rollback capabilities
2. Add better monitoring and alerting
3. Document incident response procedures
4. Practice incident response with game days

\`\`\`yaml
# One-click rollback workflow
name: Emergency Rollback
on:
  workflow_dispatch:
    inputs:
      reason:
        description: 'Rollback reason'
        required: true
jobs:
  rollback:
    runs-on: ubuntu-latest
    steps:
      - name: Rollback to previous version
        run: ./rollback.sh --to-previous
      - name: Notify team
        uses: slackapi/slack-github-action@v1
        with:
          payload: '{"text": "🔄 Rollback: \${{ inputs.reason }}"}'
\`\`\``);
    }

    if (recommendations.length === 0) {
      return `### 🎉 Excellent Performance!
Your team is performing at Elite/High levels across all DORA metrics. Keep up the great work!

**To maintain this performance:**
- Continue monitoring metrics regularly
- Share best practices across teams
- Invest in automation and tooling
- Conduct regular retrospectives

**Elite Team Practices:**
\`\`\`yaml
# Example: Comprehensive CI/CD pipeline
name: Elite Pipeline
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/cache@v4
        with:
          path: node_modules
          key: deps-\${{ hashFiles('package-lock.json') }}
      - run: npm ci && npm test
  deploy:
    needs: test
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - run: ./deploy.sh --environment production
\`\`\``;
    }

    return `### 📈 Recommendations for Improvement

*Powered by GitHub Copilot patterns and industry best practices*

${recommendations.join('\n\n---\n\n')}

---

📚 **Resources:**
- [GitHub Actions documentation](https://docs.github.com/en/actions)
- [DORA metrics guide](https://dora.dev/guides/dora-metrics-four-keys/)
- [Trunk-based development](https://trunkbaseddevelopment.com/)`;
  }

  formatPullRequestMetrics(prData: any): any {
    const summary = prData.summary;
    
    let output = `## 🔀 Pull Request Metrics (${prData.timeframe})

### Summary
- **Merged PRs:** ${summary.totalMerged}
- **Open PRs:** ${summary.totalOpen}
- **Avg Lead Time:** ${this.formatHours(summary.avgLeadTimeHours)}
- **Median Lead Time:** ${this.formatHours(summary.medianLeadTimeHours)}
- **P95 Lead Time:** ${this.formatHours(summary.p95LeadTimeHours)}

### PR Size Distribution
| Size | Count | Description |
|------|-------|-------------|
| Small | ${prData.sizeDistribution.small} | < 50 lines |
| Medium | ${prData.sizeDistribution.medium} | 50-200 lines |
| Large | ${prData.sizeDistribution.large} | 200-500 lines |
| XLarge | ${prData.sizeDistribution.xlarge} | > 500 lines |`;

    if (prData.openPRs && prData.openPRs.length > 0) {
      output += `\n\n### Oldest Open PRs\n| # | Title | Author | Age |\n|---|-------|--------|-----|\n`;
      for (const pr of prData.openPRs.slice(0, 5)) {
        output += `| #${pr.number} | ${pr.title.substring(0, 40)}${pr.title.length > 40 ? '...' : ''} | ${pr.author} | ${this.formatHours(pr.ageHours)} |\n`;
      }
    }

    return { summary: output };
  }

  formatIssueMetrics(issueData: any): any {
    const summary = issueData.summary;

    let output = `## 🐛 Issue Metrics (${issueData.timeframe})

### Summary
- **Closed Issues:** ${summary.totalClosed}
- **Open Issues:** ${summary.totalOpen}
- **Avg Time to Close:** ${this.formatHours(summary.avgTimeToCloseHours)}
- **Median Time to Close:** ${this.formatHours(summary.medianTimeToCloseHours)}
- **Bug Count:** ${summary.bugCount}`;

    if (issueData.labelDistribution && issueData.labelDistribution.length > 0) {
      output += `\n\n### Top Labels\n| Label | Count |\n|-------|-------|\n`;
      for (const label of issueData.labelDistribution.slice(0, 5)) {
        output += `| ${label.label} | ${label.count} |\n`;
      }
    }

    if (issueData.oldestOpenIssues && issueData.oldestOpenIssues.length > 0) {
      output += `\n\n### Oldest Open Issues\n| # | Title | Age |\n|---|-------|-----|\n`;
      for (const issue of issueData.oldestOpenIssues) {
        output += `| #${issue.number} | ${issue.title.substring(0, 40)}${issue.title.length > 40 ? '...' : ''} | ${issue.ageDays} days |\n`;
      }
    }

    return { summary: output };
  }

  // ============================================
  // Deployments & Environments Formatting
  // ============================================

  formatDeploymentMetrics(deploymentData: any): any {
    const summary = deploymentData.summary;
    
    let output = `## 🚀 Deployment Metrics (${deploymentData.timeframe})

### Summary
- **Total Deployments:** ${summary.totalDeployments}
- **Deployment Frequency:** ${summary.deploymentFrequency} ${summary.frequencyUnit}
- **Production Deployments:** ${summary.productionDeployments}
- **Production Success Rate:** ${summary.productionSuccessRate}%
- **Change Failure Rate:** ${summary.changeFailureRate}%

### Environments
| Environment | Deployments | Success Rate | Avg Duration |
|-------------|-------------|--------------|--------------|`;

    for (const env of deploymentData.environments || []) {
      output += `\n| ${env.name} | ${env.total} | ${env.successRate}% | ${this.formatDuration(env.avgDurationSeconds)} |`;
    }

    if (deploymentData.recentDeployments?.length > 0) {
      output += `\n\n### Recent Deployments\n| Repo | Environment | Status | SHA | When |\n|------|-------------|--------|-----|------|\n`;
      for (const dep of deploymentData.recentDeployments.slice(0, 8)) {
        const when = this.formatTimeAgo(new Date(dep.createdAt));
        const statusEmoji = dep.status === 'success' ? '✅' : dep.status === 'failure' ? '❌' : '⏳';
        output += `| ${dep.repo} | ${dep.environment} | ${statusEmoji} ${dep.status} | ${dep.sha} | ${when} |\n`;
      }
    }

    return { summary: output };
  }

  formatEnvironmentMetrics(envData: any): any {
    let output = `## 🌍 Environment Configuration

### Summary
- **Total Environments:** ${envData.totalEnvironments}
- **Unique Environment Names:** ${envData.uniqueEnvironmentNames}

### Environment Distribution
| Environment | Repos | Protection | Reviewers | Wait Timer |
|-------------|-------|------------|-----------|------------|`;

    for (const env of envData.environmentSummary || []) {
      output += `\n| ${env.name} | ${env.count} | ${env.hasProtection ? '✅' : '❌'} | ${env.hasReviewers ? '✅' : '❌'} | ${env.hasWaitTimer ? '✅' : '❌'} |`;
    }

    // Security recommendations
    const unprotectedProd = envData.environmentSummary?.filter(
      (e: any) => ['production', 'prod'].includes(e.name.toLowerCase()) && !e.hasProtection
    ) || [];

    if (unprotectedProd.length > 0) {
      output += `\n\n### ⚠️ Security Recommendations
- **${unprotectedProd.length}** production environment(s) without protection rules
- Consider adding required reviewers for production deployments
- Enable wait timers for critical environments`;
    }

    return { summary: output };
  }

  // ============================================
  // Discussions Formatting
  // ============================================

  formatDiscussionMetrics(discussionData: any): any {
    const summary = discussionData.summary;

    let output = `## 💬 Discussion Metrics (${discussionData.timeframe})

### Summary
- **Total Discussions:** ${summary.totalDiscussions}
- **Answered:** ${summary.answered} (${summary.answerRate}%)
- **Unanswered:** ${summary.unanswered}
- **Avg Comments/Discussion:** ${summary.avgCommentsPerDiscussion}

### Category Distribution
| Category | Count |
|----------|-------|`;

    for (const cat of discussionData.categoryDistribution?.slice(0, 5) || []) {
      output += `\n| ${cat.category} | ${cat.count} |`;
    }

    if (discussionData.unansweredDiscussions?.length > 0) {
      output += `\n\n### Unanswered Discussions (Oldest)\n| # | Title | Author | Age |\n|---|-------|--------|-----|\n`;
      for (const disc of discussionData.unansweredDiscussions) {
        const age = this.formatTimeAgo(new Date(disc.createdAt));
        output += `| #${disc.number} | ${disc.title.substring(0, 35)}${disc.title.length > 35 ? '...' : ''} | ${disc.author} | ${age} |\n`;
      }
    }

    return { summary: output };
  }

  // ============================================
  // Merge Queue Formatting
  // ============================================

  formatMergeQueueMetrics(queueData: any): any {
    const summary = queueData.summary;

    let output = `## 🔄 Merge Queue Metrics

### Summary
- **Repos Analyzed:** ${summary.reposAnalyzed}
- **Repos with Merge Queue:** ${summary.reposWithMergeQueue} (${summary.adoptionRate}%)
- **Total PRs in Queue:** ${summary.totalPRsInQueue}

### Queue Status
| Repository | Branch | Queue Length |
|------------|--------|--------------|`;

    for (const queue of queueData.queueDetails || []) {
      output += `\n| ${queue.repo} | ${queue.branch} | ${queue.queueLength} |`;
      
      // Show queue entries if any
      if (queue.entries?.length > 0) {
        output += `\n\n**${queue.repo} Queue:**\n| Position | PR | Author |\n|----------|----|---------|\n`;
        for (const entry of queue.entries) {
          output += `| ${entry.position} | #${entry.prNumber} ${entry.prTitle?.substring(0, 25)}... | ${entry.author} |\n`;
        }
      }
    }

    if (queueData.reposWithoutMergeQueue?.length > 0 && queueData.reposWithoutMergeQueue.length <= 10) {
      output += `\n\n### Repos Without Merge Queue
${queueData.reposWithoutMergeQueue.map((r: string) => `- ${r}`).join('\n')}`;
    }

    output += `\n\n### 💡 Merge Queue Benefits
- Prevents broken builds on protected branches
- Reduces merge conflicts by testing PRs in sequence
- Ensures CI passes before merging`;

    return { summary: output };
  }

  formatEnhancedDoraMetrics(doraData: any): any {
    // Handle missing or incomplete data
    if (!doraData || !doraData.metrics) {
      return {
        summary: `## ⚠️ Enhanced DORA Metrics - Insufficient Data

Unable to calculate enhanced DORA metrics. This could be due to:
- No GitHub Deployments configured
- Missing repository access
- Insufficient permissions

${doraData?.errors ? `### Errors:\n${doraData.errors.map((e: string) => `- ${e}`).join('\n')}` : ''}

💡 **Tip:** To enable deployment tracking, add \`environment:\` to your deployment jobs in GitHub Actions.`,
        benchmarks: this.getDoraReferenceTable(),
        recommendations: '💡 Configure GitHub Environments for production deployments to get accurate DORA metrics.',
      };
    }

    const metrics = doraData.metrics;
    const levelEmoji: Record<string, string> = {
      'Elite': '🏆',
      'High': '🥇',
      'Medium': '🥈',
      'Low': '🥉',
      'Insufficient Data': '⚠️',
    };

    const levelColors: Record<string, string> = {
      'Elite': '🟢',
      'High': '🟢',
      'Medium': '🟡',
      'Low': '🔴',
      'Insufficient Data': '⚪',
    };

    // Safe access to levels with defaults
    const dfLevel = metrics.deploymentFrequency?.level || 'Low';
    const ltLevel = metrics.leadTimeForChanges?.level || 'Low';
    const cfrLevel = metrics.changeFailureRate?.level || 'Low';
    const ttrLevel = metrics.timeToRestore?.level || 'Low';
    const overallLevel = doraData.overallLevel || 'Low';

    // Check for lead time data quality
    const ltValue = metrics.leadTimeForChanges?.value || 0;
    const ltHasValidData = metrics.leadTimeForChanges?.hasValidData !== false;
    const ltSource = metrics.leadTimeForChanges?.source || 'unknown';
    
    // Build lead time display with source context
    let ltDisplayValue = ltHasValidData ? this.formatHours(ltValue) : 'N/A';
    let ltDetails = 'PR merge time';
    if (!ltHasValidData || ltLevel === 'Insufficient Data') {
      ltDetails = '⚠️ No data available';
    } else if (ltSource === 'deployment-duration-proxy') {
      ltDetails = 'Estimated from deployment duration';
    }

    // Build error section if present
    const errorSection = doraData.errors && doraData.errors.length > 0
      ? `\n\n### ⚠️ Data Collection Issues\n${doraData.errors.map((e: string) => `- ${e}`).join('\n')}`
      : '';

    // Build warning section for insufficient data
    let warningSection = '';
    if (!ltHasValidData || ltLevel === 'Insufficient Data') {
      warningSection = `\n\n### ⚠️ Lead Time Data Warning
Lead Time for Changes shows insufficient data. This could be due to:
- No merged PRs with valid timestamps in the selected timeframe
- Missing PR merge data
- Repository access limitations

**Recommendation:** Check that repositories have recent merged PRs and that the token has access to PR data.`;
    }

    let output = `## ${levelEmoji[overallLevel] || '📊'} DORA Metrics (Enhanced) - ${overallLevel} Performer
**Data Source:** GitHub Deployments API

| Metric | Value | Level | Details |
|--------|-------|-------|---------|
| Deployment Frequency | ${metrics.deploymentFrequency?.value ?? 'N/A'}/day | ${levelColors[dfLevel] || '⚪'} ${dfLevel} | ${metrics.deploymentFrequency?.productionDeployments ?? 0} prod deploys |
| Lead Time for Changes | ${ltDisplayValue} | ${levelColors[ltLevel] || '⚪'} ${ltLevel} | ${ltDetails} |
| Change Failure Rate | ${metrics.changeFailureRate?.value ?? 'N/A'}% | ${levelColors[cfrLevel] || '⚪'} ${cfrLevel} | ${metrics.changeFailureRate?.failedDeployments ?? 0} failed |
| Time to Restore | ${this.formatHours(metrics.timeToRestore?.value || 0)} | ${levelColors[ttrLevel] || '⚪'} ${ttrLevel} | ${metrics.timeToRestore?.incidentCount ?? 0} incidents |${errorSection}${warningSection}`;

    if (doraData.environments?.length > 0) {
      output += `\n\n### Environment Performance\n| Environment | Deploys | Success Rate |\n|-------------|---------|---------------|\n`;
      for (const env of doraData.environments) {
        output += `| ${env.name} | ${env.total} | ${env.successRate}% |\n`;
      }
    }

    return {
      summary: output,
      benchmarks: this.getDoraReferenceTable(),
      recommendations: this.generateDoraRecommendations(doraData),
    };
  }

  private formatTimeAgo(date: Date): string {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return `${Math.floor(diffDays / 7)}w ago`;
  }

  private formatHours(hours: number): string {
    if (hours < 1) return `${Math.round(hours * 60)}m`;
    if (hours < 24) return `${Math.round(hours)}h`;
    if (hours < 168) return `${(hours / 24).toFixed(1)}d`;
    return `${(hours / 168).toFixed(1)}w`;
  }

  private formatDuration(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m ${seconds % 60}s`;
    return `${Math.floor(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m`;
  }

  // ============================================
  // Custom Properties Formatting
  // ============================================

  formatCustomPropertiesAnalytics(data: any): any {
    let output = `## 🏷️ Custom Properties Analytics

### Summary
- **Total Repositories:** ${data.totalRepositories}
- **Total Properties Defined:** ${data.totalProperties}
- **Repos Without Properties:** ${data.reposWithNoProperties?.length || 0}

### Property Definitions
| Property | Type | Required | Default |
|----------|------|----------|---------|`;

    for (const prop of data.propertyDefinitions || []) {
      output += `\n| ${prop.name} | ${prop.valueType} | ${prop.required ? '✅' : '❌'} | ${prop.defaultValue || '-'} |`;
    }

    output += `\n\n### Property Coverage\n| Property | Coverage | Defined | Undefined |\n|----------|----------|---------|-----------|`;

    for (const coverage of data.propertyCoverage || []) {
      const coverageEmoji = coverage.coverage >= 80 ? '🟢' : coverage.coverage >= 50 ? '🟡' : '🔴';
      output += `\n| ${coverage.property} | ${coverageEmoji} ${coverage.coverage}% | ${coverage.defined} | ${coverage.undefined} |`;
    }

    // Show top values for each property
    output += `\n\n### Property Value Distribution`;
    for (const coverage of data.propertyCoverage || []) {
      if (coverage.topValues?.length > 0) {
        output += `\n\n**${coverage.property}:**\n`;
        for (const val of coverage.topValues) {
          output += `- ${val.value}: ${val.count} repos\n`;
        }
      }
    }

    if (data.reposWithNoProperties?.length > 0 && data.reposWithNoProperties.length <= 10) {
      output += `\n\n### ⚠️ Repos Without Properties\n${data.reposWithNoProperties.map((r: string) => `- ${r}`).join('\n')}`;
    } else if (data.reposWithNoProperties?.length > 10) {
      output += `\n\n### ⚠️ ${data.reposWithNoProperties.length} Repos Without Properties
Consider adding custom properties to categorize these repositories.`;
    }

    return { summary: output };
  }

  formatReposByProperty(data: any): any {
    let output = `## 🏷️ Repositories by Property: ${data.propertyName}`;
    
    if (data.propertyValue && data.propertyValue !== 'all') {
      output += ` = "${data.propertyValue}"`;
    }

    output += `\n\n**Matching Repositories:** ${data.matchingRepos}`;

    if (data.groupedByValue && Object.keys(data.groupedByValue).length > 0) {
      output += `\n\n### Grouped by Value`;
      for (const [value, repos] of Object.entries(data.groupedByValue)) {
        output += `\n\n**${value}** (${(repos as string[]).length} repos):\n`;
        for (const repo of (repos as string[]).slice(0, 10)) {
          output += `- ${repo}\n`;
        }
        if ((repos as string[]).length > 10) {
          output += `- ... and ${(repos as string[]).length - 10} more\n`;
        }
      }
    } else if (data.repositories?.length > 0) {
      output += `\n\n### Repositories\n| Repository | Value |\n|------------|-------|\n`;
      for (const repo of data.repositories.slice(0, 20)) {
        output += `| ${repo.name} | ${repo.value} |\n`;
      }
    }

    return { summary: output };
  }

  formatOrgCustomProperties(data: any): any {
    if (data.message) {
      return { summary: `ℹ️ ${data.message}` };
    }

    let output = `## 🏷️ Organization Custom Property Definitions

**Total Properties:** ${data.count}

| Property | Type | Required | Allowed Values |
|----------|------|----------|----------------|`;

    for (const prop of data.properties || []) {
      const allowedVals = prop.allowedValues?.slice(0, 3).join(', ') || '-';
      const more = prop.allowedValues?.length > 3 ? ` (+${prop.allowedValues.length - 3} more)` : '';
      output += `\n| ${prop.name} | ${prop.valueType} | ${prop.required ? '✅' : '❌'} | ${allowedVals}${more} |`;
    }

    output += `\n\n### 💡 Usage Tips
- Use \`get_repos_by_property\` to find repos with specific property values
- Use \`get_custom_properties_analytics\` for coverage analysis
- Properties help categorize repos by team, tier, compliance, etc.`;

    return { summary: output };
  }

  // ============================================
  // Enhanced GitHub Insights-Style Formatting
  // ============================================

  formatDetailedUsageMetrics(data: any): any {
    const summary = data.summary;
    const billing = data.billing;

    let output = `## 📊 GitHub Actions Usage Metrics (${data.timeframe})

### Summary
- **Total Workflow Runs:** ${summary.totalRuns}
- **Total Minutes Used:** ${summary.totalMinutes}
- **Unique Workflows:** ${summary.totalWorkflows}
- **Active Repositories:** ${summary.totalRepos}`;

    if (billing) {
      output += `\n\n### Billing
- **Total Minutes:** ${billing.totalMinutesUsed}
- **Included Minutes:** ${billing.includedMinutes}
- **Paid Overage:** ${billing.paidMinutesUsed} minutes`;
      
      if (billing.minutesByOS) {
        output += `\n\n**Minutes by OS:**`;
        if (billing.minutesByOS.UBUNTU) output += `\n- Ubuntu: ${billing.minutesByOS.UBUNTU}`;
        if (billing.minutesByOS.WINDOWS) output += `\n- Windows: ${billing.minutesByOS.WINDOWS}`;
        if (billing.minutesByOS.MACOS) output += `\n- macOS: ${billing.minutesByOS.MACOS}`;
      }
    }

    // By Workflow (top 10)
    if (data.byWorkflow?.length > 0) {
      output += `\n\n### Top Workflows by Usage
| Workflow | Runs | Minutes | Success | Failure | Repos |
|----------|------|---------|---------|---------|-------|`;
      for (const wf of data.byWorkflow.slice(0, 10)) {
        const successRate = wf.runs ? Math.round((wf.success / wf.runs) * 100) : 0;
        output += `\n| ${wf.name.substring(0, 30)}${wf.name.length > 30 ? '...' : ''} | ${wf.runs} | ${wf.minutes} | ${wf.success} (${successRate}%) | ${wf.failure} | ${wf.repoCount} |`;
      }
    }

    // By Repository (top 10)
    if (data.byRepository?.length > 0) {
      output += `\n\n### Top Repositories by Usage
| Repository | Runs | Minutes | Success Rate |
|------------|------|---------|--------------|`;
      for (const repo of data.byRepository.slice(0, 10)) {
        const successRate = repo.runs ? Math.round((repo.success / repo.runs) * 100) : 0;
        output += `\n| ${repo.name} | ${repo.runs} | ${repo.minutes} | ${successRate}% |`;
      }
    }

    // By Runner Type
    if (data.byRunnerType?.length > 0) {
      output += `\n\n### Usage by Runner Type
| Type | Runs | Minutes |
|------|------|---------|`;
      for (const rt of data.byRunnerType) {
        output += `\n| ${rt.type} | ${rt.runs} | ${rt.minutes} |`;
      }
    }

    // By OS
    if (data.byRunnerOS?.length > 0) {
      output += `\n\n### Usage by Runner OS
| OS | Runs | Minutes |
|----|------|---------|`;
      for (const os of data.byRunnerOS.slice(0, 5)) {
        output += `\n| ${os.os} | ${os.runs} | ${os.minutes} |`;
      }
    }

    // By Job (top 10)
    if (data.byJob?.length > 0) {
      output += `\n\n### Top Jobs by Usage
| Job | Runs | Minutes | Success Rate |
|-----|------|---------|--------------|`;
      for (const job of data.byJob.slice(0, 10)) {
        const successRate = job.runs ? Math.round((job.success / job.runs) * 100) : 0;
        output += `\n| ${job.name.substring(0, 35)}${job.name.length > 35 ? '...' : ''} | ${job.runs} | ${job.minutes} | ${successRate}% |`;
      }
    }

    return { summary: output };
  }

  formatDetailedPerformanceMetrics(data: any): any {
    const summary = data.summary;

    let output = `## ⚡ GitHub Actions Performance Metrics (${data.timeframe})

### Summary
- **Total Runs Analyzed:** ${summary.totalRuns}
- **Avg Run Duration:** ${this.formatDuration(summary.overallAvgDuration)}
- **Avg Queue Time:** ${this.formatDuration(summary.overallAvgQueueTime)}
- **Overall Failure Rate:** ${summary.overallFailureRate}%`;

    // By Workflow
    if (data.byWorkflow?.length > 0) {
      output += `\n\n### Workflow Performance
| Workflow | Runs | Avg Duration | P95 Duration | Avg Queue | Failure Rate |
|----------|------|--------------|--------------|-----------|--------------|`;
      for (const wf of data.byWorkflow.slice(0, 10)) {
        output += `\n| ${wf.name.substring(0, 25)}${wf.name.length > 25 ? '...' : ''} | ${wf.runs} | ${this.formatDuration(wf.avgDurationSeconds)} | ${this.formatDuration(wf.p95DurationSeconds)} | ${this.formatDuration(wf.avgQueueTimeSeconds)} | ${wf.failureRate}% |`;
      }
    }

    // By Repository
    if (data.byRepository?.length > 0) {
      output += `\n\n### Repository Performance
| Repository | Runs | Avg Duration | P95 Duration | Failure Rate |
|------------|------|--------------|--------------|--------------|`;
      for (const repo of data.byRepository.slice(0, 10)) {
        output += `\n| ${repo.name} | ${repo.runs} | ${this.formatDuration(repo.avgDurationSeconds)} | ${this.formatDuration(repo.p95DurationSeconds)} | ${repo.failureRate}% |`;
      }
    }

    // By Runner Type
    if (data.byRunnerType?.length > 0) {
      output += `\n\n### Performance by Runner Type
| Type | Runs | Avg Duration | Avg Queue Time | Failure Rate |
|------|------|--------------|----------------|--------------|`;
      for (const rt of data.byRunnerType) {
        output += `\n| ${rt.type} | ${rt.runs} | ${this.formatDuration(rt.avgDurationSeconds)} | ${this.formatDuration(rt.avgQueueTimeSeconds)} | ${rt.failureRate}% |`;
      }
    }

    // By OS
    if (data.byRunnerOS?.length > 0) {
      output += `\n\n### Performance by Runner OS
| OS | Runs | Avg Duration | Avg Queue Time | Failure Rate |
|----|------|--------------|----------------|--------------|`;
      for (const os of data.byRunnerOS.slice(0, 5)) {
        output += `\n| ${os.os} | ${os.runs} | ${this.formatDuration(os.avgDurationSeconds)} | ${this.formatDuration(os.avgQueueTimeSeconds)} | ${os.failureRate}% |`;
      }
    }

    // By Job
    if (data.byJob?.length > 0) {
      output += `\n\n### Top Jobs by Run Count
| Job | Runs | Avg Duration | Avg Queue | Failures |
|-----|------|--------------|-----------|----------|`;
      for (const job of data.byJob.slice(0, 10)) {
        output += `\n| ${job.name.substring(0, 30)}${job.name.length > 30 ? '...' : ''} | ${job.runs} | ${this.formatDuration(job.avgDurationSeconds)} | ${this.formatDuration(job.avgQueueTimeSeconds)} | ${job.failures} |`;
      }
    }

    // Insights
    output += `\n\n### 💡 Insights`;
    
    // Slow workflows
    const slowWorkflows = data.byWorkflow?.filter((w: any) => w.avgDurationSeconds > 600) || [];
    if (slowWorkflows.length > 0) {
      output += `\n- ⚠️ **${slowWorkflows.length} workflow(s)** have avg duration > 10 minutes`;
    }

    // High queue times
    const highQueueWorkflows = data.byWorkflow?.filter((w: any) => w.avgQueueTimeSeconds > 60) || [];
    if (highQueueWorkflows.length > 0) {
      output += `\n- ⏳ **${highQueueWorkflows.length} workflow(s)** have avg queue time > 1 minute`;
    }

    // High failure rate
    const failingWorkflows = data.byWorkflow?.filter((w: any) => w.failureRate > 20) || [];
    if (failingWorkflows.length > 0) {
      output += `\n- 🔴 **${failingWorkflows.length} workflow(s)** have failure rate > 20%`;
    }

    // Runner comparison
    const ghHosted = data.byRunnerType?.find((r: any) => r.type === 'github-hosted');
    const selfHosted = data.byRunnerType?.find((r: any) => r.type === 'self-hosted');
    if (ghHosted && selfHosted && selfHosted.runs > 0) {
      if (selfHosted.avgQueueTimeSeconds < ghHosted.avgQueueTimeSeconds) {
        output += `\n- ✅ Self-hosted runners have ${Math.round((ghHosted.avgQueueTimeSeconds - selfHosted.avgQueueTimeSeconds))}s lower avg queue time`;
      }
    }

    return { summary: output };
  }
}
