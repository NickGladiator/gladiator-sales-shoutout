import { fetchSoldInRange, aggregateSold, localDateStr } from './sales.mjs';
import { fetchGif } from './giphy.mjs';

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
}, {
  name: 'send_gif',
  description: 'Search for and get a GIF to include in your reply. Use when someone explicitly asks for a gif, or when celebrating a big result if it fits the moment. Pick a search term that matches the vibe (e.g. "celebration", "excited dog", "money rain").',
  input_schema: {
    type: 'object',
    properties: {
      search_term: { type: 'string', description: 'What to search for, e.g. "celebration" or "high five"' },
    },
    required: ['search_term'],
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

The data includes a "splits" list — jobs that are segment/split-offs of an already-counted job (not part of the "confirmed" totals). Some splits are genuinely just another phase of the same sale (e.g. a patio restoration job split into cleaning/sanding visits) and shouldn't count again; others are real add-on sales the customer bought later (e.g. adding lights partway through a job) and should. You can't tell which from the data alone — when splits exist and are relevant to the question, mention them separately and ask the person to confirm which (if any) should count as additional sales, rather than guessing either way yourself.

Report on totals and by-service breakdowns only. Do NOT mention or report on which rep or tech is attached to a sale — that data isn't reliable right now (it often just reflects whichever field tech was assigned to do the work, not who actually sold it) and reporting it would be actively misleading. If someone specifically asks who sold something, say that rep attribution isn't reliable right now rather than guessing from the job data.

Keep answers conversational and encouraging, formatted for Slack (use *bold* not **bold**, simple "•" bullets, no headers). Keep it fairly brief — the key numbers and a sentence or two of color, not an exhaustive report, unless the question specifically asks for a detailed breakdown.

If someone asks for a gif, or it's a genuinely big result worth celebrating, use send_gif and include the returned URL on its own line in your reply — Slack will render it as an image automatically.`;

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

    const toolUses = data.content.filter(b => b.type === 'tool_use');
    if (!toolUses.length) {
      const textBlock = data.content.find(b => b.type === 'text');
      return textBlock?.text || "I wasn't able to put together an answer for that.";
    }

    const toolResults = [];
    for (const toolUse of toolUses) {
      let toolResultText;
      try {
        if (toolUse.name === 'get_sales_data') {
          const { sold, splits } = await fetchSoldInRange(toolUse.input.start_date, toolUse.input.end_date, TZ);
          const { byService, total, count } = aggregateSold(sold);
          toolResultText = JSON.stringify({
            confirmed: { byService, total, count },
            splits: splits.map(s => ({
              invoiceNumber: s.invoiceNumber, service: s.service, amount: s.amount, customer: s.customer,
            })),
          });
        } else if (toolUse.name === 'send_gif') {
          const url = await fetchGif(toolUse.input.search_term);
          toolResultText = JSON.stringify(url ? { gif_url: url } : { error: 'No gif found for that search term.' });
        } else {
          toolResultText = JSON.stringify({ error: `Unknown tool: ${toolUse.name}` });
        }
      } catch (err) {
        toolResultText = JSON.stringify({ error: err.message });
      }
      toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: toolResultText });
    }

    messages.push({ role: 'user', content: toolResults });
  }

  return "Sorry, I'm having trouble pulling that together right now — try asking again in a bit.";
}
