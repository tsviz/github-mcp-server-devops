# ActionsPulse Architecture

> **Central DevOps Configuration & Observability Platform**
> 
> A policy-aware MCP server that reads from a central devops-config-repo to provide consistent governance, metrics, and insights across CI/CD pipelines.

## 🎯 Vision

Transform the ActionsPulse from a simple metrics reader into a **central nervous system** for DevOps teams that:

1. **Reads policies** from a central `devops-config-repo`
2. **Validates workflows** against organization standards
3. **Provides insights** to DevOps, Developers, DBAs, and Infrastructure teams
4. **Enforces governance** through policy-as-code

## 🏗️ Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        ActionsPulse MCP Server                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────────┐   ┌──────────────────┐   ┌──────────────────┐        │
│  │  GitHub Client   │   │  Policy Engine   │   │  Config Loader   │        │
│  │  (org-client.ts) │   │  (policy.ts)     │   │  (config.ts)     │        │
│  └────────┬─────────┘   └────────┬─────────┘   └────────┬─────────┘        │
│           │                      │                      │                   │
│           ▼                      ▼                      ▼                   │
│  ┌──────────────────────────────────────────────────────────────────┐      │
│  │                        Tool Registry                              │      │
│  │  • Metrics Tools (existing)                                       │      │
│  │  • Policy Validation Tools (new)                                  │      │
│  │  • Workflow Analysis Tools (new)                                  │      │
│  │  • Config Management Tools (new)                                  │      │
│  └──────────────────────────────────────────────────────────────────┘      │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         External Resources                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐           │
│  │  GitHub API     │   │ devops-config   │   │  Target Repos   │           │
│  │  (Actions,      │   │ Repository      │   │  (workflows,    │           │
│  │   Billing)      │   │ (policies,      │   │   actions)      │           │
│  │                 │   │  specs)         │   │                 │           │
│  └─────────────────┘   └─────────────────┘   └─────────────────┘           │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

## 📁 Central Config Repository Structure

The MCP server expects a **devops-config-repo** with this structure:

```
devops-config-repo/
├── .devops-config.json           # Main configuration file
├── policies/
│   ├── workflow-policies.yaml    # GitHub Actions workflow standards
│   ├── security-policies.yaml    # Security requirements
│   ├── cost-policies.yaml        # Cost/resource limits
│   └── compliance-policies.yaml  # SOC2, ISO27001, etc.
├── repositories/
│   ├── inventory.yaml            # List of repos to monitor
│   └── groups/
│       ├── frontend.yaml         # Frontend team repos
│       ├── backend.yaml          # Backend team repos
│       ├── infrastructure.yaml   # Infra team repos
│       └── data.yaml             # DBA/data team repos
├── workflows/
│   ├── patterns/
│   │   ├── ci-standard.yaml      # Standard CI workflow template
│   │   ├── cd-production.yaml    # Production deploy template
│   │   └── security-scan.yaml    # Security scanning template
│   └── rules/
│       ├── naming-conventions.yaml
│       ├── required-steps.yaml
│       └── forbidden-actions.yaml
└── dashboards/
    ├── executive.yaml            # Executive summary config
    ├── devops.yaml               # DevOps team dashboard
    └── team-specific.yaml        # Per-team views
```

## 📋 Configuration File Format

### `.devops-config.json` (Main Config)

```json
{
  "$schema": "https://schema.devops-observer.io/v1/config.json",
  "version": "1.0.0",
  "organization": {
    "name": "My Organization",
    "github_org": "my-org",
    "environments": ["development", "staging", "production"]
  },
  "configRepo": {
    "owner": "my-org",
    "repo": "devops-config",
    "branch": "main",
    "autoReload": true,
    "reloadInterval": "5m"
  },
  "paths": {
    "policies": "policies/",
    "repositories": "repositories/",
    "workflows": "workflows/",
    "dashboards": "dashboards/"
  },
  "defaults": {
    "enforcement": "advisory",
    "autoFix": false,
    "notifyOnViolation": true
  }
}
```

### `policies/workflow-policies.yaml`

