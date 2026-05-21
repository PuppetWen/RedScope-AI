# RedScope Source Cache

This directory is for quarantined PoC, CVE, template, and lab-environment
source trees downloaded by:

```bash
bun run redscope:sources -- --update --yes
```

Treat downloaded repositories as untrusted reference material. RedScope
workflows must not execute PoC code directly from this directory.
