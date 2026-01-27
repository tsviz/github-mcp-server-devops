# Configuration Guide - ActionsPulse MCP Server

This guide covers all configuration options for the ActionsPulse MCP Server.

---

## Table of Contents

- [Environment Variables](#environment-variables)
- [MCP Server Configuration](#mcp-server-configuration)
- [Repository Inventory](#repository-inventory)
- [DevOps Configuration](#devops-configuration)
- [Docker Deployment](#docker-deployment)

---

## Environment Variables

### Required Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `GITHUB_TOKEN` | GitHub Personal Access Token | `ghp_xxxxxxxxxxxx` |
| `GITHUB_ORG` | Target GitHub organization to monitor. All API calls use this org. | `my-organization` |

> **Note**: `GITHUB_ORG` is required. There is no "default" organization in GitHub - you must specify which organization to monitor.

### Optional Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DEVOPS_CONFIG_PATH` | Path to config directory | `/app/config` |
| `LOG_LEVEL` | Logging verbosity | `info` |
| `ENABLE_METRICS` | Enable Prometheus metrics | `true` |
| `CACHE_TTL_SECONDS` | API response cache duration | `300` |

---

## MCP Server Configuration

### VS Code MCP Configuration

The MCP server is configured in your VS Code settings. The configuration file location depends on your OS:

| OS | Path |
|----|------|
| macOS | `~/Library/Application Support/Code/User/mcp.json` |
| Linux | `~/.config/Code/User/mcp.json` |
| Windows | `%APPDATA%\Code\User\mcp.json` |

### Basic Docker Configuration

<details>
<summary>📄 Basic mcp.json</summary>

```jsonc
{
  "servers": {
    "actions-pulse": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "GITHUB_TOKEN=ghp_your_token_here",
        "-e", "GITHUB_ORG=your-org",
        "ghcr.io/tsviz/actions-pulse:latest"
      ],
      "type": "stdio"
    }
  }
}
```

</details>

### With Custom Configuration Volume

<details>
<summary>📄 mcp.json with config volume</summary>

```jsonc
{
  "servers": {
    "actions-pulse": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "GITHUB_TOKEN=ghp_your_token_here",
        "-e", "GITHUB_ORG=your-org",
        "-e", "DEVOPS_CONFIG_PATH=/app/config",
        "-v", "/Users/you/devops-config:/app/config:ro",
        "ghcr.io/tsviz/actions-pulse:latest"
      ],
      "type": "stdio"
    }
  }
}
```

</details>

### Using Environment File

For better security, use an env file instead of inline tokens:

<details>
<summary>📄 mcp.json with env-file</summary>

```jsonc
{
  "servers": {
    "actions-pulse": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "--env-file", "/Users/you/.actions-pulse.env",
        "-v", "/Users/you/devops-config:/app/config:ro",
        "ghcr.io/tsviz/actions-pulse:latest"
      ],
      "type": "stdio"
    }
  }
}
```

</details>

<details>
<summary>📄 .actions-pulse.env</summary>

```dotenv
GITHUB_TOKEN=ghp_your_token_here
GITHUB_ORG=your-organization
DEVOPS_CONFIG_PATH=/app/config
LOG_LEVEL=info
```

</details>

### Local Development Configuration

For local development without Docker:

<details>
<summary>📄 mcp.json for local development</summary>

```jsonc
{
  "servers": {
    "actions-pulse": {
      "command": "node",
      "args": ["build/index.js"],
      "cwd": "/path/to/actions-pulse",
      "env": {
        "GITHUB_TOKEN": "ghp_your_token_here",
        "GITHUB_ORG": "your-org",
        "LOG_LEVEL": "debug"
      },
      "type": "stdio"
    }
  }
}
```

</details>

---

## Repository Inventory

The repository inventory defines which repositories ActionsPulse monitors and analyzes.

### File Location

```
config/
└── repositories/
    └── inventory.yaml
```

### Full Schema

<details>
<summary>📄 Complete inventory.yaml schema</summary>

```yaml
apiVersion: actions-pulse/v1
kind: RepositoryInventory
metadata:
  name: my-inventory
  version: "1.0.0"
  description: "Repository inventory description"

spec:
  # Auto-discovery settings
  discovery:
    enabled: false              # Enable auto-discovery of repos
    includeArchived: false      # Include archived repositories
    includeForked: false        # Include forked repositories
    excludePatterns:            # Glob patterns to exclude
      - "*-archived"
      - "legacy-*"

  # Explicitly defined repositories
  repositories:
    - name: my-app                    # Repository name
      owner: my-org                   # Repository owner (optional if using GITHUB_ORG)
      team: platform-engineering      # Team responsible
      tier: tier-1                    # Service tier (tier-1, tier-2, tier-3)
      compliance:                     # Compliance frameworks
        - SOC2
        - HIPAA
      tags:                           # Custom tags for filtering
        - java
        - springboot
        - production

    - name: my-frontend
      team: frontend
      tier: tier-2
      compliance:
        - SOC2
      tags:
        - react
        - typescript

  # Repository groups for bulk configuration
  groups:
    production:
      repositories:
        - my-app
        - api-gateway
        - auth-service
      tier: tier-1
      team: platform-engineering
      compliance:
        - SOC2
        - PCI-DSS

    staging:
      repositories:
        - my-frontend
        - admin-portal
      tier: tier-2
      team: frontend
```

</details>

### Repository Tiers

| Tier | Priority | Uptime SLA | Response Time | Use Case |
|------|----------|------------|---------------|----------|
| `tier-1` | 🔴 Critical | 99.9% | < 15 min | Production, revenue-critical |
| `tier-2` | 🟡 Standard | 99% | < 1 hour | Internal tools, staging |
| `tier-3` | 🟢 Low | Best effort | < 24 hours | Dev, experimental |

See [ARCHITECTURE.md](ARCHITECTURE.md#repository-tiers) for detailed tier documentation.

---

## DevOps Configuration

### File Location

```
config/
└── devops-config.yaml
```

### Configuration Schema

<details>
<summary>📄 Complete devops-config.yaml schema</summary>

```yaml
apiVersion: actions-pulse/v1
kind: DevOpsConfig
metadata:
  name: actions-pulse-config
  version: "1.0.0"

spec:
  # GitHub configuration
  github:
    organization: your-org
    defaultBranch: main
    
  # Metrics collection settings
  metrics:
    enabled: true
    collectInterval: 300        # Seconds between collections
    retentionDays: 90           # How long to keep metrics
    
  # DORA metrics configuration  
  dora:
    enabled: true
    productionEnvironments:     # Environments to track for deployments
      - production
      - prod
    excludeWorkflows:           # Workflows to exclude from DORA
      - "dependabot/*"
      
  # Alerting thresholds
  alerts:
    failureRateThreshold: 10    # Alert when failure rate exceeds %
    queueTimeThreshold: 300     # Alert when queue time exceeds seconds
    deploymentFrequency:
      warning: 1                # Warn if less than N deployments/day
      critical: 0.1             # Critical if less than N deployments/day
      
  # Compliance settings
  compliance:
    frameworks:
      - SOC2
      - HIPAA
    autoAudit: true
    auditSchedule: "0 0 * * 0"  # Weekly on Sunday
```

</details>

---

## Docker Deployment

### Docker Compose

For a complete deployment with monitoring:

<details>
<summary>📄 docker-compose.yml</summary>

```yaml
version: '3.8'

services:
  actions-pulse:
    image: ghcr.io/tsviz/actions-pulse:latest
    container_name: actions-pulse
    environment:
      - GITHUB_TOKEN=${GITHUB_TOKEN}
      - GITHUB_ORG=${GITHUB_ORG}
      - DEVOPS_CONFIG_PATH=/app/config
      - LOG_LEVEL=info
      - ENABLE_METRICS=true
    volumes:
      - ./config:/app/config:ro
      - ./reports:/app/reports:rw
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "node", "-e", "console.log('healthy')"]
      interval: 30s
      timeout: 10s
      retries: 3
```

</details>

### Building Locally

<details>
<summary>🔧 Build and run commands</summary>

```bash
# Clone the repository
git clone https://github.com/tsviz/actions-pulse.git
cd actions-pulse

# Build
npm install
npm run build

# Build Docker image
docker build -t actions-pulse:local .

# Run
docker run -i --rm \
  -e GITHUB_TOKEN=$GITHUB_TOKEN \
  -e GITHUB_ORG=your-org \
  actions-pulse:local
```

</details>

---

## Enhanced Runner Cost Detection

ActionsPulse uses a three-tier approach to accurately calculate runner costs, especially for custom-named larger runners.

### Detection Methods

| Method | Icon | Accuracy | Requirements |
|--------|------|----------|--------------|
| **API** | 🎯 | Highest | `manage_runners:org` scope + GitHub Enterprise Cloud |
| **Label** | 🏷️ | High | Standard runner labels or patterns like `linux-8-core` |
| **Default** | 📊 | Basic | Falls back to OS-based pricing |

### How It Works

1. **API Detection** (🎯): Fetches actual machine specs from `GET /orgs/{org}/actions/hosted-runners`
   - Returns `cpu_cores`, `memory_gb`, `storage_gb` for each runner
   - Works for custom-named larger runners like `my-build-runner` or `runner1`
   - Requires `manage_runners:org` scope or Admin organization permission

2. **Label Detection** (🏷️): Matches job labels against known patterns
   - Standard labels: `ubuntu-latest`, `windows-2022`, `macos-14`
   - Larger runner labels: `linux-8-core`, `windows-16-core`
   - Pattern matching: Extracts `8core` from `tsvi-linux8cores`

3. **Default Detection** (📊): Uses OS-based pricing as fallback
   - Linux: $0.008/min
   - Windows: $0.016/min
   - macOS: $0.08/min

### Enabling Accurate Cost Detection

<details>
<summary>📄 PAT Scope Requirements</summary>

For most accurate cost detection with custom-named larger runners, add these scopes:

**Fine-grained PAT:**
| Permission | Access | Purpose |
|------------|--------|---------|
| `Administration` | Read | Access hosted runners API |

**Classic PAT:**
| Scope | Purpose |
|-------|---------|
| `manage_runners:org` | Access hosted runners configuration |

</details>

### Example Output

When hosted runner specs are available, cost reports show enhanced detection:

```
> ✅ **Enhanced cost detection enabled** - Using GitHub Hosted Runners API for accurate larger runner pricing.

| Runner | Detected Type | Runs | Avg Duration | Queue Time | Failure Rate | Est. Cost |
|--------|---------------|------|--------------|------------|--------------|-----------|
| tsvi-linux8cores | 🎯 8-core (linux-x64) | 1 | 2m 31s | 3s | 0.0% | $0.33 |
| ubuntu-latest | 🏷️ ubuntu-latest | 50 | 1m 20s | 2s | 5.0% | $0.53 |
| custom-runner | 📊 linux (standard) | 10 | 0m 45s | 1s | 0.0% | $0.06 |
```

### Troubleshooting

<details>
<summary>🔧 "Hosted runners API not available"</summary>

This means the API returned 404 or 403. Possible causes:

1. **Not on GitHub Enterprise Cloud** - The hosted runners API requires Enterprise Cloud
2. **Missing scope** - Add `manage_runners:org` to your PAT
3. **Not an org admin** - You need admin access to the organization

Cost detection will fall back to label and default detection.

</details>

<details>
<summary>🔧 Runner costs seem too low</summary>

If custom larger runners show standard pricing:

1. Check if the hosted runners API is accessible (look for "Enhanced cost detection enabled" message)
2. Ensure runner names/labels contain hints like `8core`, `linux-8-core`, etc.
3. If using generic names like `runner1`, `runner2`, the API detection is required

</details>

---

## Security Best Practices

### Token Management

1. **Use fine-grained PATs** instead of classic tokens
2. **Store tokens in env files**, not in mcp.json
3. **Set minimal scopes** needed for your use case
4. **Rotate tokens regularly** (every 90 days recommended)

### Volume Mounts

1. **Use read-only mounts** (`:ro`) for configuration
2. **Use read-write mounts** (`:rw`) only for reports output
3. **Never mount sensitive directories** like `~/.ssh` or `~/.gnupg`

### Network Security

1. **Use `--network host`** only when needed for local development
2. **Don't expose ports** unless you need external access
3. **Use Docker secrets** in production environments

---

## Validation

<details>
<summary>🔍 Validation commands</summary>

```bash
# Check if inventory.yaml is valid YAML
cat config/repositories/inventory.yaml | python3 -c "import yaml, sys; yaml.safe_load(sys.stdin)"

# Verify Docker can read the config
docker run --rm \
  -v ./config:/app/config:ro \
  ghcr.io/tsviz/actions-pulse:latest \
  cat /app/config/repositories/inventory.yaml
```

</details>
