export class VisualizationGenerator {
  createUsageDashboard(usageData: any): string {
    const billing = usageData.billing || {};
    const stats = usageData.workflowStats || {};
    
    const total = billing.total_minutes_used || 0;
    const included = billing.included_minutes || 0;
    const paid = Math.max(0, total - included);

    return `graph TB
    subgraph "📊 Actions Usage Dashboard"
        subgraph "Minutes Usage"
            A[Total: ${total} min]
            B[Included: ${included} min]
            C[Paid: ${paid} min]
        end
        subgraph "Run Statistics"
            D[Total Runs: ${usageData.totalRuns || 0}]
            E[Success: ${stats.byConclusion?.success || 0}]
            F[Failed: ${stats.byConclusion?.failure || 0}]
        end
    end
    A --> B
    A --> C
    D --> E
    D --> F`;
  }

  createPerformanceChart(analysis: any): string {
    return `graph LR
    subgraph "⚡ Performance Metrics"
        A[Runs Analyzed] -->|${analysis.summary?.match(/Completed Runs: (\d+)/)?.[1] || '0'}| B[Completed]
        B -->|Success| C[✅ ${analysis.summary?.match(/Success Rate: ([\d.]+)/)?.[1] || '0'}%]
        B -->|Failure| D[❌ ${analysis.summary?.match(/Failure Rate: ([\d.]+)/)?.[1] || '0'}%]
    end
    
    subgraph "⏱️ Timing"
        E[Avg Duration]
        F[P95 Duration]
    end`;
  }

  createRunnerUtilizationChart(utilization: any, costBreakdown: any): string {
    const summary = utilization.summary || '';
    const totalMatch = summary.match(/Total: (\d+)/);
    const busyMatch = summary.match(/Busy: (\d+)/);
    const idleMatch = summary.match(/Idle: (\d+)/);
    
    const total = parseInt(totalMatch?.[1] || '0');
    const busy = parseInt(busyMatch?.[1] || '0');
    const idle = parseInt(idleMatch?.[1] || '0');
    
    if (total === 0) {
      return `graph TD
    A[✅ Using GitHub-Hosted Runners]
    B[Ephemeral VMs with automatic security updates]
    C[OIDC support for secure cloud deployments]
    D[No infrastructure to manage]
    A --> B
    A --> C
    A --> D`;
    }

    const busyPct = Math.round((busy / total) * 100);
    const idlePct = 100 - busyPct;

    return `pie title Self-Hosted Runner Utilization
    "Busy (${busy})" : ${busyPct}
    "Idle (${idle})" : ${idlePct}`;
  }

  createCacheAnalyticsChart(analysis: any): string {
    return `graph TD
    subgraph "💾 Cache Analytics"
        A[Organization Cache]
        B[Active Caches]
        C[Cache Size]
        D[Recommendations]
    end
    A --> B
    A --> C
    C --> D`;
  }

  createCostOptimizationDashboard(report: any): string {
    return `graph TB
    subgraph "💰 Cost Optimization"
        A[Current Spend] --> B[Analysis]
        B --> C[Caching]
        B --> D[ARM Runners]
        B --> E[Right-Sizing]
        B --> F[Concurrency]
        C --> G[Projected Savings]
        D --> G
        E --> G
        F --> G
    end
    
    style G fill:#90EE90`;
  }

  createWorkflowBottleneckChart(insights: any): string {
    return `graph TD
    subgraph "🔍 Workflow Analysis"
        A[Workflow Runs] --> B{Success?}
        B -->|Yes| C[✅ Passed]
        B -->|No| D[❌ Failed]
        D --> E[Analyze Bottlenecks]
        E --> F[Job Duration]
        E --> G[Step Failures]
        E --> H[Resource Usage]
    end`;
  }

  createTeamProductivityDashboard(metrics: any): string {
    return `graph LR
    subgraph "👥 Team Productivity"
        A[Workflow Activity] --> B[Deployment Frequency]
        A --> C[Success Rate]
        A --> D[Contributors]
    end
    
    subgraph "📈 DORA Metrics"
        E[Lead Time]
        F[MTTR]
        G[Change Failure Rate]
    end
    
    B --> E
    C --> G`;
  }

  createComplianceDashboard(report: any): string {
    return `graph TD
    subgraph "🔒 Compliance Status"
        A[Security Audit] --> B{2FA Required?}
        B -->|Yes| C[✅ Compliant]
        B -->|No| D[⚠️ Action Required]
        
        A --> E{Branch Protection?}
        E -->|Yes| F[✅ Protected]
        E -->|Partial| G[🟡 Review Needed]
        
        A --> H{Secret Alerts?}
        H -->|None| I[✅ Clean]
        H -->|Found| J[🔴 Remediate]
    end`;
  }

  // Enhanced visualization for organization overview
  createOrgOverviewDashboard(data: any): string {
    return `graph TB
    subgraph "🏢 Organization Overview"
        A[GitHub Organization] --> B[Repositories]
        A --> C[Workflows]
        A --> D[Runners]
        
        B --> E[Active PRs]
        B --> F[Recent Commits]
        
        C --> G[Actions Usage]
        C --> H[Performance]
        
        D --> I[Self-Hosted]
        D --> J[GitHub-Hosted]
    end`;
  }
}
