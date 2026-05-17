import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();

const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

app.use(cors());
app.use(express.json({ limit: "3mb" }));

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

function cleanText(value, maxLength = 1200) {
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

function buildConversationText(conversation = []) {
  if (!Array.isArray(conversation)) return "None";

  return conversation.slice(-12).map((item, index) => {
    const role = cleanText(item.role || "user", 40);
    const content = cleanText(item.content || "", 800);
    return content ? `${index + 1}. ${role}: ${content}` : "";
  }).filter(Boolean).join("\n") || "None";
}

function buildGuideNodeContext(guides = []) {
  if (!Array.isArray(guides)) return "No guide node maps were provided.";

  return guides.slice(0, 3).map((guideItem, guideIndex) => {
    const guide = guideItem.guide || {};
    const nodes = Array.isArray(guideItem.nodes) ? guideItem.nodes.slice(0, 120) : [];

    const nodeLines = nodes.map((node, nodeIndex) => {
      const choices = Array.isArray(node.choicesDetailed)
        ? node.choicesDetailed.map(choice => {
            const label = cleanText(choice.label, 120);
            const next = cleanText(choice.next, 120);
            const desc = cleanText(choice.desc, 160);
            return `${label}${next ? ` -> ${next}` : ""}${desc ? ` (${desc})` : ""}`;
          }).join(" | ")
        : "";

      return `
NODE ${nodeIndex + 1}
ID: ${cleanText(node.nodeId, 120)}
Type: ${cleanText(node.type, 40)}
Question/Action: ${cleanText(node.text, 1000)}
Help: ${cleanText(node.help, 650)}
Note: ${cleanText(node.note, 650)}
Choices: ${choices}
Final Recommendation: ${cleanText(node.finalRecommendation, 900)}
      `.trim();
    }).join("\n\n");

    return `
GUIDE ${guideIndex + 1}
Guide ID: ${cleanText(guide.id, 120)}
Guide Title: ${cleanText(guide.title, 200)}
Guide URL: ${cleanText(guide.url, 250)}
Category: ${cleanText(guide.category, 120)}
Description: ${cleanText(guide.description, 500)}

FULL NODE MAP:
${nodeLines || "No nodes were provided for this guide."}
    `.trim();
  }).join("\n\n==============================\n\n");
}

app.post("/api/ai-decision", async (req, res) => {
  try {
    if (!GROQ_API_KEY) {
      return res.status(500).json({
        ok: false,
        error: "Missing GROQ_API_KEY environment variable."
      });
    }

    const { concern, guides, conversation } = req.body || {};

    if (!concern || typeof concern !== "string") {
      return res.status(400).json({
        ok: false,
        error: "Missing concern."
      });
    }

    const guideContext = buildGuideNodeContext(guides);
    const conversationText = buildConversationText(conversation);

    const systemPrompt = `
You are the AI Decision Assistant for an internal Decision Support System.

You will receive:
1. The customer's case concern.
2. The user's previous answers/details.
3. The FULL NODE MAP from the most relevant guide(s).

Your job:
- Review the full node map, not just one node.
- Ask the next most relevant question needed to answer the customer's concern.
- Do not ask questions that were already answered.
- Once enough information is known, provide the final recommended action from the node map.
- If the available choices do not fit, provide a backup plan.
- Use ONLY the provided node map. Do not invent policy, queue names, correction codes, fees, templates, or system steps.
- Keep the answer short and practical.
- Return valid JSON only. No markdown outside JSON.
- Do not mention Groq, model, backend, prompt, JSON, or tokens.

Important decision behavior:
- Use the customer's concern to choose the most relevant guide and path.
- If a node is a question, ask that question only when its answer is truly needed.
- If prior answers already identify the path, move forward and give the next needed question or final action.
- If the concern already maps to a final node, give the recommendation directly.
- Do not repeat the same question after it was answered.
- If the user says "none", "not sure", "none of these", or all listed options fail, use backup.

Return one of these JSON shapes:

QUESTION:
{
  "type": "question",
  "title": "Need one detail",
  "message": "Ask one short relevant question.",
  "choices": ["Choice 1", "Choice 2", "Not sure"],
  "guideTitle": "Matched guide title",
  "nodeId": "node id if known"
}

RECOMMENDATION:
{
  "type": "recommendation",
  "title": "Recommended Action",
  "action": "Direct action based on the guide node map.",
  "reason": "Short reason using the concern and answers.",
  "nextStep": "One short next step.",
  "guideTitle": "Matched guide title",
  "nodeId": "final node id if known"
}

BACKUP:
{
  "type": "backup",
  "title": "Backup Plan",
  "message": "Briefly say the listed guide options do not clearly fit.",
  "nextStep": "Ask the user for one missing detail in their own words or suggest opening the matched guide.",
  "guideTitle": "Matched guide title if known",
  "nodeId": "node id if known"
}
    `.trim();

    const userPrompt = `
CUSTOMER / CASE CONCERN:
${cleanText(concern, 1800)}

PREVIOUS USER ANSWERS / DETAILS:
${conversationText}

FULL GUIDE NODE MAP CONTEXT:
${guideContext}
    `.trim();

    const groqResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",
        temperature: 0.1,
        max_tokens: 650,
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
      return res.json({
        ok: true,
        result: {
          type: "backup",
          title: "Backup Plan",
          message: "I reviewed the guide nodes, but I need one clearer detail before deciding.",
          nextStep: "Add what the customer is asking, what the document shows, or what system detail you checked.",
          guideTitle: guides?.[0]?.guide?.title || "",
          nodeId: ""
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
