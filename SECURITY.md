# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | ✅        |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, email **security@yourdomain.com** with:

- A description of the vulnerability
- Steps to reproduce
- Potential impact
- Any suggested fix (optional)

We will acknowledge your report within **48 hours** and aim to release a fix within **7 days** for critical issues.

## Threat Model

memo-agent runs locally and connects to your configured LLM API. Key security considerations:

- **Prompt injection** — user-editable files (`NOTES.md`, `PROFILE.md`, recipes) are scanned for injection patterns before being injected into the system prompt
- **Path traversal** — file tools (`ReadFile`, `WriteFile`, `EditFile`) are restricted to `cwd` and the profile directory
- **Dangerous commands** — `RunCommand` maintains a blocklist of destructive shell commands that always require confirmation regardless of permission mode
- **API keys** — never committed; loaded from `.env` or environment variables only
- **Tool scope** — tools can be disabled via `permissions.disabledTools` in `config.yaml`

## Known Limitations

- The agent has access to your filesystem within the working directory — review tool permissions carefully in `ask` mode before granting `allow_always`
- LLM outputs are inherently non-deterministic; the permission system is a safety net, not a guarantee
