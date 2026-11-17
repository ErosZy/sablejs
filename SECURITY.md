# Security policy

[← README](README.md) · [Docs Index](docs/README.md) · [Threat Model](docs/security.md) · [Worker Isolation](docs/worker-isolation.md)

**sablejs** treats sandbox escapes, unauthorized host-object access, capability-boundary bypasses, host-information leaks (paths or stacks), and Worker protocol vulnerabilities as security issues.

## Supported versions

| Version | Security support |
| --- | --- |
| `2.0.0-beta.*` | Supported |
| `1.1.x` and earlier | Upgrade to v2 before requesting a fix |

## Reporting a vulnerability

Please **do not** open a public GitHub issue for suspected security vulnerabilities.

1. Preferred: submit a [GitHub private vulnerability report](https://github.com/ErosZy/sablejs/security/advisories/new).
2. Alternative: email `zyeros1991@gmail.com` with the subject **`sablejs security report`**.

To help us reproduce and validate quickly, include:
- The `sablejs` version and host runtime (Node, Deno, Bun, or browser + version).
- A minimal guest/host reproducer showing expected vs observed behavior.
- Potential security impact (with any secrets or personal data removed).

## Response targets

- **Initial acknowledgment:** within 3 business days.
- **Initial assessment:** within 10 business days (complex compiler or boundary issues may take longer to verify across optimization levels and Test262).

Please coordinate public disclosure with the maintainers until a fix and permanent regression test are released. For the technical threat model, boundary policies, and audit history, see [docs/security.md](docs/security.md).
