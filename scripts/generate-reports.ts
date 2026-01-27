#!/usr/bin/env npx tsx
/**
 * Standalone script to generate DevOps reports
 * 
 * Usage:
 *   npx tsx scripts/generate-reports.ts [options]
 * 
 * Options:
 *   --org <name>        Organization name (or set GITHUB_ORG env var)
 *   --output <path>     Output directory (default: ./reports)
 *   --timeframe <days>  Analysis timeframe: 7d, 30d, 90d (default: 30d)
 *   --reports <types>   Comma-separated: dora,cicd,cost,compliance,all (default: all)
 * 
 * Environment Variables:
 *   GITHUB_TOKEN        Required: GitHub personal access token
 *   GITHUB_ORG          Default organization name
 *   DEVOPS_CONFIG_PATH  Local config directory path
 */

import { GitHubOrgClient } from '../src/github/org-client.js';
import { MetricsCalculator } from '../src/metrics/calculator.js';
import { ConfigLoader } from '../src/config/config-loader.js';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

// Parse command line arguments
function parseArgs(): {
  org: string;
  output: string;
  timeframe: '7d' | '30d' | '90d';
  reports: string[];
} {
  const args = process.argv.slice(2);
  const result = {
    org: process.env.GITHUB_ORG || '',
    output: './reports',
    timeframe: '30d' as '7d' | '30d' | '90d',
    reports: ['all'],
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--org':
        result.org = args[++i];
        break;
      case '--output':
        result.output = args[++i];
        break;
      case '--timeframe':
        result.timeframe = args[++i] as '7d' | '30d' | '90d';
        break;
      case '--reports':
        result.reports = args[++i].split(',').map(r => r.trim());
        break;
      case '--help':
        console.log(`
DevOps Report Generator

Usage: npx tsx scripts/generate-reports.ts [options]

Options:
  --org <name>        Organization name (or set GITHUB_ORG env var)
  --output <path>     Output directory (default: ./reports)
  --timeframe <days>  Analysis timeframe: 7d, 30d, 90d (default: 30d)
  --reports <types>   Comma-separated: dora,cicd,cost,compliance,all (default: all)

Environment Variables:
  GITHUB_TOKEN        Required: GitHub personal access token
  GITHUB_ORG          Default organization name
  DEVOPS_CONFIG_PATH  Local config directory path
`);
        process.exit(0);
    }
  }

  return result;
}

