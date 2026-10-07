# Decision API

The playground supports the common text/JSON decision contract exposed by TypeSafe and compatible servers. It does not provide a model. Protocol details follow the [TypeSafe API reference](https://docs.typesafe.ai/api).

An evaluation is a JSON request to `POST /v1/systemone`:

```json
{
  "model": "YOUR_MODEL_ID",
  "state": { "fruit": "apple", "color": "red", "count": 3 },
  "questions": {
    "is_apple": {
      "type": "noul",
      "instructions": "Does the record say the fruit is an apple?"
    },
    "color": {
      "type": "choice",
      "instructions": "What color is the fruit?",
      "criteria": { "red": "Red fruit", "blue": "Blue fruit", "green": "Green fruit" }
    },
    "count": {
      "type": "score",
      "instructions": "How many apples are in the record?",
      "criteria": ["Zero apples", "One apple", "Two apples", "Three apples", "Four apples"]
    }
  }
}
```

`state` is required and accepts a string, object, or array. Instructions can use the same types. Choice criteria map names to descriptions (or `null`); score criteria list 2–10 levels from lowest to highest. Noul optionally accepts descriptions under `true` and `false`.

The response contains `model`, an `answers` map keyed by question ID, and optional `usage`. An illustrative choice answer looks like:

```json
{
  "model": "YOUR_MODEL_ID",
  "answers": {
    "color": {
      "type": "choice",
      "choice": "red",
      "probabilities": { "red": 0.8, "blue": 0.1, "green": 0.1 }
    }
  }
}
```

Providers can add `confidence`, `unknown_probability`, `abstained`, and `calibration_version`. The playground preserves these fields and does not compute replacements. Choice probabilities are a distribution over the listed options; a separate unknown field is not another bar in that distribution. Score values are weighted level indices and may be fractional. Token and timing definitions can differ by provider.

The browser's **JSON** request editor controls `state` and `questions`. Model IDs, destinations and keys come from the selected endpoint. Use **Add endpoint…** or **Endpoint settings…** in the endpoint dropdown to configure it. Imports cannot change these settings. An exported scenario adds `version: 1`, `title`, and `description` to the request's state and questions; it excludes connection configuration and credentials.

Limits: 128 KiB of state, 1 MB per scenario, 64 JSON nesting levels, up to 64 questions (8 with the Imajev profile), 2–255 choice options, and 2–10 score levels. Provider limits may be lower. The relay bounds request bodies at 1 MiB and provider replies at 2 MiB; it validates responses before they enter history. The default provider timeout is 60 seconds. Cancel aborts the connection, though provider work may continue.

Image inputs, multiple-choice selections, and provider-specific generation APIs are outside this playground's supported contract.
