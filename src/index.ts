import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { GitHubEnterpriseClient } from './github/enterprise-client.js';
import { EnterpriseMetricsCalculator } from './metrics/enterprise-calculator.js';
import { EnterpriseVisualizationGenerator } from './visualization/enterprise-generator.js';
import { LicenseValidator } from './auth/license-validator.js';

// Validate Enterprise License on startup
const licenseValidator = new LicenseValidator();
await licenseValidator.validateEnterpriseLicense();

// Initialize GitHub Enterprise Client
const githubClient = new GitHubEnterpriseClient({
  appId: process.env.GITHUB_APP_ID!,
  privateKey: process.env.GITHUB_PRIVATE_KEY!,
  installationId: process.env.GITHUB_INSTALLATION_ID!,
  enterpriseSlug: process.env.GITHUB_ENTERPRISE_SLUG!,
  enterpriseUrl: process.env.GITHUB_ENTERPRISE_URL || 'https://api.github.com',
});

// Verify enterprise access
const isEnterprise = await githubClient.verifyEnterpriseAccess();
if (!isEnterprise) {
  console.error('❌ This MCP server requires GitHub Enterprise. Please upgrade your GitHub plan.');
  console.error('📧 Contact sales@github.com for Enterprise pricing.');
  process.exit(1);
}

// Initialize enterprise-specific calculators
const metricsCalculator = new EnterpriseMetricsCalculator(githubClient);
const visualizer = new EnterpriseVisualizationGenerator();