async function main() {
  const { org, output, timeframe, reports } = parseArgs();

  if (!process.env.GITHUB_TOKEN) {
    console.error('❌ GITHUB_TOKEN environment variable is required');
    process.exit(1);
  }

  if (!org) {
    console.error('❌ Organization name is required. Use --org <name> or set GITHUB_ORG');
    process.exit(1);
  }

  console.log('🚀 DevOps Report Generator');
  console.log(`📊 Organization: ${org}`);
  console.log(`📅 Timeframe: ${timeframe}`);
  console.log(`📁 Output: ${output}`);
  console.log(`📋 Reports: ${reports.join(', ')}`);
  console.log('');

  // Initialize clients
  const config = {
    token: process.env.GITHUB_TOKEN,
    baseUrl: process.env.GITHUB_API_URL || 'https://api.github.com',
  };

  const githubClient = new GitHubOrgClient(config, {});
  const metricsCalculator = new MetricsCalculator(githubClient);
  const configLoader = new ConfigLoader({
    token: config.token,
    org,
    localPath: process.env.DEVOPS_CONFIG_PATH,
  });

  // Verify access
  const { hasOrgAccess } = await githubClient.verifyAccess();
  if (!hasOrgAccess) {
    console.error('❌ Failed to authenticate with GitHub');
    process.exit(1);
  }

  // Load config
  await configLoader.load();
  const devopsConfig = configLoader.getConfig();
  const monitoredRepos = devopsConfig?.repositoryInventory?.spec?.repositories || [];
  const repoFilter = monitoredRepos.length > 0 
    ? monitoredRepos.map((r: any) => r.name).join(',')
    : undefined;

  console.log(`✅ Authenticated successfully`);
  if (repoFilter) {
    console.log(`📦 Monitoring ${monitoredRepos.length} repositories`);
  }
  console.log('');

  // Create timestamped folder
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const reportFolder = join(output, `devops-report-${timestamp}`);
  
  if (!existsSync(reportFolder)) {
    mkdirSync(reportFolder, { recursive: true });
  }

  const generatedReports: string[] = [];
  const reportDate = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const generateAll = reports.includes('all');

  // Generate DORA Metrics Report
  if (generateAll || reports.includes('dora')) {
    console.log('📊 Generating DORA metrics report...');
    try {
      const doraData = await githubClient.getEnhancedDoraMetrics(org, timeframe, repoFilter?.split(','));
      const formatted = metricsCalculator.formatEnhancedDoraMetrics(doraData);
      
      let content = `# 🏆 DORA Metrics Dashboard\n\n`;
      content += `**Organization:** ${org}  \n`;
      content += `**Period:** ${timeframe === '7d' ? '7 days' : timeframe === '30d' ? '30 days' : '90 days'}  \n`;
      content += `**Generated:** ${reportDate}  \n`;
      content += `**Overall Rating:** ${formatted.overallRating || 'HIGH PERFORMER'}\n\n`;
      content += `---\n\n`;
      content += formatted.details || formatted.summary || '';
      
      writeFileSync(join(reportFolder, 'dora-metrics.md'), content);
      generatedReports.push('dora-metrics.md');
      console.log('  ✅ dora-metrics.md');
    } catch (err: any) {
      console.error(`  ❌ Failed: ${err.message}`);
    }
  }

  // Generate CI/CD Pipeline Health Report
  if (generateAll || reports.includes('cicd')) {
    console.log('🔄 Generating CI/CD pipeline health report...');
    try {
      const perfData = await githubClient.getDetailedPerformanceMetrics(org, timeframe, repoFilter?.split(','));
      const usageData = await githubClient.getDetailedUsageMetrics(org, timeframe, repoFilter?.split(','));
      const perfFormatted = metricsCalculator.formatDetailedPerformanceMetrics(perfData);
      const usageFormatted = metricsCalculator.formatDetailedUsageMetrics(usageData);

      let content = `# 🔄 CI/CD Pipeline Health Report\n\n`;
      content += `**Organization:** ${org}  \n`;
      content += `**Period:** ${timeframe === '7d' ? '7 days' : timeframe === '30d' ? '30 days' : '90 days'}  \n`;
      content += `**Generated:** ${reportDate}\n\n`;
      content += `---\n\n`;
      
      if (monitoredRepos.length > 0) {
        content += `## Monitored Repositories\n\n`;
        content += `| Repository | Tier | Compliance |\n`;
        content += `|------------|------|------------|\n`;
        for (const repo of monitoredRepos) {
          content += `| ${repo.name} | ${repo.tier || 'N/A'} | ${repo.compliance?.join(', ') || 'N/A'} |\n`;
        }
        content += `\n`;
      }
      
      content += `## Performance Summary\n\n`;
      content += perfFormatted.summary || '';
      content += `\n\n## Usage Summary\n\n`;
      content += usageFormatted.summary || '';
      
      writeFileSync(join(reportFolder, 'cicd-pipeline-health.md'), content);
      generatedReports.push('cicd-pipeline-health.md');
      console.log('  ✅ cicd-pipeline-health.md');
    } catch (err: any) {
      console.error(`  ❌ Failed: ${err.message}`);
    }
  }

  // Generate Cost Optimization Report
  if (generateAll || reports.includes('cost')) {
    console.log('💰 Generating cost optimization report...');
    try {
      const usageData = await githubClient.getComprehensiveUsageData(org);
      const costReport = await metricsCalculator.generateCostOptimizationReport(usageData, 20);

      let content = `# 💰 Cost Optimization Report\n\n`;
      content += `**Organization:** ${org}  \n`;
      content += `**Generated:** ${reportDate}\n\n`;
      content += `---\n\n`;
      content += `## Executive Summary\n\n`;
      content += costReport.executive_summary || '';
      content += `\n\n## Recommendations\n\n`;
      content += costReport.recommendations || '';
      content += `\n\n## Savings Breakdown\n\n`;
      content += costReport.savings_breakdown || '';
      
      writeFileSync(join(reportFolder, 'cost-optimization.md'), content);
      generatedReports.push('cost-optimization.md');
      console.log('  ✅ cost-optimization.md');
    } catch (err: any) {
      console.error(`  ❌ Failed: ${err.message}`);
    }
  }

  // Generate Compliance Report
  if (generateAll || reports.includes('compliance')) {
    console.log('🔒 Generating compliance report...');
    try {
      const complianceData = await githubClient.getComplianceAuditData(org, false);
      const formatted = await metricsCalculator.generateComplianceReport(complianceData);

      let content = `# 🔒 Compliance & Security Report\n\n`;
      content += `**Organization:** ${org}  \n`;
      content += `**Generated:** ${reportDate}\n\n`;
      content += `---\n\n`;
      content += formatted.summary || '';
      
      writeFileSync(join(reportFolder, 'compliance-security.md'), content);
      generatedReports.push('compliance-security.md');
      console.log('  ✅ compliance-security.md');
    } catch (err: any) {
      console.error(`  ❌ Failed: ${err.message}`);
    }
  }

  // Generate README index
  let readme = `# 📊 DevOps Reports\n\n`;
  readme += `**Organization:** ${org}  \n`;
  readme += `**Generated:** ${reportDate}  \n`;
  readme += `**Timeframe:** ${timeframe === '7d' ? '7 days' : timeframe === '30d' ? '30 days' : '90 days'}\n\n`;
  readme += `---\n\n`;
  readme += `## Reports\n\n`;
  readme += `| Report | Description |\n`;
  readme += `|--------|-------------|\n`;
  
  if (generatedReports.includes('dora-metrics.md')) {
    readme += `| [DORA Metrics](dora-metrics.md) | Deployment frequency, lead time, change failure rate, MTTR |\n`;
  }
  if (generatedReports.includes('cicd-pipeline-health.md')) {
    readme += `| [CI/CD Pipeline Health](cicd-pipeline-health.md) | Workflow performance, failure analysis, runner utilization |\n`;
  }
  if (generatedReports.includes('cost-optimization.md')) {
    readme += `| [Cost Optimization](cost-optimization.md) | Usage analysis, optimization recommendations |\n`;
  }
  if (generatedReports.includes('compliance-security.md')) {
    readme += `| [Compliance & Security](compliance-security.md) | Security scanning, environment protection |\n`;
  }
  
  readme += `\n## Viewing Diagrams\n\n`;
  readme += `These reports contain [Mermaid](https://mermaid.js.org/) diagrams.\n\n`;
  readme += `- **GitHub**: View directly in the repository\n`;
  readme += `- **VS Code**: Install [Markdown Preview Mermaid Support](https://marketplace.visualstudio.com/items?itemName=bierner.markdown-mermaid)\n`;
  readme += `- **Online**: Use [Mermaid Live Editor](https://mermaid.live/)\n`;
  
  writeFileSync(join(reportFolder, 'README.md'), readme);

  console.log('');
  console.log(`✅ Generated ${generatedReports.length + 1} reports in: ${reportFolder}`);
  console.log('');
  console.log('Reports created:');
  generatedReports.forEach(r => console.log(`  📄 ${r}`));
  console.log('  📄 README.md');
}

main().catch((error) => {
  console.error('❌ Error:', error.message);
  process.exit(1);
});
