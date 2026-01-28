/**
 * AI Advisor Module - GitHub Copilot-powered insights with static guardrails
 * 
 * This module provides AI-generated DevOps insights using GitHub Models API
 * (powered by GitHub Copilot infrastructure) with carefully crafted prompts 
 * and guardrails defined in static code.
 * 
 * Uses the existing GITHUB_TOKEN - no additional configuration required!
 * 
 * GitHub Models API: https://github.com/marketplace/models
 * - Provides access to GPT-4o and other models
 * - Uses GitHub token for authentication
 * - Rate limits based on your GitHub plan
 */

export interface RunnerData {
  type: string;
  runs: number;
  totalMinutes: number;
  estimatedCost: number;
}

export interface WorkflowData {
  name: string;
  repo: string;
  avgDuration: number;
  failureRate: number;
  runs: number;
}

export interface CostInsightContext {
  organization: string;
  timeframe: string;
  totalEstimatedCost: number;
  runnerBreakdown: RunnerData[];
  slowWorkflows: WorkflowData[];
  highFailureWorkflows: WorkflowData[];
  hasMacOSRunners: boolean;
  hasLargeRunners: boolean;
  hasX64Linux: boolean;
  totalWorkflowRuns: number;
}

export interface DORAInsightContext {
  organization: string;
  timeframe: string;
  deploymentFrequency: { value: number; unit: string; rating: string };
  leadTime: { value: number; unit: string; rating: string };
  changeFailureRate: { value: number; rating: string };
  mttr: { value: number; unit: string; rating: string };
  overallRating: string;
}

export interface AIInsightResult {
  success: boolean;
  insights: string;
  provider: string;
  model: string;
  cached: boolean;
  error?: string;
}

// ============================================
// Prompt Templates (The "Guardrails")
// ============================================

const SYSTEM_PROMPT = `You are a GitHub Actions and DevOps expert powered by GitHub Copilot. 
You analyze CI/CD metrics and provide specific, actionable recommendations that can be immediately implemented.

Your recommendations should:
- Be SPECIFIC and reference actual data provided
- Include CONCRETE code examples (YAML snippets, commands)
- Prioritize by impact (time savings, cost savings, reliability improvement)
- Use real numbers and percentages from the data
- Reference official GitHub documentation links
- Be formatted with markdown for readability
- Include emoji for visual clarity

Your response structure should include:
1. **Executive Summary** - 2-3 sentence overview of the situation
2. **Priority Actions** - Numbered list of specific actions with code examples
3. **Expected Impact** - Quantified benefits of implementing recommendations
4. **Implementation Guide** - Step-by-step instructions

Do NOT:
- Make up statistics not supported by the data
- Recommend tools or services not mentioned
- Provide generic advice that doesn't reference the specific data
- Be overly verbose - respect the reader's time
- Skip providing code examples when applicable`;

const COST_OPTIMIZATION_PROMPT = `Analyze this GitHub Actions usage data and provide specific, actionable cost optimization recommendations with code examples.

## Organization Data
- Organization: {{organization}}
- Timeframe: {{timeframe}}
- Total Estimated Cost: {{totalEstimatedCostFormatted}}
- Total Workflow Runs: {{totalWorkflowRuns}}

## Runner Usage Breakdown
{{runnerBreakdown}}

## Slow Workflows (>10 min average)
{{slowWorkflows}}

## High Failure Rate Workflows (>20%)
{{highFailureWorkflows}}

## Current State
- Uses macOS runners: {{hasMacOSRunners}}
- Uses larger runners (4+ cores): {{hasLargeRunners}}
- Uses x64 Linux runners: {{hasX64Linux}}

Provide recommendations in this format:

### 🎯 Executive Summary
[2-3 sentences summarizing the current cost situation and biggest opportunities]

### 💰 Priority 1: [Biggest Savings Opportunity]
**Estimated Savings:** $X/month (Y%)
**Effort:** [Low/Medium/High]

**Current State:**
[Describe what's happening now]

**Recommended Action:**
[Specific action with code example]

\`\`\`yaml
# Example workflow optimization
[YAML code example]
\`\`\`

### ⚡ Priority 2-3: Quick Wins
[List 2-3 additional optimizations with code snippets]

### 📊 Expected Impact
| Optimization | Monthly Savings | Implementation Time |
|--------------|-----------------|---------------------|
| [Item] | $X | [Time] |

### 📚 Resources
- [Link to relevant GitHub docs]

Keep response under 700 words but include all code examples.`;

const DORA_INSIGHTS_PROMPT = `Analyze these DORA metrics and provide specific, actionable improvement recommendations with implementation examples.

## Organization: {{organization}}
## Timeframe: {{timeframe}}

## Current DORA Metrics
- **Deployment Frequency**: {{deploymentFrequency.value}} {{deploymentFrequency.unit}} ({{deploymentFrequency.rating}})
- **Lead Time for Changes**: {{leadTime.value}} {{leadTime.unit}} ({{leadTime.rating}})
- **Change Failure Rate**: {{changeFailureRate.value}}% ({{changeFailureRate.rating}})
- **Mean Time to Recovery**: {{mttr.value}} {{mttr.unit}} ({{mttr.rating}})
- **Overall Rating**: {{overallRating}}

Provide recommendations in this format:

### 🎯 Executive Summary
[2-3 sentences about the team's DORA performance and key focus areas]

### 🔴 Biggest Gap: [Weakest Metric]
**Current:** [Value] ([Rating])
**Target:** [Elite benchmark]

**Root Cause Analysis:**
[Why this metric may be underperforming]

**Action Plan:**
1. [Specific action with code/config example]
2. [Second action]
3. [Third action]

\`\`\`yaml
# Example GitHub Actions workflow for improvement
[YAML code example]
\`\`\`

### 🟢 Strengths to Maintain
[What's working well and why]

### 📈 30-Day Improvement Roadmap
| Week | Focus Area | Action | Expected Result |
|------|------------|--------|-----------------|
| 1 | [Area] | [Action] | [Result] |
| 2-3 | [Area] | [Action] | [Result] |
| 4 | [Area] | [Action] | [Result] |

### 📊 Industry Benchmarks
| Metric | Your Value | Elite Target | Gap |
|--------|------------|--------------|-----|
| Deployment Frequency | {{deploymentFrequency.value}} {{deploymentFrequency.unit}} | Multiple/day | [Gap] |
| Lead Time | {{leadTime.value}} {{leadTime.unit}} | < 1 hour | [Gap] |
| Change Failure Rate | {{changeFailureRate.value}}% | < 5% | [Gap] |
| MTTR | {{mttr.value}} {{mttr.unit}} | < 1 hour | [Gap] |

Keep response under 600 words but include all examples.`;

