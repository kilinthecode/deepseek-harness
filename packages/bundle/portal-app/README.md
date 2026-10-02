---
description: "Portal terminal conversations and scripted model tasks for people and agent supervisors."
kind: "package-bundle"
---

# @deepseek-ai/dsh-portal-app

English | [中文](README.zh.md)

## Summary

`portal` opens a terminal conversation with a configured model. People, Codex, Claude, and other terminal callers use the same command. A task argument runs once and exits; `--json` supplies structured output for automation. The shipped `portal` profile includes this bundle over `dsh-base`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Open Portal

With the CLI installed, enter `portal`. From this checkout, enter `pnpm portal`. Bare invocation on a terminal opens a conversation; `/exit` closes it. Each task keeps the conversation history and prints its Session id for a later `--session-id` invocation.

```sh
portal
```

The welcome uses the isometric wireframe from the [app logo](../../../apps/desktop/resources/icon.svg) with the selected model and workspace. Wide terminals place artwork beside the details; smaller terminals stack them or use a compact mark. Model and status displays adapt to the available columns. Color follows terminal support and `NO_COLOR`; `TERM=dumb` and pipes use plain output. Disabling color preserves readable labels and terminal artwork where supported.

### Terminal controls

Use `/model` to open the searchable model picker. Type to filter, move with Up/Down, and press Enter to select; Ctrl-C closes the picker. Model changes apply to the next task and retain the conversation. `/models` displays provider groups and marks the current model; `/reasoning` opens the selected model's advertised effort picker.

| Command | Behavior |
|---|---|
| `/model [number \| provider model]` | Open the picker, select a catalog number, or choose an exact model route. |
| `/models [provider]` | List the configured model catalogs, optionally restricted to one provider. |
| `/reasoning [level]` | Open the reasoning picker, or choose an advertised effort. |
| `/status` | Show the route, workspace, Session, and latest completed turn's tokens when reported. |
| `/session` | Show the current Session id. |
| `/new` | Start a fresh conversation on the next task; the stored Session remains available. |
| `/resume <id>` | Continue the exact saved Session on the next task. |
| `/clear` | Clear a TTY display without changing conversation history. |
| `/help` | Show commands and keyboard shortcuts. |
| `/exit` | Close Portal. |

Enter submits a task. Ctrl-J or a trailing backslash followed by Enter adds another line to that task; bracketed paste keeps pasted lines together. Backspace on an empty continuation line returns to the preceding line. Up/Down browses input history; Tab completes slash commands. While a task runs, Escape or Ctrl-C cancels its current turn and returns to the prompt. Ctrl-C at an idle prompt exits Portal.

During tasks, Portal displays thinking and tool activity with brief tool-call and result summaries. Assistant responses preserve Markdown and code text with terminal emphasis. `/resume` uses the shared runner's [Session adoption rules](../headless/README.md), including the recorded working directory and exclusive ownership requirements.

### Reuse the Desktop or Web models

Model configuration belongs to a profile. `--models-from` reads saved built-in model overrides from an existing profile's user patch and the home patch for this invocation without editing that profile or starting its application. Credentials still resolve from the shared Harness home. Explicit `--patch` files override the borrowed configuration.

```sh
portal --models-from desktop models --json
portal --models-from desktop
```

A missing source fails before startup. Portal supplies the base defaults; source application bundles and their model changes are not imported. Custom provider routes declared through the shared pi-ai adapter are supported; replacement adapter plugins need their own Portal configuration.

### Run a task in the background

A terminal supervisor can start this ordinary command in its background terminal and collect the output on completion. This works equally for Codex, Claude, shell scripts, and human callers; Portal needs no caller-specific integration.

```sh
portal --models-from desktop --provider <route> --model <id> --json "review the changes in this directory"
```

Use ids from `portal models`. `--provider` requires `--model`; `--model` alone uses the configured default provider. `--reasoning-effort <id>` overrides reasoning for one invocation. Changing the route clears an inherited default effort. These options do not save a new default model.

The task can also come from stdin, or a lone `-`. Repeat `--image <path>` for image input. `--json` emits the shared [headless event stream](../headless/README.md#machine-readable-output), including a Session id and final answer. A completed task exits 0; failed or aborted tasks exit 1. Check both the process status and the terminal stream event.

`--interactive` opens a conversation through a pipe or background terminal without a TTY. Send task lines or slash commands and keep stdin open for follow-up; `/exit` or EOF ends the conversation. This mode retains line-oriented script input and plain output without raw terminal controls; keyboard pickers are replaced by catalog listings. It cannot combine with a positional task, images, or JSON output. One-shot JSON events retain the shared headless format.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The `portal` executable uses the same profile launcher as `dsh --profile portal`. The bundle publishes parsed options through `portalStartup`; its runner delegates one-shot work to `dsh-headless` and uses that package's sequential task runner for terminal conversations. One exclusively owned Agent retains history, model selection, and persistence across terminal turns. Pure renderers format conversation facts and Agent activity; terminal input owns editing and keyboard pickers. Displayed external text has terminal control sequences removed. Root disposal closes terminal input and disposes the Agent.

The patch disables HMR and automatic memory review. It inherits the base tools and permission policy. No runtime invariant companion is published because the observable relationships are terminal output, Session persistence, and process lifetime, exercised through the real CLI composition.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [CLI](../../../apps/cli/README.md) — profile launch and configuration overlays.
- [Shared runner](../headless/README.md) — JSON output, images, and Session adoption rules.
- [Model adapters](../../llm/llm-pi-ai/README.md) — provider routes and credential references.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through ordinary user messages and the shared Agent model selection installer.

#### KV Cache effect

The terminal retains one Session; selecting a different model retains history but changes the provider request route and can prevent cache reuse.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Images and JSON output require one-shot mode.
- Approval requests without an available answerer fail closed under the inherited policy.
- Session adoption keeps the shared runner's working-directory, ownership, and preset restrictions.
- Model discovery lists configured catalogs; it does not test credentials or guarantee provider availability.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
