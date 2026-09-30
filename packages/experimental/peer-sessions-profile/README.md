---
description: "The optional bundle that mounts the peer session service and its tools with the shipped configuration."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-peer-sessions-profile

English | [中文](README.zh.md)

## Summary

Use `dsh-experimental-peer-sessions-profile` to enable peer coordination in one profile. The bundle is a patch list that inserts [`dsh-experimental-peer-sessions`](../peer-sessions/README.md) and [`dsh-experimental-tool-peer-sessions`](../tool-peer-sessions/README.md) with the shipped configuration, and it ships the icons and locale files the bundle roster requires. Mounting it is the switch: a profile that does not enable it is invisible to peers, and a session in a profile that does enable it sees only top-level sessions grouped in the same repository.

## Table of Contents

- [Use this package](#use-this-package)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Add the bundle as an optional bundle in the profile that should offer peer coordination. Every peer process that must see the others enables the bundle in its own profile, and all of them share one Harness home; the home is who can write the mailbox files, and repository grouping is who can be delivered.

```yaml
- name: '@deepseek-ai/dsh-experimental-peer-sessions'
  config:
    pollMs: 1000
    maxPendingPerTarget: 8
    maxPendingPerSenderPerTarget: 4
    maxMessageBytes: 8192
    maxIdleWatches: 32
    peerInbound: steer
- name: '@deepseek-ai/dsh-experimental-tool-peer-sessions'
```

The inserted rows carry exactly these limits, so a profile that needs different caps overrides the bundle patch rather than this package.

-----

<a id="further-exploration"></a>
## Further Exploration

- [Peer session service](../peer-sessions/README.md) — the registry, mailbox, and repository key the bundle mounts.
- [Tool package](../tool-peer-sessions/README.md) — the tools and prompt section the bundle mounts.
- [Configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-peer-sessions) — every accepted field and its JSDoc.

-----

<a id="model-experience"></a>
## Model Experience

None, as the bundle only inserts two plugin rows with their shipped configuration, and the inserted packages own every model-facing tool, result, and prompt line.

#### KV Cache effect

No direct invalidation; changing the bundle's rows changes which plugins own the request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when enabling the bundle is not enough. They are current package constraints, not a task backlog.

- **Every peer must opt in** — a session whose profile omits the bundle is invisible to peers, so an empty `list_peers` does not prove that no other session is running.
- **One shared Harness home** — processes with different `$DSH_HOME` values never see each other's mailboxes, watches, or presence files.
- **The bundle ships fixed limits** — a deployment that needs other caps overrides the bundle's patch rows instead of this package.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The bundle contributes a patch list, an icon, and locale files, and no independent event sequence.
