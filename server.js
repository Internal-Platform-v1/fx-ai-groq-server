import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();

const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

/*
  For first testing, this allows all origins.
  After everything works, you can restrict this to your GitHub Pages domain.
*/
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

function buildGuideContext(matches = []) {
  return matches.slice(0, 3).map((item, index) => {
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
Help: ${cleanText(node.help || "", 900)}
Note: ${cleanText(node.note || "", 900)}
Choices: ${Array.isArray(node.choices) ? node.choices.map(c => cleanText(c, 120)).join(" | ") : ""}
Final Recommendation: ${cleanText(node.finalRecommendation || "", 1200)}
Score: ${item.score || ""}
    `.trim();
  }).join("\n\n");
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
    const possibleJson = raw.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(possibleJson);
    } catch {
      return null;
    }
  }

  return null;
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

    const safeMatches = Array.isArray(matches) ? matches.slice(0, 3) : [];
    const safeConversation = Array.isArray(conversation)
      ? conversation.slice(-8).map(item => ({
          role: item.role === "assistant" ? "assistant" : "user",
          content: cleanText(item.content, 700)
        }))
      : [];

    const guideContext = buildGuideContext(safeMatches);

    const systemPrompt = `
You are the AI Decision Assistant for an internal Decision Support System.

Your job:
- Act like a decision-tree helper, not a search result summarizer.
- Use ONLY the provided guide/node context.
- Do not invent policy, queue names, correction codes, fees, or steps.
- Keep the response short and useful.
- Use simple English.
- If the guide context is not enough to decide, ask ONE follow-up question.
- If the best matched node is a question or has choices, usually ask a follow-up question using those choices.
- If the matched node is final or clearly gives an action, give the final recommendation.
- Do not mention Groq, AI model, backend, token, prompt, or JSON.

You MUST return valid JSON only. No markdown outside JSON.

Return exactly one of these two JSON shapes:

For a follow-up question:
{
  "type": "question",
  "title": "Need one detail",
  "message": "Ask one short question here.",
  "choices": ["Choice 1", "Choice 2", "Not sure"],
  "guideTitle": "Matched guide title",
  "nodeId": "matched_node_id"
}

For a recommendation:
{
  "type": "recommendation",
  "title": "Recommended Action",
  "action": "The direct action the user should take.",
  "reason": "Short reason using the guide context.",
  "nextStep": "One short next step.",
  "guideTitle": "Matched guide title",
  "nodeId": "matched_node_id"
}

Important:
- If asking a question, choices should be short button labels.
- If recommending, do not include long explanations.
- If unsure, ask a question instead of guessing.
    `.trim();

    const userPrompt = `
Case concern:
${cleanText(concern, 1500)}

Conversation so far:
${safeConversation.map(m => `${m.role}: ${m.content}`).join("\n") || "None"}

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
        temperature: 0.15,
        max_tokens: 550,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: systemPrompt
          },
          {
            role: "user",
            content: userPrompt
          }
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
      return res.json({
        ok: true,
        result: {
          type: "recommendation",
          title: "Recommended Action",
          action: cleanText(content || "Review the matched guide before proceeding.", 700),
          reason: "The assistant could not format the response perfectly, but it used the matched guide context.",
          nextStep: "Open the matched guide to confirm.",
          guideTitle: safeMatches?.[0]?.guide?.title || "",
          nodeId: safeMatches?.[0]?.node?.nodeId || ""
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
