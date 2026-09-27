# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| Latest  | :white_check_mark: |

## Reporting a Vulnerability

We take security vulnerabilities seriously. If you discover a security issue, please report it responsibly.

### How to Report

1. **Do NOT open a public issue** for security vulnerabilities
2. Use GitHub's [private vulnerability reporting](https://github.com/diaoyunxi/) feature, or email the maintainer
3. Include a detailed description of the vulnerability
4. Provide steps to reproduce the issue if possible

### What to Expect

- **Acknowledgment**: Receipt acknowledged within 48 hours
- **Assessment**: Severity and impact assessed within 7 days
- **Resolution**: Fix released within 30 days for critical issues
- **Disclosure**: Responsible disclosure after a fix is available

### Scope

In scope:
- Code execution vulnerabilities
- Authentication/authorization bypasses
- Data exposure or injection attacks
- Denial of service vectors

Out of scope:
- Third-party dependency issues (report upstream)
- Social engineering attacks
- Issues requiring physical access

## Security Best Practices for Users

- Always run the latest version
- Never expose services to the public internet without proper authentication
- Use environment variables for sensitive configuration
- Review access logs regularly
