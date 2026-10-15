# Security policy

## Reporting a vulnerability

Please do **not** report a security problem in a public issue, pull request or
forum post.

Report it privately through GitHub instead: open the **Security** tab of this
repository, then **Report a vulnerability**.

No such button? Private reporting is not enabled yet: open an issue that only
asks the maintainers for a private contact, without any detail of the problem,
and send the report there.

Include, when you can:

- the version of the integration and of Gladys;
- what an attacker can do, and the steps to reproduce it;
- the log lines that help (remove tokens, passwords and addresses first).

The fix ships as a new version of the integration, and the advisory is
published once users can update.

## Supported versions

Only the latest release receives security fixes: update the integration from
Gladys before reporting a problem.

## Scope

In scope: the code of this repository and the Docker image it publishes.

What the integration handles:

- **Secrets**: the e-mail and the password of the powerfox account. They are
  stored by Gladys in the configuration of the integration (the password as a
  `secret` field), sent only to `https://backend.powerfox.energy` in an HTTP
  Basic header, and never written to the logs, to an error message or to disk.
- **`/data`**: nothing. The integration keeps no state on disk.
- **Network**: outgoing HTTPS to `backend.powerfox.energy` only (read-only
  requests: device list, current reading, daily report). No listening port, no
  local network access.

Out of scope: Gladys Assistant itself (see its
[security policy](https://github.com/GladysAssistant/Gladys/security/policy)),
the powerfox cloud and the poweropti readers.
