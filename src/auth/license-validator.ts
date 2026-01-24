import { Octokit } from '@octokit/rest';

export class LicenseValidator {
  private octokit: Octokit;
  private lastCheck: Date | null = null;
  private isValidated: boolean = false;
  private enterprisePlan: string | null = null;

  constructor() {
    this.octokit = new Octokit({
      auth: process.env.GITHUB_APP_PRIVATE_KEY,
    });
  }

  async validateEnterpriseLicense(): Promise<boolean> {
    try {
      // Check if running in GitHub Enterprise Server
      if (process.env.GITHUB_ENTERPRISE_URL && 
          process.env.GITHUB_ENTERPRISE_URL !== 'https://api.github.com') {
        // For GitHub Enterprise Server, check license endpoint
        const { data } = await this.octokit.request('GET /enterprise/settings/license');
        
        if (data.seats && data.seats > 0 && data.expire_at) {
          const expiryDate = new Date(data.expire_at);
          if (expiryDate > new Date()) {
            console.log(`✅ GitHub Enterprise Server license valid until ${expiryDate.toDateString()}`);
            this.isValidated = true;
            this.enterprisePlan = 'GitHub Enterprise Server';
            return true;
          }
        }
        
        throw new Error('GitHub Enterprise Server license expired or invalid');
      }
      
      // For GitHub Enterprise Cloud, verify enterprise membership
      const enterpriseSlug = process.env.GITHUB_ENTERPRISE_SLUG;
      if (!enterpriseSlug) {
        throw new Error('GITHUB_ENTERPRISE_SLUG environment variable is required for GitHub Enterprise Cloud');
      }
      
      // Verify enterprise exists and we have access
      const { data: enterprise } = await this.octokit.request('GET /enterprises/{enterprise}', {
        enterprise: enterpriseSlug,
      });
      
      // Check for enterprise billing access (only available for Enterprise accounts)
      try {
        await this.octokit.request('GET /enterprises/{enterprise}/settings/billing/actions', {
          enterprise: enterpriseSlug,
        });
        
        console.log(`✅ GitHub Enterprise Cloud access verified for ${enterprise.name}`);
        this.isValidated = true;
        this.enterprisePlan = 'GitHub Enterprise Cloud';
        this.lastCheck = new Date();
        return true;
        
      } catch (billingError: any) {
        if (billingError.status === 404 || billingError.status === 403) {
          throw new Error('This GitHub organization does not have Enterprise Cloud access. Please upgrade at https://github.com/enterprise');
        }
        throw billingError;
      }
      
    } catch (error: any) {
      console.error('❌ Enterprise License Validation Failed:', error.message);
      console.error('\n📝 This MCP server requires GitHub Enterprise for:');
      console.error('  • Actions usage metrics and billing data');
      console.error('  • Advanced performance analytics');
      console.error('  • Runner utilization metrics');
      console.error('  • Cost optimization insights');
      console.error('  • Team productivity metrics');
      console.error('  • Compliance and audit reports');
      console.error('\n💡 To use this server:');
      console.error('  1. Upgrade to GitHub Enterprise Cloud at https://github.com/enterprise');
      console.error('  2. Or install GitHub Enterprise Server in your infrastructure');
      console.error('\n📧 Contact GitHub Sales: sales@github.com');
      
      return false;
    }
  }

  async checkRateLimit(): Promise<void> {
    // Re-validate license periodically (every hour)
    if (!this.lastCheck || 
        (new Date().getTime() - this.lastCheck.getTime()) > 3600000) {
      const isValid = await this.validateEnterpriseLicense();
      if (!isValid) {
        throw new Error('GitHub Enterprise license validation failed');
      }
    }
  }

  getEnterprisePlan(): string | null {
    return this.enterprisePlan;
  }

  isEnterpriseValidated(): boolean {
    return this.isValidated;
  }
}