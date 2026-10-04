---
description: "Explicit OpenAI Images, OpenRouter Images, and Gemini image-generation HTTP routes with bounded requests."
kind: "package-reference"
---

# @deepseek-ai/dsh-image-generation-http

English | [中文](README.zh.md)

## Summary

This provider implements `ctx.imageGeneration` for explicitly configured image models. An empty `providers` dictionary leaves the service dormant. The base bundle mounts this plugin; enabling a route activates its image tools without changing the chat model.

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

Configure `providers` with named routes containing `api`, `baseURL`, and a nonempty `models` allowlist. `apiKeyEnv` names a [credential reference](../../credentials/credentials/README.md), resolved for every generation through `ctx.credentials` or the captured launch environment when that service is absent. `headers` supplies deployment headers; keep secrets in credential references.

| `api` | Operation appended to `baseURL` | Response |
|---|---|---|
| `openai-images` | `/images/generations` | `data[].b64_json` |
| `openrouter-images` | `/images` | `data[].b64_json` |
| `google-generate-content` | `/models/<model>:generateContent` | first candidate's visible text and `inlineData` |

API roots include their version segment. Configure only models supporting the selected image protocol and available to the account. Image-input metadata and chat catalogs do not populate this allowlist.

`timeoutMs` defaults to 300000 and covers credential waiting, fetch, and complete body receipt. `maxResponseBytes` defaults to 33554432 and bounds encoded response bytes, including JSON and base64. [Attachment limits](../../attachment/attachment-local/README.md) apply separately when the consumer persists decoded images. See [Generate images](../../../docs/user/guide/image-generation.md) for an executable overlay.

<a id="understand-the-implementation"></a>
## Understand the implementation

Configuration validation rejects unsupported protocols, blank or duplicate model ids, missing model lists, invalid credential references or headers, and API roots with embedded credentials, query strings, or fragments. Prepared requests capture detached configuration. Caller cancellation, deadline, or disposal stops outstanding requests; disposal awaits their settlement.

Requests never retry automatically or follow redirects. HTTP errors, refusals, malformed JSON/base64, unsupported raster formats, mismatched declared media types, and responses without final images fail the generation. Gemini thought parts are omitted. The provider receives inline bytes only and does not download remote image URLs.

No runtime invariant companion is published because request settlement and service disposal have one owner without independently maintained projections.

<a id="further-exploration"></a>
## Further Exploration

- [Image-generation service](../image-generation/README.md) — provider and consumer obligations.
- [OpenAI Images API](https://developers.openai.com/api/docs/guides/image-generation), [OpenRouter Images API](https://openrouter.ai/docs/guides/overview/multimodal/image-generation), and [Gemini generateContent](https://ai.google.dev/gemini-api/docs/generate-content/image-generation) — supported wire operations.

<a id="model-experience"></a>
## Model Experience

### Image API requests

#### What the model sees

The provider sends the consumer's `prompt` to the selected image API and returns visible `text` and image bytes to the consumer. The consumer owns chat content.

#### Token effect

The provider contributes no chat prompt tokens. Image API billing is independent of chat token measurement.

#### KV Cache effect

The `image-generation-http` provider does not modify chat requests or their cached prefixes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Text-to-image requests use provider defaults for dimensions, quality, and format.
- URL-only responses, SVG, legacy DALL-E response-format options, image editing, and partial streaming are unsupported.
- Image-generation usage and cost are not added to the chat token meter.
- Configured models require valid credentials and provider entitlement at execution time.

<a id="dev-note"></a>
### Dev Note

None.