```yaml
apiVersion: devops.observer/v1
kind: WorkflowPolicy
metadata:
  name: github-actions-standards
  version: "1.0.0"

spec:
  # Workflow naming conventions
  naming:
    pattern: "^(ci|cd|security|release|maintenance)-.*\\.ya?ml$"
    message: "Workflow files must start with ci-, cd-, security-, release-, or maintenance-"
    
  # Required workflow components
  requirements:
    timeout:
      enabled: true
      maxMinutes: 60
      message: "All workflows must have a timeout-minutes set (max 60)"
      
    permissions:
      enabled: true
      requireExplicit: true
      allowed:
        contents: ["read", "write"]
        packages: ["read", "write"]
        actions: ["read"]
      forbidden:
        - "write-all"
      message: "Workflows must declare explicit permissions"
      
    concurrency:
      enabled: true
      requireCancelInProgress: true
      message: "Workflows should use concurrency with cancel-in-progress"

  # Forbidden patterns
  forbidden:
    actions:
      - pattern: "actions/checkout@v1"
        reason: "v1 is deprecated, use v4+"
      - pattern: ".*@master"
        reason: "Pin actions to specific versions, not branches"
      - pattern: ".*@main"
        reason: "Pin actions to specific versions, not branches"
        
    secrets:
      - pattern: "\\$\\{\\{ secrets\\.GITHUB_TOKEN \\}\\}"
        context: "permissions not declared"
        reason: "Must declare permissions when using GITHUB_TOKEN"
        
    commands:
      - pattern: "curl.*\\| bash"
        reason: "Piping curl to bash is a security risk"
      - pattern: "wget.*\\| sh"
        reason: "Piping wget to sh is a security risk"

  # Required steps in workflows
  requiredSteps:
    ci:
      - name: "checkout"
        pattern: "actions/checkout@v[34]"
      - name: "lint"
        pattern: "(eslint|flake8|rubocop|golangci-lint)"
      - name: "test"
        pattern: "(npm test|pytest|rspec|go test)"
        
    cd:
      - name: "approval"
        pattern: "(environment.*approval|manual-approval)"
        environments: ["production"]
```

## 📊 Repository Tiers

Repository tiers define the criticality and service level expectations for monitored repositories. Use tiers to prioritize alerting, define compliance requirements, and set SLA targets.

### Tier Definitions

| Tier | Priority | Description | Use Cases |
|------|----------|-------------|-----------|
| **tier-1** | 🔴 Critical | Production-critical systems requiring immediate attention | Customer-facing APIs, core services, payment systems |
| **tier-2** | 🟡 Standard | Important systems with standard monitoring | Internal tools, staging environments, non-critical services |
| **tier-3** | 🟢 Low | Development/experimental systems with relaxed monitoring | Demos, prototypes, archived projects |

### Service Level Expectations

| Tier | Uptime Target | Incident Response | CI/CD Success Rate | Max Build Time |
|------|---------------|-------------------|-------------------|----------------|
| **tier-1** | 99.9% | < 15 minutes | > 95% | < 10 minutes |
| **tier-2** | 99% | < 1 hour | > 90% | < 20 minutes |
| **tier-3** | Best effort | < 24 hours | > 80% | No limit |

### Compliance by Tier

| Tier | Required Compliance | Optional Compliance |
|------|---------------------|---------------------|
| **tier-1** | SOC2 | HIPAA, PCI-DSS, ISO27001 |
| **tier-2** | None | SOC2 |
| **tier-3** | None | None |

### Alerting Behavior

| Tier | Failure Alert | Success Rate < 90% | Long Queue Times |
|------|---------------|--------------------|--------------------|
| **tier-1** | Immediate (Slack, PagerDuty) | Immediate alert | > 5 min triggers alert |
| **tier-2** | Batched hourly | Daily digest | > 15 min triggers alert |
| **tier-3** | Daily digest | Weekly summary | No alert |

### Example Configuration

```yaml
repositories:
  - name: payment-api
    tier: tier-1           # Critical - immediate alerts
    compliance: [SOC2, PCI-DSS]
    
  - name: internal-dashboard
    tier: tier-2           # Standard monitoring
    compliance: [SOC2]
    
  - name: demo-app
    tier: tier-3           # Relaxed monitoring
```

### `repositories/inventory.yaml`

