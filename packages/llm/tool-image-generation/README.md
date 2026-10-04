---
description: "Image-model discovery and generation tools that persist previews and exact original files."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-image-generation

English | [中文](README.zh.md)

## Summary

This consumer exposes image-model discovery and text-to-image generation over `ctx.imageGeneration`. Successful generation returns viewable image attachments together with downloadable original files. The base bundle includes the plugin; tools activate when an image provider and attachment store are available.

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

Mount the [HTTP provider](../image-generation-http/README.md), `ctx.tools`, and an [attachment store](../../attachment/attachment-local/README.md). The plugin has no configuration. Ask the agent to discover image models and generate an image using an explicit configured provider/model. See [Generate images](../../../docs/user/guide/image-generation.md) for setup.

`list_image_models` returns the configured provider/model identities and display names. `generate_image` requires `provider`, `model`, and `prompt`; it rejects missing selections or unconfigured models. [Tool catalog](../../../docs/tool-catalog.md) owns the exact schemas.

<a id="understand-the-implementation"></a>
## Understand the implementation

The tool prepares one image request, receives the complete response, validates the whole image batch through the attachment store, and saves each original file without changing its bytes. It publishes a summary, optional provider text, normalized image previews, and original file references only after storage succeeds. Preview normalization can alter encoding or dimensions; the accompanying original preserves the generated asset.

Tool results use existing image and file blocks, so session logs retain the references and chat history displays the images. Subsequent image-capable chat models receive previews; text-only models receive attachment descriptors. Original files are represented by file handles for every chat model. The generic tool presenter displays the model and prompt; the shared image gallery displays results.

No runtime invariant companion is published because the tools registry owns registrations and their disposers, and this consumer maintains no independent registry.

<a id="further-exploration"></a>
## Further Exploration

- [Image-generation service](../image-generation/README.md) — model selection and provider results.
- [Attachment subsystem](../../../docs/subsystems/attachment.md) — normalized previews and verbatim originals.

<a id="model-experience"></a>
## Model Experience

### Image-generation tool schemas and results

#### What the model sees

The [`list_image_models` and `generate_image` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-image-generation) describe discovery and explicit `provider`, `model`, and `prompt` selection. Generation appends a deterministic summary, visible provider text when supplied, and one image/file pair per generated image. Tool calls and results follow the ordinary durable session path; no additional system prompt is injected.

##### Stable summary example

```markdown
Generated 1 image(s) with fixture/draw. Original files are attached.
```

#### Token effect

Tool schemas contribute request tokens while active; `list_image_models` results grow with configured models. Text-only requests carry descriptors rather than image bytes; image-capable requests add preview input costs according to their route.

#### KV Cache effect

Tool schemas remain stable across provider/model changes. `generate_image` results append to conversation history; configuring the provider activates the tools and changes the request's tool declarations.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The tools expose text-to-image generation only.
- Storage failure or cancellation can leave unreferenced immutable objects; it never publishes an incomplete success.
- Repeating a tool call creates another billable provider request.
- Image models are configured separately from the chat model picker.

<a id="dev-note"></a>
### Dev Note

None.
