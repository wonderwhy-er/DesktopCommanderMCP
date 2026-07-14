# Security Policy

## Security Model

Desktop Commander is a privileged local automation tool. It lets an AI client you authorize read and write files and execute terminal commands on your machine. That capability is the point of the product — not a flaw.

Because it can run arbitrary terminal commands, Desktop Commander should be understood as an **amplifier of whatever the connected AI client asks it to do**. Its built-in restrictions are **safety guardrails that reduce accidental or unintended actions**, not a security sandbox that can contain a malicious or compromised client.

### Core assumption

Desktop Commander assumes the connected AI client — and the account driving it — is **trusted and uncompromised**. It executes requested actions and does not attempt to determine whether a request originates from a genuine user, from prompt injection, or from a compromised AI account. Protecting the integrity of that client and account is part of the overall security model and is the user's responsibility.

If the AI client should never be able to reach the rest of your machine, that guarantee can only come from OS-level isolation (see below).

## What the built-in controls do

| Control | Purpose | Security boundary? |
|---------|---------|--------------------|
| Allowed directories | Reduce accidental file access | No |
| Command blocklist | Reduce accidental execution | No |
| Symlink traversal prevention | Block a class of accidental path escapes | No |
| Docker / VM isolation | Contain the tool to an isolated environment | Yes |

Terminal command execution is a first-class feature. Because it can launch arbitrary programs, path-based and command-based restrictions can be circumvented by design — for example via shell substitution, absolute paths, or invoking another interpreter. These controls are advisory: they make common mistakes less likely; they are not a boundary against a client that is actively trying to escape them.

## Recommended deployment for stronger isolation

For any workload where the AI client must not access the wider machine, run Desktop Commander inside an isolated environment:

- **Docker** with selective folder mounting (see the [Docker installation section](README.md#option-6-docker-installation-🐳-⭐-auto-updates-no-nodejs-required))
- A **virtual machine**, dev container, or a separate/dedicated workstation

Additional practical steps:

- Enable MFA on the AI accounts you connect
- Only connect AI clients you trust; remove ones you no longer use
- Scope work to project-specific directories rather than your whole home folder
- Review generated commands when the context warrants it

## Known limitations

- Directory restrictions are guardrails, not sandboxing — terminal commands can reach files outside `allowedDirectories`.
- The command blocklist can be circumvented via substitution, absolute paths, or alternate interpreters.
- Desktop Commander does not protect against a compromised AI account or prompt injection reaching a trusted client. For that threat model, use OS-level isolation.

## License and responsibility

Desktop Commander is free, open-source software released under the MIT License. As is standard for MIT-licensed software, it is provided "as is," without warranty, and you are responsible for how you deploy and secure it in your environment. This security model describes how the tool is designed to behave; it does not transfer responsibility for your accounts, machines, or connected AI clients to the project.

## Reporting a Vulnerability

We welcome responsible disclosure and review all reported security issues.

1. **Open a GitHub issue** with technical details and, if possible, a proof of concept.
2. **Label it security-related** for visibility.
3. **Request attribution** if you'd like to be credited.

If you'd prefer not to disclose publicly, reach out via Discord to arrange private disclosure. We acknowledge reports, assess severity and impact, and prioritize fixes accordingly.

## Contact

- **GitHub Issues**: https://github.com/wonderwhy-er/DesktopCommanderMCP/issues
- **Discord Community**: https://discord.gg/kQ27sNnZr7

---

*Last updated: July 2026*