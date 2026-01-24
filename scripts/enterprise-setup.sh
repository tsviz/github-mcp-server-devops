#!/bin/bash

# MCP DevOps Observer Enterprise Setup Script
set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}╔════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   MCP DevOps Observer Enterprise Setup    ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════╝${NC}"
echo ""

# Check Docker
if ! command -v docker &> /dev/null; then
    echo -e "${RED}❌ Docker is not installed. Please install Docker first.${NC}"
    exit 1
fi

# Enterprise validation
echo -e "${YELLOW}🏢 Enterprise Verification${NC}"
echo "================================"
echo "This software requires GitHub Enterprise (Cloud or Server)."
echo ""
echo "Select your GitHub Enterprise type:"
echo "1) GitHub Enterprise Cloud"
echo "2) GitHub Enterprise Server"
echo "3) I don't have GitHub Enterprise"
read -p "Enter choice (1-3): " ENTERPRISE_TYPE

if [ "$ENTERPRISE_TYPE" = "3" ]; then
    echo -e "${RED}❌ GitHub Enterprise Required${NC}"
    echo ""
    echo "This MCP server requires GitHub Enterprise for:"
    echo "  • Actions usage metrics and billing APIs"
    echo "  • Advanced performance analytics"
    echo "  • Cost optimization features"
    echo "  • Team productivity metrics"
    echo "  • Compliance and audit reports"
    echo ""
    echo -e "${GREEN}To get started with GitHub Enterprise:${NC}"
    echo "  1. Visit: https://github.com/enterprise/trial"
    echo "  2. Contact Sales: sales@github.com"
    echo "  3. Call: 1-877-958-8742"
    echo ""
    exit 1
fi

# Configure based on Enterprise type
if [ "$ENTERPRISE_TYPE" = "1" ]; then
    echo -e "${GREEN}Configuring for GitHub Enterprise Cloud${NC}"
    read -p "Enter your Enterprise slug (e.g., 'acme-corp'): " ENTERPRISE_SLUG
    ENTERPRISE_URL="https://api.github.com"
    
    # Verify Enterprise Cloud access
    echo -e "${YELLOW}Verifying Enterprise Cloud access...${NC}"
    if ! gh api "/enterprises/$ENTERPRISE_SLUG" &> /dev/null; then
        echo -e "${RED}❌ Cannot access enterprise '$ENTERPRISE_SLUG'${NC}"
        echo "Please ensure:"
        echo "  1. You have a GitHub Enterprise Cloud subscription"
        echo "  2. The enterprise slug is correct"
        echo "  3. You're authenticated with 'gh auth login'"
        exit 1
    fi
    echo -e "${GREEN}✅ Enterprise Cloud access verified${NC}"
    
elif [ "$ENTERPRISE_TYPE" = "2" ]; then
    echo -e "${GREEN}Configuring for GitHub Enterprise Server${NC}"
    read -p "Enter your Enterprise Server URL (e.g., https://github.company.com): " ENTERPRISE_URL
    read -p "Enter your Enterprise slug: " ENTERPRISE_SLUG
    
    # Verify Enterprise Server access
    echo -e "${YELLOW}Verifying Enterprise Server access...${NC}"
    if ! curl -s "$ENTERPRISE_URL/api/v3/enterprise/settings/license" &> /dev/null; then
        echo -e "${RED}❌ Cannot access Enterprise Server at $ENTERPRISE_URL${NC}"
        echo "Please ensure:"
        echo "  1. The URL is correct"
        echo "  2. You have network access to the server"
        echo "  3. The server has a valid license"
        exit 1
    fi
    echo -e "${GREEN}✅ Enterprise Server access verified${NC}"
fi

# Create config directory
CONFIG_DIR="${HOME}/.mcp-enterprise"
mkdir -p "$CONFIG_DIR"

# GitHub App configuration
echo ""
echo -e "${YELLOW}🔐 GitHub App Configuration${NC}"
echo "================================"
echo "Create your Enterprise GitHub App at:"
if [ "$ENTERPRISE_TYPE" = "1" ]; then
    echo "https://github.com/enterprises/$ENTERPRISE_SLUG/settings/apps/new"
else
    echo "$ENTERPRISE_URL/settings/apps/new"