const CICD_INSIGHTS_PROMPT = `Analyze this CI/CD pipeline data and provide specific optimization recommendations.

## Organization: {{organization}}
## Timeframe: {{timeframe}}

## Pipeline Performance
- **Total Workflow Runs:** {{totalRuns}}
- **Success Rate:** {{successRate}}%
- **Avg Duration:** {{avgDuration}}
- **Failed Runs:** {{failedRuns}}

## Top Slow Workflows
{{slowWorkflows}}

## Top Failing Workflows
{{failingWorkflows}}

## Runner Utilization
{{runnerUtilization}}

Provide actionable recommendations:

### 🎯 CI/CD Health Summary
[Quick assessment of pipeline health]

### ⚡ Performance Optimizations
For each slow workflow, provide:
1. Root cause analysis
2. Specific fix with YAML example
3. Expected time savings

### 🛠️ Reliability Improvements
For failing workflows:
1. Common failure patterns to investigate
2. Retry strategies with code examples
3. Monitoring recommendations

### 📋 Implementation Checklist
- [ ] [Specific action item 1]
- [ ] [Specific action item 2]
- [ ] [Specific action item 3]

Keep response under 500 words.`;

const SECURITY_INSIGHTS_PROMPT = `Analyze this security and compliance data and provide specific remediation recommendations.

## Organization: {{organization}}

## Security Findings
- **Secret Scanning Alerts:** {{secretAlerts}}
- **Code Scanning Alerts:** {{codeAlerts}}
- **Dependabot Alerts:** {{dependabotAlerts}}

## Compliance Status
- **Branch Protection Coverage:** {{branchProtection}}%
- **Required Reviews Enabled:** {{requiredReviews}}%
- **CODEOWNERS Coverage:** {{codeowners}}%

## High Priority Issues
{{highPriorityIssues}}

Provide actionable security recommendations:

### 🔒 Security Posture Summary
[Quick assessment with risk level]

### 🚨 Critical Actions (This Week)
1. [Action with specific remediation steps]
2. [Action with code/config example]

### 🛡️ Compliance Improvements
\`\`\`yaml
# Example branch protection configuration
# Apply via GitHub API or UI
[Configuration example]
\`\`\`

### 📊 Security Scorecard
| Area | Current | Target | Priority |
|------|---------|--------|----------|
| [Area] | [Score] | [Target] | [Priority] |

Keep response under 400 words.`;

// ============================================
// LLM API Client - GitHub Copilot (via GitHub Models)
// ============================================

interface LLMConfig {
  provider: 'github-copilot' | 'none';
  apiKey?: string;
  model: string;
  enabled: boolean;
}

function getConfig(): LLMConfig {
  const githubToken = process.env.GITHUB_TOKEN;
  
  // GitHub Copilot via GitHub Models - uses existing GITHUB_TOKEN
  if (githubToken) {
    return {
      provider: 'github-copilot',
      apiKey: githubToken,
      model: process.env.AI_MODEL || 'gpt-4o',
      enabled: true,
    };
  }
  
  return { provider: 'none', model: 'none', enabled: false };
}

/**
 * Call GitHub Models API (GitHub Copilot infrastructure)
 * Uses the existing GITHUB_TOKEN for authentication
 * Endpoint: https://models.inference.ai.azure.com
 */
async function callGitHubCopilot(prompt: string, systemPrompt: string, config: LLMConfig): Promise<string> {
  const response = await fetch('https://models.inference.ai.azure.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ],
      max_tokens: 1000,
      temperature: 0.7,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`GitHub Copilot API error: ${response.status} - ${error}`);
  }

  const data = await response.json() as any;
  return data.choices[0]?.message?.content || '';
}

// ============================================
// Template Rendering
// ============================================

function renderTemplate(template: string, context: Record<string, any>): string {
  let result = template;
  
  for (const [key, value] of Object.entries(context)) {
    const placeholder = `{{${key}}}`;
    
    if (typeof value === 'object' && value !== null) {
      // Handle nested objects like {{deploymentFrequency.value}}
      for (const [subKey, subValue] of Object.entries(value)) {
        const subPlaceholder = `{{${key}.${subKey}}}`;
        result = result.replace(new RegExp(subPlaceholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), String(subValue));
      }
      
      // Handle array rendering
      if (Array.isArray(value)) {
        const formattedList = value.length > 0 
          ? value.map((item: any) => {
              if (typeof item === 'object') {
                return `- ${item.name || item.type}: ${JSON.stringify(item)}`;
              }
              return `- ${item}`;
            }).join('\n')
          : 'None';
        result = result.replace(new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), formattedList);
      }
    } else {
      result = result.replace(new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), String(value));
    }
  }
  
  return result;
}

