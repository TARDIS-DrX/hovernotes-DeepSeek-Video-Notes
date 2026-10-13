// DeepSeek call: send sampled key frames + transcript, get a text-first note back.
// Uses deepseek-flash (the vision-capable model) with JSON output.

const ENDPOINT = "https://api.deepseek.com/chat/completions";
const MODEL = "deepseek-flash";

const SYSTEM_PROMPT = `You are an expert study-note writer. You receive timestamped key frames (images) and, when available, the transcript of a video. Write a polished, self-contained Markdown study note that captures WHAT THE VIDEO TEACHES.

Return ONLY a JSON object:
{
  "title": string,
  "tags": string[],
  "summary": string,
  "markdown": string,
  "screenshots": [ { "index": number, "caption": string } ]
}

CRITICAL about the note:
- Summarize the video's ACTUAL CONTENT (concepts, arguments, steps, examples, conclusions). Do NOT describe or introduce the video itself. Never write "本视频介绍了…" / "In this video…" / "这是一个关于…的视频".
- Write so a reader learns the material WITHOUT watching the video. The note must stand on its own.
- Follow the user's requested style/tone/format if one is provided.
- Be text-first and substantial: several paragraphs and structured bullet lists, not a bare outline.
- Use "## " major sections and "### " sub-sections, **bold** key terms, \`code\` for code/identifiers, and "> [!note]" callouts for key insights.
- Ground every claim in the transcript and the frames; do not invent facts.

Screenshots (place them INLINE):
- Choose AT MOST 3 frames that genuinely illustrate the note.
- Put each image where it belongs by writing a placeholder in the markdown, e.g. "…如图所示 [[SHOT:2]]。" — the number is the provided frame index.
- List every frame you referenced in "screenshots" (index + short caption). Do not include frames you did not place.

Output language: use the language requested by the user.`;

function frameLabel(frames) {
  return frames
    .map((f, i) => `#${i} t=${f.t}s${f.reason ? " (" + f.reason + ")" : ""}`)
    .join("\n");
}

export async function generateNotes({ apiKey, meta, transcript, frames, language, stylePrompt }) {
  if (!apiKey) throw new Error("Missing DeepSeek API key.");

  const parts = [];
  parts.push({
    type: "text",
    text:
      `Video metadata:\n` +
      `title: ${(meta && meta.title) || ""}\n` +
      `author: ${(meta && meta.author) || ""}\n` +
      `source: ${(meta && meta.source) || ""}\n` +
      `output language: ${language || "same as the video"}\n` +
      `user style/instructions: ${stylePrompt ? stylePrompt : "(none)"}\n\n` +
      `Key frames (${frames.length}). Reference a frame inline with [[SHOT:<index>]]:\n` +
      `${frameLabel(frames)}\n\n` +
      `Transcript (may be empty):\n` +
      (transcript ? transcript.slice(0, 80000) : "(none)")
  });

  for (const f of frames) {
    parts.push({ type: "image_url", image_url: { url: f.dataUrl, detail: "low" } });
  }

  const body = {
    model: MODEL,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: parts }
    ],
    response_format: { type: "json_object" },
    temperature: 0.4,
    max_tokens: 12000
  };

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`DeepSeek ${res.status}: ${text.slice(0, 300)}`);
  }

  const json = await res.json();
  const content =
    json.choices && json.choices[0] && json.choices[0].message
      ? json.choices[0].message.content
      : "";
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    throw new Error("DeepSeek did not return valid JSON: " + String(content).slice(0, 200));
  }
  return parsed;
}