fi
echo ""
echo "Required permissions:"
echo "  • Actions: Read"
echo "  • Administration: Read" 
echo "  • Billing: Read (Enterprise only)"
echo "  • Checks: Read"
echo "  • Contents: Read"
echo "  • Deployments: Read"
echo "  • Members: Read"
echo "  • Metadata: Read"
echo "  • Pull requests: Read"
echo ""

read -p "Enter your GitHub App ID: " APP_ID
read -p "Enter your Installation ID: " INSTALLATION_ID
read -p "Enter path to private key (.pem): " PEM_PATH

if [ ! -f "$PEM_PATH" ]; then
    echo -e "${RED}❌ Private key file not found: $PEM_PATH${NC}"
    exit 1
fi

PRIVATE_KEY=$(cat "$PEM_PATH")

# Advanced Enterprise Features
echo ""
echo -e "${YELLOW}🚀 Advanced Enterprise Features${NC}"
echo "================================"
read -p "Enable cost tracking? (y/n): " ENABLE_COST
read -p "Enable team metrics? (y/n): " ENABLE_TEAM
read -p "Enable compliance auditing? (y/n): " ENABLE_AUDIT

if [ "$ENABLE_AUDIT" = "y" ]; then
    echo "Select compliance framework:"
    echo "1) SOC2"
    echo "2) ISO27001"
    echo "3) HIPAA"
    echo "4) PCI-DSS"
    echo "5) Custom"
    read -p "Enter choice (1-5): " COMPLIANCE_CHOICE
    
    case $COMPLIANCE_CHOICE in
        1) COMPLIANCE_FRAMEWORK="SOC2";;
        2) COMPLIANCE_FRAMEWORK="ISO27001";;
        3) COMPLIANCE_FRAMEWORK="HIPAA";;
        4) COMPLIANCE_FRAMEWORK="PCI-DSS";;
        5) COMPLIANCE_FRAMEWORK="CUSTOM";;
        *) COMPLIANCE_FRAMEWORK="SOC2";;
    esac
fi

# Write configuration
ENV_FILE="$CONFIG_DIR/enterprise.env"
cat > "$ENV_FILE" << EOF
# GitHub Enterprise Configuration
GITHUB_ENTERPRISE_SLUG=$ENTERPRISE_SLUG
GITHUB_ENTERPRISE_URL=$ENTERPRISE_URL
GITHUB_APP_ID=$APP_ID
GITHUB_INSTALLATION_ID=$INSTALLATION_ID
GITHUB_PRIVATE_KEY="$PRIVATE_KEY"

# Enterprise Features
ENABLE_COST_TRACKING=$([ "$ENABLE_COST" = "y" ] && echo "true" || echo "false")
ENABLE_TEAM_METRICS=$([ "$ENABLE_TEAM" = "y" ] && echo "true" || echo "false")
ENABLE_AUDIT_LOGGING=$([ "$ENABLE_AUDIT" = "y" ] && echo "true" || echo "false")
COMPLIANCE_FRAMEWORK=${COMPLIANCE_FRAMEWORK:-NONE}

# Performance Settings
CACHE_TTL=300
MAX_CONCURRENT_REQUESTS=10
LOG_LEVEL=info

# MCP Configuration
MCP_SERVER_NAME=devops-observer-enterprise
MCP_SERVER_VERSION=2.0.0
EOF

chmod 600 "$ENV_FILE"
echo -e "${GREEN}✅ Configuration saved${NC}"

# Pull Enterprise Docker image
echo ""
echo -e "${YELLOW}🐳 Pulling Enterprise Docker image...${NC}"
docker pull ghcr.io/tsviz/github-mcp-server-devops:latest

# Configure IDE
echo ""
echo -e "${YELLOW}💻 IDE Configuration${NC}"
echo "================================"
echo "Add to your IDE configuration:"
echo ""
cat << EOF
{
  "mcpServers": {
    "devops-observer-enterprise": {
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "--env-file", "$ENV_FILE",
        "ghcr.io/tsviz/github-mcp-server-devops:latest"
      ]
    }
  }
}
EOF

# Success message
echo ""
echo -e "${GREEN}╔════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║        🎉 Setup Complete! 🎉              ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════╝${NC}"
echo ""
echo "You can now use enterprise-exclusive features:"
echo "  • 'Show me Actions usage breakdown for last 30 days'"
echo "  • 'What are our P95 queue times?'"
echo "  • 'Generate cost optimization report'"
echo "  • 'Analyze team productivity metrics'"
echo "  • 'Generate SOC2 compliance report'"
echo ""