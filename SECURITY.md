# Security Policy

## Supported Versions

Security fixes go into the latest release from `master`. There are no backports. For any older version, upgrade to the latest release.

## Reporting a Vulnerability

Please report vulnerabilities privately through GitHub: open the repository's **Security** tab, choose **Report a vulnerability**, or go directly to https://github.com/valksor/margrave/security/advisories/new.

Do not open a public issue for a security problem.

Include the margrave version, your platform and Node version, and the steps to reproduce.

This is a small project, so there is no response-time guarantee. Reports are handled on a best-effort basis.

## Scope

In scope: the `margrave` CLI and its MCP server in this repository, for example the path guard, how sources are stored and updated, the install scan and its refusal rules, and the release bundles.

Out of scope:

- Skills that you install. margrave scans a new or updated source with ripwire and refuses on findings, but it does not vouch for the content of a skill. Review skills before you trust them.
- ripwire itself. Report problems in ripwire to [redhat-et/ripwire](https://github.com/redhat-et/ripwire).
