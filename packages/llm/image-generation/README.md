---
description: "Provider-independent image-generation service for compositions selecting explicit image models."
kind: "package-reference"
---

# @deepseek-ai/dsh-image-generation

English | [中文](README.zh.md)

## Summary

This package defines `ctx.imageGeneration`: discover configured image models, prepare an explicit provider/model/prompt request, and receive complete encoded raster images. A concrete provider registers the service; this package has no endpoint or configuration.

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

Mount an implementation such as [image-generation-http](../image-generation-http/README.md), then a consumer such as [tool-image-generation](../tool-image-generation/README.md). Chat model metadata describes image input independently; it never grants image generation. Providers reject unconfigured image model ids before network requests.

`prepare(request)` captures the model selection, prompt, and provider configuration for subsequent `generate(signal)` calls. Every invocation makes one generation attempt without automatic retry. The consumer validates and persists the returned bytes before exposing image references to the session log or a model. Provider text contains visible response text, excluding private reasoning.

<a id="understand-the-implementation"></a>
## Understand the implementation

The abstract `ImageGenerationProvider` owns discovery and preparation. `ImageGenerationResult` carries complete PNG, JPEG, WebP, or GIF bytes and optional text; it contains no temporary URLs. Providers own cancellation, credential resolution, and request limits. Consumers own attachment validation and durable result publication.

No runtime invariant companion is published because the abstract service has no independently observed state or relationships to compare.

<a id="further-exploration"></a>
## Further Exploration

- [LLM subsystem](../../../docs/subsystems/llm-streaming.md) — image-generation types and service methods.
- [Attachment service](../../attachment/attachment/README.md) — validation and durable references.
- [Generate images](../../../docs/user/guide/image-generation.md) — configure and use image models.

<a id="model-experience"></a>
## Model Experience

### Image-generation requests

#### What the model sees

The `ctx.imageGeneration` service contributes no prompt, tool, or transcript content. Consumers own how `ImageGenerationResult` reaches the chat model.

#### Token effect

The `ctx.imageGeneration` service adds no tokens itself; consumers own result content.

#### KV Cache effect

The `ctx.imageGeneration` service does not modify chat requests or their cached prefixes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The request supports text-to-image generation only. Editing, reference images, streamed partial images, and provider-specific quality or size controls have no shared request fields.

<a id="dev-note"></a>
### Dev Note

None.
