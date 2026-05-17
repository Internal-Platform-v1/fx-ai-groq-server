import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();

const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "FX AI Decision Assistant Server",
    message: "Server is running."
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    hasGroqKey: Boolean(GROQ_API_KEY)
  });
});

function cleanText(value, maxLength = 900) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function extractJsonFromText(text) {
  const raw = String(text || "").trim();

  try {
    return JSON.parse(raw);
  } catch {
    // Continue below.
  }

  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");

  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(raw.slice(firstBrace, lastBrace + 1));
    } catch {
      return null;
    }
  }

  return null;
}

function buildGuideContext(matches = []) {
  return matches.slice(0, 5).map((item, index) => {
    const guide = item.guide || {};
    const node = item.node || {};

    return `
MATCH ${index + 1}
Guide Title: ${cleanText(guide.title || node.guideTitle || "Unknown guide")}
Guide URL: ${cleanText(guide.url || node.guideUrl || "")}
Category: ${cleanText(guide.category || node.category || "")}
Node ID: ${cleanText(node.nodeId || "")}
Node Type: ${cleanText(node.type || "")}
Node Text: ${cleanText(node.text || "", 1200)}
Help: ${cleanText(node.help || "", 800)}
Note: ${cleanText(node.note || "", 800)}
Choices: ${Array.isArray(node.choices) ? node.choices.map(c => cleanText(c, 120)).join(" | ") : ""}
Final Recommendation: ${cleanText(node.finalRecommendation || "", 1200)}
Score: ${item.score || ""}
    `.trim();
  }).join("\n\n");
}

function buildConversationText(conversation = []) {
  if (!Array.isArray(conversation)) return "None";

  return conversation.slice(-10).map((item, index) => {
    const question = cleanText(item.question || "", 350);
    const answer = cleanText(item.answer || "", 350);
    const detail = cleanText(item.detail || "", 500);

    if (question || answer) {
      return `${index + 1}. Question: ${question || "N/A"} | Answer: ${answer || "N/A"}`;
    }

    if (detail) {
      return `${index + 1}. User detail: ${detail}`;
    }

    return "";
  }).filter(Boolean).join("\n") || "None";
}

app.post("/api/ai-decision", async (req, res) => {
  try {
    if (!GROQ_API_KEY) {
      return res.status(500).json({
        ok: false,
        error: "Missing GROQ_API_KEY environment variable."
      });
    }

    const { concern, matches, conversation } = req.body || {};

    if (!concern || typeof concern !== "string") {
      return res.status(400).json({
        ok: false,
        error: "Missing concern."
      });
    }

    const safeMatches = Array.isArray(matches) ? matches.slice(0, 5) : [];
    const guideContext = buildGuideContext(safeMatches);
    const conversationText = buildConversationText(conversation);

    const systemPrompt = `
You are the AI Decision Assistant for an internal Decision Support System.

Goal:
Ask the most relevant question needed to answer the customer's case concern, then give the final recommended action once enough information is known.

Strict rules:
- Use ONLY the provided guide/node context.
- Do not invent policy, queues, correction codes, fees, templates, or system steps.
- Do NOT repeat a question that has already been answered in the conversation.
- Read the conversation answers carefully and move forward.
- Ask only ONE question at a time.
- The question must be relevant to deciding the customer's concern.
- If the matched context is already a final recommendation, give the recommendation.
- If the user answered "Not sure", "None", "None fit", or the possible choices do not fit, use the backup plan.
- Keep wording short and simple.
- Return valid JSON only. Do not include markdown outside JSON.
- Do not mention Groq, AI model, backend, prompt, JSON, or token.

Use this JSON shape when you need one more detail:
{
  "type": "question",
  "title": "Need one detail",
  "message": "Ask one short relevant question.",
  "choices": ["Choice 1", "Choice 2", "Not sure"],
  "guideTitle": "Matched guide title",
  "nodeId": "matched node id"
}

Use this JSON shape when you can answer:
{
  "type": "recommendation",
  "title": "Recommended Action",
  "action": "The direct action the user should take.",
  "reason": "Short reason using the guide context and answers.",
  "nextStep": "One short next step.",
  "guideTitle": "Matched guide title",
  "nodeId": "matched node id"
}

Use this JSON shape if none of the available guide choices fit:
{
  "type": "backup",
  "title": "Backup Plan",
  "message": "Explain briefly that the listed options do not clearly fit and ask the user for one missing detail in their own words.",
  "nextStep": "Suggest checking the matched guide or browsing guides if the concern is outside the decision flow.",
  "guideTitle": "Matched guide title",
  "nodeId": "matched node id"
}

Choice button rules:
- Give 2 to 4 short choices when possible.
- Include "Not sure" only when it is useful.
- Do not include more than 5 choices.
    `.trim();

    const userPrompt = `
Customer / case concern:
${cleanText(concern, 1600)}

Conversation answers already provided:
${conversationText}

Top matched guide/node context:
${guideContext || "No guide/node matches were provided."}
    `.trim();

    const groqResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",
        temperature: 0.12,
        max_tokens: 520,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ]
      })
    });

    if (!groqResponse.ok) {
      const errorText = await groqResponse.text();

      return res.status(groqResponse.status).json({
        ok: false,
        error: "Groq request failed.",
        details: errorText
      });
    }

    const data = await groqResponse.json();
    const content = data?.choices?.[0]?.message?.content || "";
    const parsed = extractJsonFromText(content);

    if (!parsed || !parsed.type) {
      const first = safeMatches[0] || {};
      const node = first.node || {};
      const guide = first.guide || {};

      return res.json({
        ok: true,
        result: {
          type: "backup",
          title: "Backup Plan",
          message: "I found a possible match, but I need one clearer detail before deciding.",
          nextStep: "Add the customer concern in your own words or open the matched guide to verify.",
          guideTitle: guide.title || node.guideTitle || "",
          nodeId: node.nodeId || ""
        }
      });
    }

    return res.json({
      ok: true,
      result: parsed
    });

  } catch (error) {
    console.error("AI decision error:", error);

    return res.status(500).json({
      ok: false,
      error: "Server error while generating AI decision."
    });
  }
});

app.listen(PORT, () => {
  console.log(`FX AI Decision Assistant Server running on port ${PORT}`);
});