function formatRunnerBreakdown(runners: RunnerData[]): string {
  if (runners.length === 0) return 'No runner data available';
  
  return runners.map(r => 
    `- **${r.type}**: ${r.runs} runs, ${r.totalMinutes.toFixed(0)} min, ~$${r.estimatedCost.toFixed(2)}`
  ).join('\n');
}

function formatWorkflowList(workflows: WorkflowData[]): string {
  if (workflows.length === 0) return 'None identified';
  
  return workflows.slice(0, 5).map(w => 
    `- **${w.name}** (${w.repo}): ${w.avgDuration.toFixed(1)} min avg, ${(w.failureRate * 100).toFixed(1)}% failure rate, ${w.runs} runs`
  ).join('\n');
}

// ============================================
// Fallback Static Insights (Enhanced with Code Examples)
// ============================================

function generateStaticCostInsights(context: CostInsightContext): string {
  const insights: string[] = [];
  
  insights.push(`### 🎯 Cost Optimization Insights\n`);
  insights.push(`> *Rule-based analysis powered by GitHub Copilot patterns*\n`);
  
  insights.push(`#### 📊 Executive Summary`);
  insights.push(`Your organization ran **${context.totalWorkflowRuns}** workflows costing approximately **$${context.totalEstimatedCost.toFixed(2)}** over ${context.timeframe}.`);
  
  let priorityNum = 1;
  
  // ARM opportunity
  if (context.hasX64Linux) {
    insights.push(`\n#### 💰 Priority ${priorityNum++}: Switch to ARM Runners (Save 25-33%)`);
    insights.push(`**Estimated Savings:** 25-33% of Linux runner costs`);
    insights.push(`**Effort:** Low`);
    insights.push(`\nARM runners provide similar performance at lower cost. Update your workflow:`);
    insights.push(`
\`\`\`yaml
# Before (x64 Linux)
jobs:
  build:
    runs-on: ubuntu-latest

# After (ARM - 33% cheaper)
jobs:
  build:
    runs-on: ubuntu-24.04-arm  # or linux-arm64-2core for larger runners
\`\`\`
`);
    insights.push(`📖 [GitHub ARM runners documentation](https://docs.github.com/en/actions/using-github-hosted-runners/using-github-hosted-runners/about-github-hosted-runners#standard-github-hosted-runners-for-public-repositories)`);
  }
  
  // macOS optimization
  if (context.hasMacOSRunners) {
    insights.push(`\n#### 🍎 Priority ${priorityNum++}: Optimize macOS Runner Usage (Save 80%+)`);
    insights.push(`**Estimated Savings:** Up to 80% by moving tests to Linux`);
    insights.push(`**Effort:** Medium`);
    insights.push(`\nmacOS runners cost 10x more than Linux. Run platform-agnostic tests on Linux:`);
    insights.push(`
\`\`\`yaml
jobs:
  # Run all tests on Linux first (cheap)
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm test
  
  # Only run macOS-specific tests on macOS
  test-macos-specific:
    runs-on: macos-latest
    needs: test  # Only run if Linux tests pass
    steps:
      - uses: actions/checkout@v4
      - run: npm run test:macos-only
\`\`\`
`);
  }
  
  // Slow workflows with caching
  if (context.slowWorkflows.length > 0) {
    insights.push(`\n#### ⏱️ Priority ${priorityNum++}: Speed Up ${context.slowWorkflows.length} Slow Workflow(s)`);
    insights.push(`**Estimated Savings:** 30-50% reduction in workflow duration`);
    insights.push(`**Effort:** Low-Medium`);
    insights.push(`\nImplement caching to reduce build times:`);
    insights.push(`
\`\`\`yaml
- name: Cache dependencies
  uses: actions/cache@v4
  with:
    path: |
      ~/.npm
      node_modules
    key: \${{ runner.os }}-node-\${{ hashFiles('**/package-lock.json') }}
    restore-keys: |
      \${{ runner.os }}-node-
      
- name: Cache build outputs
  uses: actions/cache@v4
  with:
    path: dist
    key: build-\${{ github.sha }}
\`\`\`
`);
    insights.push(`\n**Top slow workflows to optimize:**`);
    for (const wf of context.slowWorkflows.slice(0, 3)) {
      insights.push(`- **${wf.name}** (${wf.repo}): ${wf.avgDuration.toFixed(1)} min avg`);
    }
  }
  
  // Failing workflows
  if (context.highFailureWorkflows.length > 0) {
    insights.push(`\n#### 🔴 Priority ${priorityNum++}: Fix ${context.highFailureWorkflows.length} Failing Workflow(s)`);
    insights.push(`**Estimated Savings:** Reduce wasted compute by ${(context.highFailureWorkflows.reduce((sum, wf) => sum + wf.runs * wf.failureRate, 0) / context.totalWorkflowRuns * 100).toFixed(0)}%`);
    insights.push(`**Effort:** Medium-High`);
    insights.push(`\nAdd retry logic for flaky tests:`);
    insights.push(`
\`\`\`yaml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run tests with retry
        uses: nick-fields/retry@v3
        with:
          timeout_minutes: 10
          max_attempts: 3
          command: npm test
\`\`\`
`);
    insights.push(`\n**Workflows with high failure rates:**`);
    for (const wf of context.highFailureWorkflows.slice(0, 3)) {
      insights.push(`- **${wf.name}**: ${(wf.failureRate * 100).toFixed(0)}% failure rate (${wf.runs} runs)`);
    }
  }
  
  // Implementation checklist
  insights.push(`\n#### 📋 Implementation Checklist`);
  insights.push(`- [ ] Review and migrate eligible workflows to ARM runners`);
  insights.push(`- [ ] Add dependency caching to top slow workflows`);
  insights.push(`- [ ] Analyze and fix top failing workflows`);
  insights.push(`- [ ] Set up cost monitoring alerts`);
  
  insights.push(`\n---`);
  insights.push(`💡 *Enable GitHub Copilot-powered insights for personalized AI recommendations.*`);
  insights.push(`📖 *[GitHub Models documentation](https://docs.github.com/en/enterprise-cloud@latest/github-models/using-github-models/prototyping-with-ai-models)*`);
  
  return insights.join('\n');
}