```yaml
apiVersion: devops.observer/v1
kind: RepositoryInventory
metadata:
  name: organization-repos
  version: "1.0.0"

spec:
  # Auto-discovery settings
  discovery:
    enabled: true
    includeArchived: false
    includeForked: false
    minStars: 0
    
  # Explicit repository list (overrides discovery)
  repositories:
    - name: "my-org/frontend-app"
      team: frontend
      tier: "tier-1"
      compliance: ["SOC2"]
      
    - name: "my-org/backend-api"
      team: backend
      tier: "tier-1"
      compliance: ["SOC2", "HIPAA"]
      
    - name: "my-org/data-pipeline"
      team: data
      tier: "tier-2"
      compliance: ["SOC2"]
      dba_contact: "data-team@example.com"
      
  # Repository groups (for filtering)
  groups:
    critical:
      pattern: ".*-(api|core|auth)$"
      tier: "tier-1"
      
    infrastructure:
      pattern: ".*-(infra|terraform|k8s)$"
      team: infrastructure
```

## 🛠️ New Tools

### Policy & Validation Tools

| Tool | Description |
|------|-------------|
| `validate_workflows` | Validate workflows against policy rules |
| `scan_workflow_violations` | Find policy violations across repos |
| `get_policy_compliance_report` | Generate compliance summary |
| `suggest_workflow_fixes` | AI-powered fix suggestions |

### Config Management Tools

| Tool | Description |
|------|-------------|
| `load_devops_config` | Load/reload config from devops-config-repo |
| `list_monitored_repos` | List repos under observation |
| `get_repo_health` | Health score for a repository |
| `sync_config` | Force sync with config repo |

### Team-Specific Tools

| Tool | Description |
|------|-------------|
| `get_team_dashboard` | Team-specific metrics dashboard |
| `get_dba_pipeline_status` | Data pipeline health for DBAs |
| `get_infra_cost_analysis` | Infrastructure cost breakdown |

## 🔧 Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GITHUB_TOKEN` | ✅ Yes | Fine-grained PAT |
| `GITHUB_ORG` | ✅ Yes | Target organization to monitor (e.g., `my-company`). Required - no fallback. |
| `DEVOPS_CONFIG_REPO` | 🔶 Optional | Config repo (default: `{org}/devops-config`) |
| `DEVOPS_CONFIG_BRANCH` | ❌ Optional | Branch (default: `main`) |
| `DEVOPS_CONFIG_PATH` | ❌ Optional | Local path override |
| `AUTO_RELOAD_CONFIG` | ❌ Optional | Enable hot reload (default: `true`) |

## 🚀 Implementation Phases

### Phase 1: Config Loader (Current Sprint)
- [ ] Create `ConfigLoader` service to read from devops-config-repo
- [ ] Implement `.devops-config.json` schema
- [ ] Add `load_devops_config` tool
- [ ] Support local file fallback

### Phase 2: Policy Engine
- [ ] Create `PolicyEngine` service
- [ ] Implement workflow policy validation
- [ ] Add `validate_workflows` tool
- [ ] Add `scan_workflow_violations` tool

### Phase 3: Repository Inventory
- [ ] Implement repository inventory loading
- [ ] Add repository health scoring
- [ ] Add `list_monitored_repos` tool
- [ ] Add `get_repo_health` tool

### Phase 4: Team Dashboards
- [ ] Implement dashboard configurations
- [ ] Add team-specific views
- [ ] Add role-based tool filtering
- [ ] DBA-specific tools

## 📊 Example Usage

### DevOps Engineer
```
"Show me workflow violations across all tier-1 repositories"
"Generate a compliance report for SOC2"
"Which workflows are missing timeout settings?"
```

### Developer
```
"Validate the workflow in my current repo"
"What are the required steps for a CI workflow?"
"Show me the team productivity metrics"
```

### DBA
```
"Show data pipeline status for the last 24 hours"
"Which data workflows failed this week?"
"Get cost analysis for data team resources"
```

### Infrastructure Engineer
```
"Show runner utilization for self-hosted runners"
"Generate cost optimization report for infrastructure"
"List all terraform workflow runs"
```

## 🔗 Integration with Existing Tools

The new policy-aware features will enhance existing tools:

| Existing Tool | Enhancement |
|---------------|-------------|
| `get_actions_usage_metrics` | Filter by policy-defined repo groups |
| `get_compliance_audit_report` | Use policy-defined compliance frameworks |
| `generate_cost_optimization_report` | Apply cost policies for recommendations |
| `get_workflow_insights` | Validate against workflow policies |

## 📝 Migration Path

1. **No breaking changes** - Existing functionality continues to work
2. **Optional config repo** - Works without devops-config-repo
3. **Graceful fallback** - Falls back to defaults if config unavailable
4. **Additive features** - New tools added alongside existing ones