// Create MCP Server
const server = new Server(
  {
    name: 'devops-observer-enterprise',
    version: '2.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Enterprise-Exclusive Tools
server.setRequestHandler('tools/list', async () => ({
  tools: [
    {
      name: 'get_actions_usage_metrics',
      description: 'Get GitHub Actions usage metrics and billing data (Enterprise only)',
      inputSchema: z.object({
        org_name: z.string().describe('Organization name'),
        timeframe: z.enum(['24h', '7d', '30d', '90d']).describe('Analysis timeframe'),
        breakdown: z.enum(['workflow', 'job', 'runner', 'os']).optional().describe('Breakdown type'),
      }),
    },
    {
      name: 'get_actions_performance_metrics',
      description: 'Get detailed Actions performance metrics with queue times and runner efficiency (Enterprise only)',
      inputSchema: z.object({
        org_name: z.string().describe('Organization name'),
        repo_name: z.string().optional().describe('Specific repository (optional)'),
        workflow_id: z.string().optional().describe('Specific workflow ID (optional)'),
        timeframe: z.enum(['1h', '6h', '24h', '7d', '30d']),
      }),
    },
    {
      name: 'analyze_runner_utilization',
      description: 'Analyze self-hosted and GitHub-hosted runner utilization (Enterprise only)',
      inputSchema: z.object({
        org_name: z.string(),
        runner_type: z.enum(['self-hosted', 'github-hosted', 'all']).default('all'),
        include_costs: z.boolean().default(true),
      }),
    },
    {
      name: 'get_actions_cache_analytics',
      description: 'Analyze Actions cache usage and efficiency across the organization (Enterprise only)',
      inputSchema: z.object({
        org_name: z.string(),
        repo_name: z.string().optional(),
        timeframe: z.enum(['24h', '7d', '30d']),
      }),
    },
    {
      name: 'generate_cost_optimization_report',
      description: 'Generate comprehensive cost optimization recommendations based on Actions usage (Enterprise only)',
      inputSchema: z.object({
        org_name: z.string(),
        include_recommendations: z.boolean().default(true),
        target_savings_percentage: z.number().min(5).max(50).default(20),
      }),
    },
    {
      name: 'get_workflow_insights',
      description: 'Get AI-powered workflow insights with bottleneck detection (Enterprise only)',
      inputSchema: z.object({
        org_name: z.string(),
        repo_name: z.string(),
        workflow_name: z.string(),
        analyze_dependencies: z.boolean().default(true),
      }),
    },
    {
      name: 'get_team_productivity_metrics',
      description: 'Analyze team productivity based on Actions data (Enterprise only)',
      inputSchema: z.object({
        org_name: z.string(),
        team_slug: z.string().optional(),
        include_individuals: z.boolean().default(false),
        timeframe: z.enum(['7d', '30d', '90d']),
      }),
    },
    {
      name: 'get_compliance_audit_report',
      description: 'Generate compliance and audit report for Actions usage (Enterprise only)',
      inputSchema: z.object({
        org_name: z.string(),
        compliance_framework: z.enum(['SOC2', 'ISO27001', 'HIPAA', 'PCI-DSS', 'CUSTOM']).optional(),
        include_secrets_scan: z.boolean().default(true),
      }),
    },
  ],
}));

// Tool: Get Actions Usage Metrics (Enterprise Exclusive)
server.setRequestHandler('tools/call', async (request) => {
  // Verify enterprise access for each call
  await licenseValidator.checkRateLimit();
  
  if (request.params.name === 'get_actions_usage_metrics') {
    const args = request.params.arguments as any;
    
    const usageData = await githubClient.getActionsUsageMetrics(
      args.org_name,
      args.timeframe,
      args.breakdown
    );
    
    const visualization = visualizer.createUsageDashboard(usageData);
    const costAnalysis = metricsCalculator.calculateActionsCosts(usageData);
    
    return {
      content: [
        {
          type: 'text',
          text: `## 📊 GitHub Actions Usage Metrics (Enterprise)\n\n${costAnalysis.summary}\n\n### Visualization:\n\`\`\`mermaid\n${visualization}\n\`\`\`\n\n### Detailed Breakdown:\n${costAnalysis.details}`,
        },
      ],
    };
  }
  
  if (request.params.name === 'get_actions_performance_metrics') {
    const args = request.params.arguments as any;
    
    const perfData = await githubClient.getActionsPerformanceMetrics(
      args.org_name,
      args.repo_name,
      args.workflow_id,
      args.timeframe
    );
    
    const analysis = metricsCalculator.analyzePerformance(perfData);
    const chart = visualizer.createPerformanceChart(analysis);
    
    return {
      content: [
        {
          type: 'text',
          text: `## ⚡ Actions Performance Metrics (Enterprise)\n\n${analysis.summary}\n\n\`\`\`mermaid\n${chart}\n\`\`\`\n\n### Key Insights:\n${analysis.insights}`,
        },
      ],
    };
  }
  
  if (request.params.name === 'analyze_runner_utilization') {
    const args = request.params.arguments as any;
    
    const runnerData = await githubClient.getRunnerUtilization(
      args.org_name,
      args.runner_type
    );
    
    const utilization = metricsCalculator.calculateRunnerUtilization(runnerData);
    const costBreakdown = args.include_costs ? 
      await metricsCalculator.calculateRunnerCosts(runnerData) : null;
    const visualization = visualizer.createRunnerUtilizationChart(utilization, costBreakdown);
    
    return {
      content: [
        {
          type: 'text',
          text: `## 🏃 Runner Utilization Analysis (Enterprise)\n\n${utilization.summary}\n\n\`\`\`mermaid\n${visualization}\n\`\`\`\n\n${costBreakdown ? `### Cost Analysis:\n${costBreakdown.details}` : ''}`,
        },
      ],
    };
  }
  
  if (request.params.name === 'get_actions_cache_analytics') {
    const args = request.params.arguments as any;
    
    const cacheData = await githubClient.getActionsCacheMetrics(
      args.org_name,
      args.repo_name,
      args.timeframe
    );
    
    const analysis = metricsCalculator.analyzeCacheEfficiency(cacheData);
    const visualization = visualizer.createCacheAnalyticsChart(analysis);
    
    return {
      content: [
        {
          type: 'text',
          text: `## 💾 Actions Cache Analytics (Enterprise)\n\n${analysis.summary}\n\n\`\`\`mermaid\n${visualization}\n\`\`\`\n\n### Optimization Opportunities:\n${analysis.recommendations}`,
        },
      ],
    };
  }
  
  if (request.params.name === 'generate_cost_optimization_report') {
    const args = request.params.arguments as any;
    
    const usageData = await githubClient.getComprehensiveUsageData(args.org_name);
    const report = await metricsCalculator.generateCostOptimizationReport(
      usageData,
      args.target_savings_percentage
    );
    
    const visualization = visualizer.createCostOptimizationDashboard(report);
    
    return {
      content: [
        {
          type: 'text',
          text: `## 💰 Cost Optimization Report (Enterprise)\n\n${report.executive_summary}\n\n\`\`\`mermaid\n${visualization}\n\`\`\`\n\n### Top Recommendations:\n${report.recommendations}\n\n### Projected Savings:\n${report.savings_breakdown}`,
        },
      ],
    };
  }
  
  if (request.params.name === 'get_workflow_insights') {
    const args = request.params.arguments as any;
    
    const workflowData = await githubClient.getWorkflowInsights(
      args.org_name,
      args.repo_name,
      args.workflow_name
    );
    
    const insights = await metricsCalculator.generateWorkflowInsights(
      workflowData,
      args.analyze_dependencies
    );
    
    const visualization = visualizer.createWorkflowBottleneckChart(insights);
    
    return {
      content: [
        {
          type: 'text',
          text: `## 🔍 Workflow Insights (Enterprise AI-Powered)\n\n${insights.summary}\n\n\`\`\`mermaid\n${visualization}\n\`\`\`\n\n### Bottlenecks Detected:\n${insights.bottlenecks}\n\n### Optimization Suggestions:\n${insights.suggestions}`,
        },
      ],
    };
  }
  
  if (request.params.name === 'get_team_productivity_metrics') {
    const args = request.params.arguments as any;
    
    const productivityData = await githubClient.getTeamProductivityMetrics(
      args.org_name,
      args.team_slug,
      args.timeframe
    );
    
    const metrics = metricsCalculator.calculateTeamProductivity(
      productivityData,
      args.include_individuals
    );
    
    const visualization = visualizer.createTeamProductivityDashboard(metrics);
    
    return {
      content: [
        {
          type: 'text',
          text: `## 👥 Team Productivity Metrics (Enterprise)\n\n${metrics.summary}\n\n\`\`\`mermaid\n${visualization}\n\`\`\`\n\n### Key Performance Indicators:\n${metrics.kpis}\n\n${metrics.individual_highlights || ''}`,
        },
      ],
    };
  }
  
  if (request.params.name === 'get_compliance_audit_report') {
    const args = request.params.arguments as any;
    
    const auditData = await githubClient.getComplianceAuditData(
      args.org_name,
      args.include_secrets_scan
    );
    
    const report = await metricsCalculator.generateComplianceReport(
      auditData,
      args.compliance_framework
    );
    
    const visualization = visualizer.createComplianceDashboard(report);
    
    return {
      content: [
        {
          type: 'text',
          text: `## 🔒 Compliance Audit Report (Enterprise)\n\n${report.executive_summary}\n\n\`\`\`mermaid\n${visualization}\n\`\`\`\n\n### Compliance Status:\n${report.compliance_status}\n\n### Risk Assessment:\n${report.risk_assessment}\n\n### Required Actions:\n${report.required_actions}`,
        },
      ],
    };
  }
  
  throw new Error(`Unknown tool: ${request.params.name}`);
});

// Start MCP Server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  
  console.error('🏢 MCP DevOps Observer Enterprise Server started');
  console.error('✅ GitHub Enterprise access verified');
  console.error(`📊 Monitoring ${await githubClient.getOrganizationCount()} organizations`);
}

main().catch((error) => {
  console.error('❌ Server error:', error);
  process.exit(1);
});