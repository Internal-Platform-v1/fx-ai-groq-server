import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();

const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

/*
  For testing, this allows all origins.
  Later, we can restrict this to your GitHub Pages domain only.
*/
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "FX AI Groq Assistant Server",
    message: "Server is running."
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    hasGroqKey: Boolean(GROQ_API_KEY)
  });
});

app.post("/api/ai-decision", async (req, res) => {
  try {
    if (!GROQ_API_KEY) {
      return res.status(500).json({
        ok: false,
        error: "Missing GROQ_API_KEY environment variable."
      });
    }

    const { concern, matches } = req.body || {};

    if (!concern || typeof concern !== "string") {
      return res.status(400).json({
        ok: false,
        error: "Missing concern."
      });
    }

    const safeMatches = Array.isArray(matches) ? matches.slice(0, 3) : [];

    const guideContext = safeMatches.map((item, index) => {
      const guide = item.guide || {};
      const node = item.node || {};

      return `
MATCH ${index + 1}
Guide Title: ${guide.title || node.guideTitle || "Unknown guide"}
Guide URL: ${guide.url || node.guideUrl || ""}
Category: ${guide.category || node.category || ""}
Node ID: ${node.nodeId || ""}
Node Type: ${node.type || ""}
Node Text: ${node.text || ""}
Help: ${node.help || ""}
Note: ${node.note || ""}
Choices: ${(node.choices || []).join(", ")}
Final Recommendation: ${node.finalRecommendation || ""}
Score: ${item.score || ""}
      `.trim();
    }).join("\n\n");

    const systemPrompt = `
You are the AI Decision Assistant for an internal Decision Support System.

Rules:
- Use ONLY the provided guide/node context.
- Do not invent policy.
- If the context is not enough, ask 1 clear follow-up question.
- Keep the answer concise and useful for a case worker.
- Use simple English.
- Do not mention that you are using Groq.
- Do not say "based on the context" repeatedly.
- If there is a final recommendation, clearly state it.
- If the match is a decision step, tell the user what to check next.

Return the response in this format:

Recommended Guide:
[guide title]

Recommended Action:
[action]

Why:
[short reason]

Next Step:
[next step or follow-up question]
    `.trim();

    const userPrompt = `
Customer / case concern:
${concern}

Top guide/node matches:
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
        temperature: 0.2,
        max_tokens: 500,
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
    const answer = data?.choices?.[0]?.message?.content || "";

    return res.json({
      ok: true,
      answer
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
  console.log(`FX AI Groq Assistant Server running on port ${PORT}`);
});