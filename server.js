import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

app.use(cors());
app.use(express.json({ limit: "5mb" }));

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "FX AI Decision Assistant Server",
    version: "v8-action-aware",
    message: "Server is running."
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    hasGroqKey: Boolean(GROQ_API_KEY)
  });
});

function cleanText(value, maxLength = 1400) {
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
    // Try recovery below.
  }

  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");

  if (first !== -1 && last !== -1 && last > first) {
    try {
      return JSON.parse(raw.slice(first, last + 1));
    } catch {
      return null;
    }
  }

  return null;
}

function buildGuideSummaries(items = []) {
  if (!Array.isArray(items)) return "None";

  return items.map((item, index) => {
    const guide = item.guide || {};
    return `${index + 1}. ${cleanText(guide.title, 160)} | ${cleanText(guide.category, 80)} | ${cleanText(guide.description, 260)}`;
  }).join("\n") || "None";
}

function buildConversationText(conversation = []) {
  if (!Array.isArray(conversation)) return "None";

  return conversation.slice(-10).map((item, index) => {
    const role = cleanText(item.role || "user", 40);
    const content = cleanText(item.content || "", 850);
    return content ? `${index + 1}. ${role}: ${content}` : "";
  }).filter(Boolean).join("\n") || "None";
}

function buildNodeMap(guides = []) {
  if (!Array.isArray(guides)) return "No guide node maps were provided.";

  return guides.slice(0, 8).map((guideItem, guideIndex) => {
    const guide = guideItem.guide || {};
    const nodes = Array.isArray(guideItem.nodes) ? guideItem.nodes.slice(0, 180) : [];

    const nodeLines = nodes.map((node, nodeIndex) => {
      const choices = Array.isArray(node.choicesDetailed)
        ? node.choicesDetailed.map(choice => {
            const label = cleanText(choice.label, 140);
            const next = cleanText(choice.next, 140);
            const action = cleanText(choice.action, 380);
            const desc = cleanText(choice.desc, 180);
            const note = cleanText(choice.note, 260);

            return `${label}${next ? ` -> ${next}` : ""}${action ? ` => ACTION: ${action}` : ""}${desc ? ` (${desc})` : ""}${note ? ` NOTE: ${note}` : ""}`;
          }).join(" | ")
        : "";

      return `
NODE ${nodeIndex + 1}
ID: ${cleanText(node.nodeId, 140)}
Type: ${cleanText(node.type, 50)}
Text: ${cleanText(node.text, 1400)}
Help: ${cleanText(node.help, 800)}
Note: ${cleanText(node.note, 800)}
Choices: ${choices}
Final Recommendation: ${cleanText(node.finalRecommendation, 1400)}
      `.trim();
    }).join("\n\n");

    return `
GUIDE ${guideIndex + 1}
Guide ID: ${cleanText(guide.id, 140)}
Guide Title: ${cleanText(guide.title, 240)}
Guide URL: ${cleanText(guide.url, 280)}
Category: ${cleanText(guide.category, 140)}
Description: ${cleanText(guide.description, 700)}

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

    const { concern, guides, allGuideSummaries, conversation, localAnswer } = req.body || {};

    if (!concern || typeof concern !== "string") {
      return res.status(400).json({
        ok: false,
        error: "Missing concern."
      });
    }

    if (localAnswer && localAnswer.type === "recommendation" && localAnswer.action) {
      return res.json({ ok: true, result: localAnswer });
    }

    const asksCorrCode = /\b(corr|correction)\s*code\b/i.test(concern) || /\bcorr\b/i.test(concern);

    const systemPrompt = `
You are the AI Decision Assistant for an internal Decision Support System.

You receive:
1. The customer/case concern.
2. Previous user details.
3. All available guide summaries.
4. Full node maps from the most relevant guides.

Rules:
- Review the FULL NODE MAPS before deciding.
- Use ONLY the supplied guide/node text.
- Many guide answers are stored as choice.action. Treat ACTION inside a choice as a valid final recommendation.
- Do not invent policy, queue names, correction codes, fees, templates, or steps.
- Ask only one relevant question when required.
- Do not ask for more detail if the node map already contains the answer.
- If the customer asks for corr code / correction code, search ACTION values and final recommendations for the code.
- If no corr code exists in the loaded nodes, say that clearly and suggest opening the matched guide.
- Return valid JSON only.

JSON shapes:

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
  "reason": "Short reason using guide context.",
  "nextStep": "One short next step.",
  "guideTitle": "Matched guide title",
  "nodeId": "node id if known"
}

BACKUP:
{
  "type": "backup",
  "title": "Backup Plan",
  "message": "Briefly say why the loaded guide nodes are not enough.",
  "nextStep": "Suggest the best manual fallback.",
  "guideTitle": "Matched guide title if known",
  "nodeId": "node id if known"
}
    `.trim();

    const userPrompt = `
CUSTOMER / CASE CONCERN:
${cleanText(concern, 2000)}

CORRECTION CODE REQUEST:
${asksCorrCode ? "YES - do not ask general clarification; answer from ACTION/final node if available." : "NO"}

PREVIOUS USER DETAILS:
${buildConversationText(conversation)}

ALL AVAILABLE GUIDE SUMMARIES:
${buildGuideSummaries(allGuideSummaries?.length ? allGuideSummaries : guides)}

FULL NODE MAPS SENT FOR REVIEW:
${buildNodeMap(guides)}
    `.trim();

    const groqResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",
        temperature: 0.05,
        max_tokens: 850,
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
          message: asksCorrCode
            ? "I reviewed the loaded guide nodes but could not find a specific correction code answer."
            : "I reviewed the loaded guide nodes but could not find enough information to answer.",
          nextStep: "Open the matched guide or add the missing detail.",
          guideTitle: guides?.[0]?.guide?.title || "",
          nodeId: ""
        }
      });
    }

    if (asksCorrCode && parsed.type === "question") {
      return res.json({
        ok: true,
        result: {
          type: "backup",
          title: "Correction Code Not Found",
          message: "I reviewed the loaded guide nodes but could not find a specific correction code answer.",
          nextStep: "Open the matched Correction Code Guide or add the missing scenario detail.",
          guideTitle: parsed.guideTitle || guides?.[0]?.guide?.title || "",
          nodeId: parsed.nodeId || ""
        }
      });
    }

    return res.json({ ok: true, result: parsed });
  } catch (error) {
    console.error("AI decision error:", error);
    return res.status(500).json({
      ok: false,
      error: "Server error while generating AI decision."
    });
  }
});

app.listen(PORT, () => {
  console.log(`FX AI Decision Assistant Server v8 action-aware running on port ${PORT}`);
});
