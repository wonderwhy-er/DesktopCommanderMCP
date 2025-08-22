# Security Policy

## Current Security Approach

Desktop Commander is designed for human users working with AI assistants like Claude. The security restrictions built into the tool are primarily **guardrails to help the AI model** avoid actions the user didn't intend, rather than hardened security boundaries.

**Security is not currently our top priority** - we haven't heard significant demand from users for stronger security controls. We take **user needs seriously**, so if you need better security controls for your specific use case, please contact the team to discuss your requirements.

**For users who need security**: We recommend using Desktop Commander with Docker, which provides complete isolation. See the [Docker installation section](README.md#option-6-docker-installation-🐳-⭐-auto-updates-no-nodejs-required) in our README for setup instructions.

## Reporting Vulnerabilities

1. **Create a GitHub Issue** with detailed information
2. **Label it as security-related** for visibility  
3. **Include technical details** and proof of concept if possible
4. **Request attribution** if you'd like to be credited in any future advisories

We will acknowledge reports and provide context as needed.

## Current Security Limitations

This project has known security limitations:
- Directory restrictions can be bypassed via symlinks and terminal commands
- Command blocking can be bypassed via substitution and absolute paths
- Terminal commands can access files outside `allowedDirectories` restrictions

**For production use requiring security**: Use Docker installation with selective folder mounting for complete isolation. See [Docker installation instructions](README.md#option-6-docker-installation-🐳-⭐-auto-updates-no-nodejs-required) for setup details.

## Disclosure Timeline

As a startup focused on user needs rather than theoretical security concerns, we prioritize issues based on actual user demand. We may not respond immediately to security reports but will address issues that affect real user workflows. We appreciate responsible disclosure and will work with researchers when addressing vulnerabilities aligns with user priorities.

## Contact

- **GitHub Issues**: https://github.com/wonderwhy-er/DesktopCommanderMCP/issues
- **Discord Community**: https://discord.gg/kQ27sNnZr7

---

*Last updated: January 2025*