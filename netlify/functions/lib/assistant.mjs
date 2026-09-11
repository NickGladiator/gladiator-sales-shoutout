import { fetchSoldInRange, aggregateSold, localDateStr } from './sales.mjs';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-6';
const TZ = 'America/Toronto';

const TOOLS = [{
  name: 'get_sales_data',
  description: 'Get real sold-job sales data for a date range, broken down by rep and by service, plus a company total. Always call this before answering any question about sales figures — never estimate or guess.',
  input_schema: {
    type: 'object',
    properties: {
      start_date: { type: 'string', description: 'YYYY-MM-DD, inclusive' },
      end_date: { type: 'string', description: 'YYYY-MM-DD, inclusive' },
    },
    required: ['start_date', 'end_date'],
  },
}];

// Sophia: answers free-form questions posted in #sales about how the team is doing, by pulling
// real numbers via get_sales_data rather than guessing. Runs a short tool-use loop (Claude asks
// for data, we fetch it, Claude writes the actual answer).
export async function askSophia(question) {
  const todayStr = localDateStr(new Date().toISOString(), TZ);

  const systemPrompt = `You are Sophia, the sales assistant for Gladiator Pro Wash, an exterior cleaning and home services company in Ontario. You answer questions posted in the #sales Slack channel about how the team is doing on sales.

Today's date is ${todayStr} (America/Toronto time).

Always call get_sales_data to pull real numbers before answering — never estimate, guess, or make up figures. If asked about "this week", use the most recent Monday through today. If asked about "today", use today's date for both start and end. If no range is specified, default to today.

Keep answers conversational and encouraging, formatted for Slack (use *bold* not **bold**, simple "•" bullets, no headers). Keep it fairly brief — the key numbers and a sentence or two of color, not an exhaustive report, unless the question specifically asks for a detailed breakdown.`;

  const messages = [{ role: 'user', content: question }];

  for (let turn = 0; turn < 4; turn++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system: systemPrompt,
        tools: TOOLS,
        messages,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Claude API error ${res.status}: ${errText}`);
    }

    const data = await res.json();
    messages.push({ role: 'assistant', content: data.content });

    const toolUse = data.content.find(b => b.type === 'tool_use');
    if (!toolUse) {
      const textBlock = data.content.find(b => b.type === 'text');
      return textBlock?.text || "I wasn't able to put together an answer for that.";
    }

    let toolResultText;
    try {
      const sold = await fetchSoldInRange(toolUse.input.start_date, toolUse.input.end_date, TZ);
      toolResultText = JSON.stringify(aggregateSold(sold));
    } catch (err) {
      toolResultText = JSON.stringify({ error: err.message });
    }

    messages.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: toolResultText }],
    });
  }

  return "Sorry, I'm having trouble pulling that together right now — try asking again in a bit.";
}
