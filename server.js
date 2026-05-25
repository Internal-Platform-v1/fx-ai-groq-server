import express from 'express';
import Groq from 'groq-sdk';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

// Health check
app.get('/', (req, res) => {
  res.json({ ok: true, message: 'FX AI Groq Server is running' });
});

// Main AI decision endpoint
app.post('/api/ai-decision', async (req, res) => {
  try {
    const { concern, guides, conversation } = req.body;

    // Find the correction code guide (or use the first one)
    const targetGuide = guides?.find(g => g.guide?.id === 'correction_code_guide') || guides?.[0];
    if (!targetGuide || !targetGuide.nodes) {
      return res.status(400).json({ ok: false, error: 'No valid guide nodes provided.' });
    }

    // Convert the nodes object into a readable text representation for the AI
    const nodesText = JSON.stringify(targetGuide.nodes, null, 2);

    const systemPrompt = `You are an AI assistant for FedEx freight billing correction codes. You have access to a decision tree that defines correction codes based on a series of questions and answers.

Here is the decision tree (as JSON). Each node has a "text" (the question), "choices" (possible answers), and sometimes an "action" (the final correction code).

${nodesText}

Your task:
- Read the user's concern (plain English).
- Navigate the decision tree logically based on the user's description.
- If the description clearly matches a path that leads to an "action", return a "recommendation" with that action (the correction code), a short reason, and a next step.
- If the description is missing information, return a "question" with the next logical question from the tree and provide the possible choices as an array.
- Do not invent codes that are not present in the tree.
- Return valid JSON only, with the following structure:

{
  "type": "recommendation" | "question",
  "title": "short title",
  "action": "the correction code (for recommendation)",
  "message": "explanation or question text",
  "reason": "why this code applies",
  "nextStep": "what to do next",
  "choices": ["choice1", "choice2"] // only for question
}`;

    const userMessage = `User concern: "${concern}"\nConversation history: ${JSON.stringify(conversation || [])}`;

    const completion = await groq.chat.completions.create({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      model: "llama-3.3-70b-versatile",  // or "mixtral-8x7b-32768"
      temperature: 0.2,
      response_format: { type: "json_object" },
    });

    const aiResponse = completion.choices[0]?.message?.content;
    if (!aiResponse) throw new Error("No response from Groq");

    const result = JSON.parse(aiResponse);
    // Attach guide info for the frontend
    result.guideTitle = targetGuide.guide?.title || "Correction Code Guide";
    result.guideUrl = targetGuide.guide?.url || "#";

    res.json({ ok: true, result });
  } catch (error) {
    console.error("Groq API error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