function generateStaticDORAInsights(context: DORAInsightContext): string {
  const insights: string[] = [];
  
  insights.push(`### 🎯 DORA Metrics Analysis & Recommendations\n`);
  insights.push(`> *Rule-based analysis powered by GitHub Copilot patterns*\n`);
  
  // Executive summary
  insights.push(`#### 📊 Executive Summary`);
  insights.push(`Your team is performing at **${context.overallRating}** level overall. ${
    context.overallRating === 'Elite' ? 'Excellent work!' :
    context.overallRating === 'High' ? 'Strong performance with room for optimization.' :
    context.overallRating === 'Medium' ? 'Good foundation with clear improvement opportunities.' :
    'Significant opportunities exist to improve DevOps practices.'
  }\n`);
  
  // Find weakest and strongest metrics
  const ratings = ['Elite', 'High', 'Medium', 'Low', 'Insufficient Data'];
  const metrics = [
    { name: 'Deployment Frequency', rating: context.deploymentFrequency.rating, value: context.deploymentFrequency.value, unit: context.deploymentFrequency.unit },
    { name: 'Lead Time', rating: context.leadTime.rating, value: context.leadTime.value, unit: context.leadTime.unit },
    { name: 'Change Failure Rate', rating: context.changeFailureRate.rating, value: context.changeFailureRate.value, unit: '%' },
    { name: 'MTTR', rating: context.mttr.rating, value: context.mttr.value, unit: context.mttr.unit },
  ];
  
  const validMetrics = metrics.filter(m => m.rating !== 'Insufficient Data');
  const sortedMetrics = [...validMetrics].sort((a, b) => ratings.indexOf(b.rating) - ratings.indexOf(a.rating));
  const weakest = sortedMetrics[0];
  const strongest = sortedMetrics[sortedMetrics.length - 1];
  
  // Focus area with specific recommendations
  if (weakest && ratings.indexOf(weakest.rating) >= 2) {
    insights.push(`#### 🔴 Biggest Gap: ${weakest.name}`);
    insights.push(`**Current:** ${weakest.value} ${weakest.unit} (${weakest.rating})`);
    
    switch (weakest.name) {
      case 'Deployment Frequency':
        insights.push(`**Target:** Multiple deploys per day (Elite)`);
        insights.push(`\n**Action Plan:**`);
        insights.push(`
\`\`\`yaml
# Implement continuous deployment
name: Deploy on Push
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run tests
        run: npm test
      - name: Deploy to production
        if: success()
        run: |
          # Deploy with feature flags for safety
          ./deploy.sh --environment production --feature-flag true
\`\`\`
`);
        insights.push(`**Quick wins:**`);
        insights.push(`1. Enable auto-deploy for main branch`);
        insights.push(`2. Implement feature flags for safe rollouts`);
        insights.push(`3. Break large releases into smaller increments`);
        break;
        
      case 'Lead Time':
        insights.push(`**Target:** Less than 1 hour (Elite)`);
        insights.push(`\n**Action Plan:**`);
        insights.push(`
\`\`\`yaml
# Speed up PR workflow
name: Fast PR Checks
on: pull_request

jobs:
  quick-checks:
    runs-on: ubuntu-latest
    timeout-minutes: 10  # Fail fast
    steps:
      - uses: actions/checkout@v4
      - name: Lint & Type Check (parallel)
        run: npm run lint & npm run typecheck & wait
      - name: Unit Tests
        run: npm test -- --coverage --changedSince=origin/main
\`\`\`
`);
        insights.push(`**Quick wins:**`);
        insights.push(`1. Set PR size limits (< 400 lines)`);
        insights.push(`2. Enable auto-assign for reviewers`);
        insights.push(`3. Parallelize CI jobs`);
        break;
        
      case 'Change Failure Rate':
        insights.push(`**Target:** Less than 5% (Elite)`);
        insights.push(`\n**Action Plan:**`);
        insights.push(`
\`\`\`yaml
# Implement staged rollouts
name: Canary Deployment
on:
  push:
    branches: [main]

jobs:
  deploy-canary:
    runs-on: ubuntu-latest
    steps:
      - name: Deploy to 5% of traffic
        run: ./deploy.sh --canary 5
      - name: Wait and monitor
        run: sleep 300 && ./check-metrics.sh
      - name: Roll out to 100% or rollback
        run: ./deploy.sh --promote-or-rollback
\`\`\`
`);
        insights.push(`**Quick wins:**`);
        insights.push(`1. Add integration tests before deploy`);
        insights.push(`2. Implement canary deployments`);
        insights.push(`3. Add post-deploy health checks`);
        break;
        
      case 'MTTR':
        insights.push(`**Target:** Less than 1 hour (Elite)`);
        insights.push(`\n**Action Plan:**`);
        insights.push(`
\`\`\`yaml
# Automated rollback on failure
name: Auto-Rollback
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
          payload: |
            {"text": "🔄 Rollback executed: \${{ inputs.reason }}"}
\`\`\`
`);
        insights.push(`**Quick wins:**`);
        insights.push(`1. Implement one-click rollback`);
        insights.push(`2. Add monitoring alerts`);
        insights.push(`3. Document incident runbooks`);
        break;
    }
    insights.push('');
  }
  
  // Strengths
  if (strongest && ratings.indexOf(strongest.rating) <= 1) {
    insights.push(`#### 🟢 Strength: ${strongest.name}`);
    insights.push(`Currently at **${strongest.rating}** level. Keep up the great work!\n`);
  }
  
  // Industry benchmarks
  insights.push(`#### 📊 Industry Benchmarks`);
  insights.push(`| Metric | Your Value | Elite Target | Status |`);
  insights.push(`|--------|------------|--------------|--------|`);
  insights.push(`| Deployment Frequency | ${context.deploymentFrequency.value} ${context.deploymentFrequency.unit} | Multiple/day | ${context.deploymentFrequency.rating === 'Elite' ? '✅' : '🎯'} |`);
  insights.push(`| Lead Time | ${context.leadTime.value} ${context.leadTime.unit} | < 1 hour | ${context.leadTime.rating === 'Elite' ? '✅' : '🎯'} |`);
  insights.push(`| Change Failure Rate | ${context.changeFailureRate.value}% | < 5% | ${context.changeFailureRate.rating === 'Elite' ? '✅' : '🎯'} |`);
  insights.push(`| MTTR | ${context.mttr.value} ${context.mttr.unit} | < 1 hour | ${context.mttr.rating === 'Elite' ? '✅' : '🎯'} |`);
  
  insights.push(`\n---`);
  insights.push(`💡 *Enable GitHub Copilot-powered insights for AI-generated improvement plans.*`);
  
  return insights.join('\n');
}

