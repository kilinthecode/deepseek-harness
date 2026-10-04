# Generate images

English | [中文](image-generation.zh.md)

Use an image-generation model alongside your configured chat model. The agent discovers the available image models and returns images with downloadable originals. A model's ability to read images does not imply that it can generate them.

## Enable an image model

You need an API key and access to the image model on the selected provider. Put the key in your launch environment or the harness's credential store; configuration contains only its reference.

The [OpenAI example overlay](../../../apps/cli/config/examples/image-generation.patch.yml) enables one explicit image model. Change the model id if your account uses another GPT Image model, then launch your usual profile with the overlay:

```sh
pnpm dsh web --patch apps/cli/config/examples/image-generation.patch.yml
```

For a persistent setup, copy the overlay's plugin entry into `$DSH_HOME/profiles/<profile>/cordis.patch.yml` and restart that profile. You can also use the same overlay with `dsh --profile headless --patch <path> "Generate a watercolor owl"`.

## Choose a provider

The [HTTP provider reference](../../../packages/llm/image-generation-http/README.md) defines the route fields and limits. Each route lists exact image models; the chat model picker remains separate. Use the provider's current documentation to select an available model.

| Provider | `api` | `baseURL` | Typical credential reference |
|---|---|---|---|
| [OpenAI](https://developers.openai.com/api/docs/guides/image-generation) | `openai-images` | `https://api.openai.com/v1` | `OPENAI_API_KEY` |
| [OpenRouter](https://openrouter.ai/docs/guides/overview/multimodal/image-generation) | `openrouter-images` | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` |
| [Gemini](https://ai.google.dev/gemini-api/docs/generate-content/image-generation) | `google-generate-content` | `https://generativelanguage.googleapis.com/v1` | `GEMINI_API_KEY` |

OpenAI and OpenRouter routes require models returning inline raster images. Gemini routes require models supporting image output through `generateContent`. SVG and URL-only outputs are unsupported.

## Generate and save

Ask: “List the image models, then generate a watercolor owl using the OpenAI image model.” The agent uses `list_image_models` to find configured routes and `generate_image` with an explicit provider, model, and prompt. Describe the subject, composition, style, and desired text in the prompt.

Each successful result includes a preview and an original file named `generated-1.png` or the corresponding image extension. Download the original for editing or publishing; previews can be normalized for chat display. Generated references stay in the saved conversation.

Image generation uses the provider's size and quality defaults and can incur separate API charges. Requests do not automatically retry. A missing key, unsupported model, refusal, response limit, or storage failure appears as a tool error; repair the cause before requesting another generation.
