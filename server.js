import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

app.use(cors());
app.use(express.json({ limit: "4mb" }));

app.get("/", (req, res) => res.json({ ok: true, service: "FX AI Decision Assistant Server", version: "v6" }));
app.get("/health", (req, res) => res.json({ ok: true, hasGroqKey: Boolean(GROQ_API_KEY) }));

function cleanText(value, maxLength = 1200) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function extractJsonFromText(text) {
  const raw = String(text || "").trim();
  try { return JSON.parse(raw); } catch {}
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    try { return JSON.parse(raw.slice(first, last + 1)); } catch { return null; }
  }
  return null;
}

function buildGuideSummaries(guides = []) {
  if (!Array.isArray(guides)) return "None";
  return guides.map((item, i) => {
    const g = item.guide || {};
    return `${i + 1}. ${cleanText(g.title, 160)} | ${cleanText(g.category, 80)} | ${cleanText(g.description, 260)}`;
  }).join("\n") || "None";
}

function buildConversationText(conversation = []) {
  if (!Array.isArray(conversation)) return "None";
  return conversation.slice(-10).map((m, i) => {
    const role = cleanText(m.role || "user", 40);
    const content = cleanText(m.content || "", 800);
    return content ? `${i + 1}. ${role}: ${content}` : "";
  }).filter(Boolean).join("\n") || "None";
}

function buildFullNodeContext(guides = []) {
  if (!Array.isArray(guides)) return "No guide node maps were provided.";
  return guides.slice(0, 6).map((guideItem, guideIndex) => {
    const guide = guideItem.guide || {};
    const nodes = Array.isArray(guideItem.nodes) ? guideItem.nodes.slice(0, 160) : [];
    const nodeLines = nodes.map((node, nodeIndex) => {
      const choices = Array.isArray(node.choicesDetailed)
        ? node.choicesDetailed.map(choice => {
            const label = cleanText(choice.label, 120);
            const next = cleanText(choice.next, 120);
            const desc = cleanText(choice.desc, 180);
            return `${label}${next ? ` -> ${next}` : ""}${desc ? ` (${desc})` : ""}`;
          }).join(" | ")
        : "";
      return `NODE ${nodeIndex + 1}\nID: ${cleanText(node.nodeId, 140)}\nType: ${cleanText(node.type, 50)}\nText: ${cleanText(node.text, 1200)}\nHelp: ${cleanText(node.help, 700)}\nNote: ${cleanText(node.note, 700)}\nChoices: ${choices}\nFinal Recommendation: ${cleanText(node.finalRecommendation, 1200)}`;
    }).join("\n\n");
    return `GUIDE ${guideIndex + 1}\nGuide ID: ${cleanText(guide.id, 140)}\nGuide Title: ${cleanText(guide.title, 220)}\nGuide URL: ${cleanText(guide.url, 260)}\nCategory: ${cleanText(guide.category, 120)}\nDescription: ${cleanText(guide.description, 600)}\n\nFULL NODE MAP:\n${nodeLines || "No nodes were provided for this guide."}`;
  }).join("\n\n==============================\n\n");
}

app.post("/api/ai-decision", async (req, res) => {
  try {
    if (!GROQ_API_KEY) return res.status(500).json({ ok: false, error: "Missing GROQ_API_KEY environment variable." });

    const { concern, guides, allGuideSummaries, conversation } = req.body || {};
    if (!concern || typeof concern !== "string") return res.status(400).json({ ok: false, error: "Missing concern." });

    const guideSummaries = Array.isArray(allGuideSummaries) && allGuideSummaries.length ? buildGuideSummaries(allGuideSummaries) : buildGuideSummaries(guides);
    const fullNodeContext = buildFullNodeContext(guides);
    const conversationText = buildConversationText(conversation);

    const systemPrompt = `You are the AI Decision Assistant for an internal Decision Support System.

You receive the customer's concern, previous answers/details, a list of all available guides, and FULL NODE MAPS for the most relevant guides.

Rules:
- Review the FULL NODE MAPS before deciding.
- Use ONLY the supplied guide/node text.
- Do not invent policy, queue names, correction codes, fees, templates, or system steps.
- If the customer asks for a correction code / corr code, look specifically for a correction-code guide or correction-code node in the supplied context.
- If the supplied nodes do not contain a specific correction code, say that the correction code is not available in the current guide nodes and suggest opening the Correction Code Guide. Do NOT ask an unrelated follow-up.
- Ask only ONE relevant question at a time, and only if the answer is needed.
- Do not repeat a question that was already answered.
- If enough information is available, give the final recommended action.
- If choices do not fit, provide a backup plan.
- Keep the answer short and practical.
- Return valid JSON only. No markdown outside JSON.

Return exactly one of these JSON shapes:

{"type":"question","title":"Need one detail","message":"Ask one short relevant question.","choices":["Choice 1","Choice 2","Not sure"],"guideTitle":"Matched guide title","nodeId":"node id if known"}

{"type":"recommendation","title":"Recommended Action","action":"Direct action based on the guide node map.","reason":"Short reason using the concern and answers.","nextStep":"One short next step.","guideTitle":"Matched guide title","nodeId":"final node id if known"}

{"type":"backup","title":"Backup Plan","message":"Briefly say why the current guide nodes are not enough or why the choices do not clearly fit.","nextStep":"Suggest the best manual fallback using the available guide list.","guideTitle":"Matched guide title if known","nodeId":"node id if known"}`;

    const userPrompt = `CUSTOMER / CASE CONCERN:\n${cleanText(concern, 1800)}\n\nPREVIOUS USER ANSWERS / DETAILS:\n${conversationText}\n\nALL AVAILABLE GUIDE SUMMARIES:\n${guideSummaries}\n\nFULL NODE MAPS SENT FOR REVIEW:\n${fullNodeContext}`;

    const groqResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "llama-3.1-8b-instant", temperature: 0.08, max_tokens: 700, response_format: { type: "json_object" }, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }] })
    });

    if (!groqResponse.ok) {
      const errorText = await groqResponse.text();
      return res.status(groqResponse.status).json({ ok: false, error: "Groq request failed.", details: errorText });
    }

    const data = await groqResponse.json();
    const content = data?.choices?.[0]?.message?.content || "";
    const parsed = extractJsonFromText(content);

    if (!parsed || !parsed.type) {
      return res.json({ ok: true, result: { type: "backup", title: "Backup Plan", message: "I reviewed the available guide nodes, but I could not find enough reliable information to answer this.", nextStep: "Open the matched guide or add more details from the customer concern.", guideTitle: guides?.[0]?.guide?.title || "", nodeId: "" } });
    }

    return res.json({ ok: true, result: parsed });
  } catch (error) {
    console.error("AI decision error:", error);
    return res.status(500).json({ ok: false, error: "Server error while generating AI decision." });
  }
});

app.listen(PORT, () => console.log(`FX AI Decision Assistant Server v6 running on port ${PORT}`));