// ============================================
// Public API
// ============================================

/**
 * Check if AI advisor is configured and available
 */
export function isAIAdvisorEnabled(): boolean {
  const config = getConfig();
  return config.enabled;
}

/**
 * Get the current AI provider configuration
 */
export function getAIProviderInfo(): { provider: string; model: string; enabled: boolean } {
  const config = getConfig();
  return {
    provider: config.provider === 'github-copilot' ? 'GitHub Copilot' : config.provider,
    model: config.model,
    enabled: config.enabled,
  };
}

/**
 * Generate cost optimization insights using GitHub Copilot or fallback to static
 */
export async function generateCostInsights(context: CostInsightContext): Promise<AIInsightResult> {
  const config = getConfig();
  
  // Check if AI is configured
  if (!config.enabled) {
    return {
      success: true,
      insights: generateStaticCostInsights(context),
      provider: 'static',
      model: 'none',
      cached: false,
    };
  }
  
  try {
    // Prepare the prompt with context
    const promptContext = {
      ...context,
      runnerBreakdown: formatRunnerBreakdown(context.runnerBreakdown),
      slowWorkflows: formatWorkflowList(context.slowWorkflows),
      highFailureWorkflows: formatWorkflowList(context.highFailureWorkflows),
      totalEstimatedCostFormatted: '$' + context.totalEstimatedCost.toFixed(2),
    };
    
    const prompt = renderTemplate(COST_OPTIMIZATION_PROMPT, promptContext);
    
    // Call GitHub Copilot
    const insights = await callGitHubCopilot(prompt, SYSTEM_PROMPT, config);
    
    return {
      success: true,
      insights: `### 🤖 AI-Generated Cost Optimization Insights\n> Powered by GitHub Copilot 🚀\n\n${insights}`,
      provider: 'GitHub Copilot',
      model: config.model,
      cached: false,
    };
  } catch (error) {
    console.error('AI Advisor error:', error);
    return {
      success: false,
      insights: generateStaticCostInsights(context),
      provider: 'static (fallback)',
      model: 'none',
      cached: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Generate DORA metrics insights using GitHub Copilot or fallback to static
 */
export async function generateDORAInsights(context: DORAInsightContext): Promise<AIInsightResult> {
  const config = getConfig();
  
  // Check if AI is configured
  if (!config.enabled) {
    return {
      success: true,
      insights: generateStaticDORAInsights(context),
      provider: 'static',
      model: 'none',
      cached: false,
    };
  }
  
  try {
    const prompt = renderTemplate(DORA_INSIGHTS_PROMPT, context);
    
    // Call GitHub Copilot
    const insights = await callGitHubCopilot(prompt, SYSTEM_PROMPT, config);
    
    return {
      success: true,
      insights: `### 🤖 AI-Generated DORA Analysis\n> Powered by GitHub Copilot 🚀\n\n${insights}`,
      provider: 'GitHub Copilot',
      model: config.model,
      cached: false,
    };
  } catch (error) {
    console.error('AI Advisor error:', error);
    return {
      success: false,
      insights: generateStaticDORAInsights(context),
      provider: 'static (fallback)',
      model: 'none',
      cached: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ============================================
// CI/CD Insights
// ============================================

export interface CICDInsightContext {
  organization: string;
  timeframe: string;
  totalRuns: number;
  successRate: number;
  avgDuration: string;
  failedRuns: number;
  slowWorkflows: WorkflowData[];
  failingWorkflows: WorkflowData[];
  runnerUtilization: string;
}

function generateStaticCICDInsights(context: CICDInsightContext): string {
  const insights: string[] = [];
  
  insights.push(`### 🔄 CI/CD Pipeline Insights\n`);
  insights.push(`> *Rule-based analysis powered by GitHub Copilot patterns*\n`);
  
  // Health assessment
  const healthStatus = context.successRate >= 95 ? '🟢 Healthy' :
    context.successRate >= 80 ? '🟡 Needs Attention' : '🔴 Critical';
  
  insights.push(`#### 📊 Pipeline Health: ${healthStatus}`);
  insights.push(`- **Total Runs:** ${context.totalRuns}`);
  insights.push(`- **Success Rate:** ${context.successRate}%`);
  insights.push(`- **Average Duration:** ${context.avgDuration}`);
  insights.push(`- **Failed Runs:** ${context.failedRuns}\n`);
  
  // Performance optimizations
  if (context.slowWorkflows.length > 0) {
    insights.push(`#### ⚡ Performance Optimizations\n`);
    insights.push(`**${context.slowWorkflows.length} slow workflow(s) identified:**\n`);
    
    for (const wf of context.slowWorkflows.slice(0, 3)) {
      insights.push(`**${wf.name}** (${wf.repo})`);
      insights.push(`- Current: ${wf.avgDuration.toFixed(1)} min average`);
      insights.push(`- Runs: ${wf.runs}`);
      insights.push(`- Recommended optimizations:`);
      
      if (wf.avgDuration > 15) {
        insights.push(`  1. Split into parallel jobs`);
        insights.push(`  2. Implement aggressive caching`);
        insights.push(`  3. Consider self-hosted runners for heavy builds`);
      } else {
        insights.push(`  1. Add dependency caching`);
        insights.push(`  2. Use shallow clone (\`fetch-depth: 1\`)`);
      }
      insights.push('');
    }
    
    insights.push(`
\`\`\`yaml
# Optimization example: Parallel testing
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        shard: [1, 2, 3, 4]  # Split tests into 4 shards
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 1  # Shallow clone
      - uses: actions/cache@v4
        with:
          path: node_modules
          key: deps-\${{ hashFiles('package-lock.json') }}
      - run: npm test -- --shard=\${{ matrix.shard }}/4
\`\`\`
`);
  }
  
  // Reliability improvements
  if (context.failingWorkflows.length > 0) {
    insights.push(`#### 🛠️ Reliability Improvements\n`);
    insights.push(`**${context.failingWorkflows.length} workflow(s) with high failure rates:**\n`);
    
    for (const wf of context.failingWorkflows.slice(0, 3)) {
      insights.push(`- **${wf.name}**: ${(wf.failureRate * 100).toFixed(0)}% failure rate`);
    }
    
    insights.push(`\n**Common failure patterns to investigate:**`);
    insights.push(`1. Flaky tests - add retry logic`);
    insights.push(`2. Resource exhaustion - increase runner size or parallelize`);
    insights.push(`3. External dependencies - add timeouts and mocks`);
    insights.push(`4. Race conditions - review test isolation\n`);
    
    insights.push(`
\`\`\`yaml
# Add resilience to workflows
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - name: Build with retry
        uses: nick-fields/retry@v3
        with:
          timeout_minutes: 10
          max_attempts: 3
          retry_on: error
          command: npm run build
      - name: Test with retry
        uses: nick-fields/retry@v3
        with:
          timeout_minutes: 15
          max_attempts: 2
          command: npm test
\`\`\`
`);
  }
  
  // Implementation checklist
  insights.push(`#### 📋 Action Items`);
  insights.push(`- [ ] Add caching to top 3 slowest workflows`);
  insights.push(`- [ ] Implement retry logic for flaky tests`);
  insights.push(`- [ ] Set up workflow duration monitoring`);
  insights.push(`- [ ] Review and fix top failing workflows`);
  
  return insights.join('\n');
}

/**
 * Generate CI/CD insights using GitHub Copilot or fallback to static
 */
export async function generateCICDInsights(context: CICDInsightContext): Promise<AIInsightResult> {
  const config = getConfig();
  
  if (!config.enabled) {
    return {
      success: true,
      insights: generateStaticCICDInsights(context),
      provider: 'static',
      model: 'none',
      cached: false,
    };
  }
  
  try {
    const promptContext = {
      ...context,
      slowWorkflows: formatWorkflowList(context.slowWorkflows),
      failingWorkflows: formatWorkflowList(context.failingWorkflows),
    };
    
    const prompt = renderTemplate(CICD_INSIGHTS_PROMPT, promptContext);
    const insights = await callGitHubCopilot(prompt, SYSTEM_PROMPT, config);
    
    return {
      success: true,
      insights: `### 🤖 AI-Generated CI/CD Insights\n> Powered by GitHub Copilot 🚀\n\n${insights}`,
      provider: 'GitHub Copilot',
      model: config.model,
      cached: false,
    };
  } catch (error) {
    console.error('AI Advisor error:', error);
    return {
      success: false,
      insights: generateStaticCICDInsights(context),
      provider: 'static (fallback)',
      model: 'none',
      cached: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ============================================
// Security Insights
// ============================================

export interface SecurityInsightContext {
  organization: string;
  secretAlerts: number;
  codeAlerts: number;
  dependabotAlerts: number;
  branchProtection: number;
  requiredReviews: number;
  codeowners: number;
  highPriorityIssues: string[];
}

function generateStaticSecurityInsights(context: SecurityInsightContext): string {
  const insights: string[] = [];
  
  insights.push(`### 🔒 Security & Compliance Insights\n`);
  insights.push(`> *Rule-based analysis powered by GitHub Copilot patterns*\n`);
  
  // Risk assessment
  const totalAlerts = context.secretAlerts + context.codeAlerts + context.dependabotAlerts;
  const riskLevel = totalAlerts === 0 ? '🟢 Low Risk' :
    totalAlerts <= 10 ? '🟡 Medium Risk' : '🔴 High Risk';
  
  insights.push(`#### 🎯 Security Posture: ${riskLevel}\n`);
  
  // Alert summary
  insights.push(`| Alert Type | Count | Priority |`);
  insights.push(`|------------|-------|----------|`);
  insights.push(`| 🔐 Secret Scanning | ${context.secretAlerts} | ${context.secretAlerts > 0 ? '🔴 Critical' : '✅ Clear'} |`);
  insights.push(`| 🛡️ Code Scanning | ${context.codeAlerts} | ${context.codeAlerts > 5 ? '🟡 High' : '✅ OK'} |`);
  insights.push(`| 📦 Dependabot | ${context.dependabotAlerts} | ${context.dependabotAlerts > 20 ? '🟡 Medium' : '✅ OK'} |`);
  insights.push('');
  
  // Critical actions
  if (context.secretAlerts > 0) {
    insights.push(`#### 🚨 Critical: ${context.secretAlerts} Exposed Secret(s)\n`);
    insights.push(`**Immediate actions required:**`);
    insights.push(`1. Revoke and rotate all exposed credentials`);
    insights.push(`2. Review git history for secret exposure`);
    insights.push(`3. Enable push protection to prevent future leaks\n`);
    insights.push(`
\`\`\`yaml
# Prevent secrets in commits with pre-commit hook
# .github/workflows/secret-scan.yml
name: Secret Scanning
on: [push, pull_request]

jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Scan for secrets
        uses: trufflesecurity/trufflehog@main
        with:
          extra_args: --only-verified
\`\`\`
`);
  }
  
  // Compliance status
  insights.push(`#### 🛡️ Compliance Status\n`);
  insights.push(`| Control | Coverage | Status |`);
  insights.push(`|---------|----------|--------|`);
  insights.push(`| Branch Protection | ${context.branchProtection}% | ${context.branchProtection >= 80 ? '✅' : '⚠️'} |`);
  insights.push(`| Required Reviews | ${context.requiredReviews}% | ${context.requiredReviews >= 80 ? '✅' : '⚠️'} |`);
  insights.push(`| CODEOWNERS | ${context.codeowners}% | ${context.codeowners >= 50 ? '✅' : '⚠️'} |`);
  insights.push('');
  
  // Recommendations
  if (context.branchProtection < 80) {
    insights.push(`#### 📋 Enable Branch Protection\n`);
    insights.push(`
\`\`\`bash
# Enable branch protection via GitHub CLI
gh api -X PUT repos/{owner}/{repo}/branches/main/protection \\
  -f required_status_checks='{"strict":true,"contexts":["build","test"]}' \\
  -f enforce_admins=true \\
  -f required_pull_request_reviews='{"required_approving_review_count":1}' \\
  -f restrictions=null
\`\`\`
`);
  }
  
  if (context.codeowners < 50) {
    insights.push(`#### 📋 Add CODEOWNERS File\n`);
    insights.push(`
\`\`\`
# .github/CODEOWNERS
# Default owners for everything
* @org/platform-team

# Frontend code
/src/frontend/ @org/frontend-team

# Infrastructure
/infrastructure/ @org/devops-team
/.github/ @org/devops-team
\`\`\`
`);
  }
  
  // Action items
  insights.push(`#### ✅ Security Checklist`);
  insights.push(`- [ ] Resolve all secret scanning alerts`);
  insights.push(`- [ ] Enable Dependabot auto-merge for patches`);
  insights.push(`- [ ] Configure branch protection on all default branches`);
  insights.push(`- [ ] Add CODEOWNERS for critical paths`);
  insights.push(`- [ ] Schedule quarterly security reviews`);
  
  return insights.join('\n');
}

/**
 * Generate security insights using GitHub Copilot or fallback to static
 */
export async function generateSecurityInsights(context: SecurityInsightContext): Promise<AIInsightResult> {
  const config = getConfig();
  
  if (!config.enabled) {
    return {
      success: true,
      insights: generateStaticSecurityInsights(context),
      provider: 'static',
      model: 'none',
      cached: false,
    };
  }
  
  try {
    const promptContext = {
      ...context,
      highPriorityIssues: context.highPriorityIssues.join('\n'),
    };
    
    const prompt = renderTemplate(SECURITY_INSIGHTS_PROMPT, promptContext);
    const insights = await callGitHubCopilot(prompt, SYSTEM_PROMPT, config);
    
    return {
      success: true,
      insights: `### 🤖 AI-Generated Security Analysis\n> Powered by GitHub Copilot 🚀\n\n${insights}`,
      provider: 'GitHub Copilot',
      model: config.model,
      cached: false,
    };
  } catch (error) {
    console.error('AI Advisor error:', error);
    return {
      success: false,
      insights: generateStaticSecurityInsights(context),
      provider: 'static (fallback)',
      model: 'none',
      cached: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ============================================
// Workflow Source Analysis (reads actual YAML)
// ============================================

export interface WorkflowSourceContext {
  organization: string;
  repo: string;
  workflowName: string;
  workflowPath: string;
  content: string;
  staticAnalysis: {
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
      suggestion?: string;
    }>;
    optimizations: Array<{
      type: string;
      description: string;
      impact: 'high' | 'medium' | 'low';
      codeExample?: string;
    }>;
  };
}

const WORKFLOW_SOURCE_PROMPT = `You are analyzing a GitHub Actions workflow file. Provide specific, actionable improvements based on the actual YAML source code.

## Repository: {{organization}}/{{repo}}
## Workflow: {{workflowName}}
## Path: {{workflowPath}}

## Workflow Source Code
\`\`\`yaml
{{content}}
\`\`\`

## Static Analysis Results
### Triggers: {{triggersFormatted}}
### Jobs Found: {{jobsCount}}
{{jobsSummary}}

### Pre-Identified Issues
{{issuesSummary}}

### Suggested Optimizations
{{optimizationsSummary}}

---

Based on the ACTUAL WORKFLOW SOURCE CODE above, provide:

### 🔍 Source Code Review
Analyze the workflow YAML and identify:
1. Specific inefficiencies in the current implementation
2. Missing best practices that should be added
3. Potential security concerns in the configuration

### ✨ Recommended Changes
For each improvement, provide:
- **What to change** (reference specific lines/sections)
- **Why it matters** (impact on speed/cost/reliability)
- **Exact code** (show the improved YAML)

Example format:
\`\`\`yaml
# BEFORE (line X)
- uses: actions/checkout@v3

# AFTER
- uses: actions/checkout@v4
  with:
    fetch-depth: 0  # Needed for git history
\`\`\`

### ⚡ Quick Wins (< 5 min to implement)
List 2-3 changes that can be made immediately with minimal risk.

### 🎯 High-Impact Changes (requires testing)
List 1-2 larger changes that would significantly improve the workflow.

### 📊 Expected Impact
| Change | Time Savings | Cost Impact | Effort |
|--------|--------------|-------------|--------|
| [Change 1] | X min | -$Y/month | Low |
| [Change 2] | X min | -$Y/month | Medium |

Focus on SPECIFIC improvements based on what you see in the source code. Reference actual job names, step names, and configurations from the YAML.

Keep response under 800 words but include all code examples.`;

function generateStaticWorkflowInsights(context: WorkflowSourceContext): string {
  const insights: string[] = [];
  
  insights.push(`## 📋 Workflow Analysis: ${context.workflowName}`);
  insights.push(`**Repository:** ${context.organization}/${context.repo}`);
  insights.push(`**Path:** \`${context.workflowPath}\``);
  insights.push('');
  
  // Triggers
  insights.push(`### Triggers`);
  insights.push(context.staticAnalysis.triggers.length > 0 
    ? context.staticAnalysis.triggers.map(t => `- \`${t}\``).join('\n')
    : '- No triggers detected');
  insights.push('');
  
  // Jobs Summary
  insights.push(`### Jobs (${context.staticAnalysis.jobs.length})`);
  if (context.staticAnalysis.jobs.length > 0) {
    insights.push('| Job | Runner | Steps | Cache | Concurrency | Timeout |');
    insights.push('|-----|--------|-------|-------|-------------|---------|');
    for (const job of context.staticAnalysis.jobs) {
      insights.push(`| ${job.name} | ${job.runsOn} | ${job.steps} | ${job.hasCache ? '✅' : '❌'} | ${job.hasConcurrency ? '✅' : '❌'} | ${job.hasTimeout ? '✅' : '❌'} |`);
    }
  }
  insights.push('');
  
  // Issues
  if (context.staticAnalysis.issues.length > 0) {
    insights.push(`### 🚨 Issues Found (${context.staticAnalysis.issues.length})`);
    for (const issue of context.staticAnalysis.issues) {
      const icon = issue.severity === 'high' ? '🔴' : issue.severity === 'medium' ? '🟡' : '🟢';
      insights.push(`${icon} **[${issue.category.toUpperCase()}]** ${issue.message}`);
      if (issue.suggestion) {
        insights.push(`   → ${issue.suggestion}`);
      }
    }
    insights.push('');
  }
  
  // Optimizations
  if (context.staticAnalysis.optimizations.length > 0) {
    insights.push(`### ⚡ Optimization Opportunities`);
    for (const opt of context.staticAnalysis.optimizations) {
      const impact = opt.impact === 'high' ? '🔥 High Impact' : opt.impact === 'medium' ? '⚡ Medium Impact' : '💡 Low Impact';
      insights.push(`#### ${opt.type} (${impact})`);
      insights.push(opt.description);
      if (opt.codeExample) {
        insights.push('```yaml');
        insights.push(opt.codeExample);
        insights.push('```');
      }
      insights.push('');
    }
  }
  
  // Show actual source code snippet
  insights.push(`### 📄 Source Code Preview`);
  const sourceLines = context.content.split('\n').slice(0, 50);
  insights.push('```yaml');
  insights.push(sourceLines.join('\n'));
  if (context.content.split('\n').length > 50) {
    insights.push('# ... (truncated)');
  }
  insights.push('```');
  
  return insights.join('\n');
}

/**
 * Generate workflow source analysis using GitHub Copilot or fallback to static
 */
export async function generateWorkflowSourceInsights(context: WorkflowSourceContext): Promise<AIInsightResult> {
  const config = getConfig();
  
  // Prepare summary data for the prompt
  const triggersFormatted = context.staticAnalysis.triggers.join(', ') || 'none detected';
  const jobsCount = context.staticAnalysis.jobs.length;
  
  const jobsSummary = context.staticAnalysis.jobs.map(j => 
    `- **${j.name}**: runs-on \`${j.runsOn}\`, ${j.steps} steps, cache=${j.hasCache}, concurrency=${j.hasConcurrency}`
  ).join('\n') || 'No jobs detected';
  
  const issuesSummary = context.staticAnalysis.issues.map(i =>
    `- [${i.severity.toUpperCase()}] ${i.message}${i.suggestion ? ` → ${i.suggestion}` : ''}`
  ).join('\n') || 'No issues detected by static analysis';
  
  const optimizationsSummary = context.staticAnalysis.optimizations.map(o =>
    `- **${o.type}** (${o.impact} impact): ${o.description}`
  ).join('\n') || 'No optimizations suggested by static analysis';
  
  if (!config.enabled) {
    return {
      success: true,
      insights: generateStaticWorkflowInsights(context),
      provider: 'static',
      model: 'none',
      cached: false,
    };
  }
  
  try {
    const promptContext = {
      ...context,
      triggersFormatted,
      jobsCount,
      jobsSummary,
      issuesSummary,
      optimizationsSummary,
      // Truncate content if too long (keep first 300 lines max for token limits)
      content: context.content.split('\n').slice(0, 300).join('\n'),
    };
    
    const prompt = renderTemplate(WORKFLOW_SOURCE_PROMPT, promptContext);
    const insights = await callGitHubCopilot(prompt, SYSTEM_PROMPT, config);
    
    return {
      success: true,
      insights: `### 🤖 AI-Powered Workflow Analysis\n> Powered by GitHub Copilot 🚀 | Analyzed actual source code\n\n${insights}`,
      provider: 'GitHub Copilot',
      model: config.model,
      cached: false,
    };
  } catch (error) {
    console.error('AI Advisor error:', error);
    return {
      success: false,
      insights: generateStaticWorkflowInsights(context),
      provider: 'static (fallback)',
      model: 'none',
      cached: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
