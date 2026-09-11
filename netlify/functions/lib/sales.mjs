
import { fetchGif } from './giphy.mjs';

const HCP_API_KEY = process.env.HCP_API_KEY;
const BASE = 'https://api.housecallpro.com';
const headers = { Authorization: `Token ${HCP_API_KEY}`, 'Content-Type': 'application/json' };

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_SALES_CHANNEL_ID = process.env.SLACK_SALES_CHANNEL_ID;

// YYYY-MM-DD in a given IANA timezone.
export function localDateStr(iso, tz) {
  if (!iso) return null;
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(new Date(iso));
  } catch {
    return new Date(iso).toISOString().slice(0, 10);
  }
}

// A job's invoice_number is either plain ("8250") or has a segment suffix ("8250-2") when the
// job was split into multiple parts after the fact — confirmed against real account data, where
// split-off segments share a base invoice number with the original job. Only the base job (no
// suffix) or its first segment ("-1") represents the actual sale; "-2", "-3", etc. are splits of
// work already counted and would double the dollar amount if counted again.
function isSegmentSplit(invoiceNumber) {
  const match = /^(.+)-(\d+)$/.exec(invoiceNumber || '');
  if (!match) return false;
  return match[2] !== '1';
}

// Your team tags estimates/jobs with the rep's first name (confirmed from your account's actual
// tag colors) as the real "who sold this" signal — assigned_employees is the field tech doing
// the work, not necessarily the seller, and defaulted to office staff often enough that most
// sales were coming back "Unassigned". Update this list if reps change.
const REP_TAG_NAMES = ['James', 'Duncan', 'Sinead', 'Jen', 'Nick', 'Lilly', 'Zach', 'Kaleigh', 'Braden'];

function findRepTag(tags) {
  if (!Array.isArray(tags)) return null;
  for (const tag of tags) {
    const match = REP_TAG_NAMES.find(name => name.toLowerCase() === String(tag).trim().toLowerCase());
    if (match) return match;
  }
  return null;
}

// The rep who SOLD it — checked in order of reliability:
//   1. A rep-name tag on the job itself
//   2. A rep-name tag on the originating estimate (if there is one)
//   3. The estimate's assigned_employees (who built/sent it)
//   4. The job's own assigned tech, as a last resort
async function getSellingRep(job) {
  const jobTagRep = findRepTag(job.tags);
  if (jobTagRep) return jobTagRep;

  if (job.original_estimate_id) {
    try {
      const res = await fetch(`${BASE}/estimates/${job.original_estimate_id}`, { headers });
      if (res.ok) {
        const est = await res.json();

        const estTagRep = findRepTag(est.tags);
        if (estTagRep) return estTagRep;

        const rep = est.assigned_employees?.[0];
        if (rep) return `${rep.first_name} ${rep.last_name}`.trim();
      }
    } catch { /* fall through */ }
  }
  const tech = job.assigned_employees?.[0];
  return tech ? `${tech.first_name} ${tech.last_name}`.trim() : 'Unassigned';
}

// Pages through /jobs (newest-created first) collecting jobs created in [startDateStr, endDateStr]
// (inclusive, in the given timezone). Segment splits (invoice numbers ending "-2", "-3", etc.) are
// kept SEPARATE from confirmed sales rather than dropped — sometimes a split really is just a
// phase of a job already counted (e.g. patio restoration jobs), but sometimes it's a genuine
// add-on sale (e.g. a customer adding lights partway through), and that's a judgment call, not
// something detectable from the data alone. Stops once a full page is entirely older than
// startDateStr, with a hard page cap as a safety net for wide ranges.
export async function fetchSoldInRange(startDateStr, endDateStr, tz = 'America/Toronto') {
  const PAGE_SIZE = 100;
  const MAX_PAGES = 40;
  const confirmedJobs = [];
  const splitJobs = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetch(`${BASE}/jobs?page=${page}&page_size=${PAGE_SIZE}`, { headers });
    if (!res.ok) break;
    const data = await res.json();
    const jobs = data.jobs ?? (Array.isArray(data) ? data : []);
    if (!jobs.length) break;

    let allOlderThanRange = true;

    for (const job of jobs) {
      const createdDateStr = localDateStr(job.created_at, tz);
      if (!createdDateStr) continue;
      if (createdDateStr >= startDateStr && createdDateStr <= endDateStr) {
        allOlderThanRange = false;
        (isSegmentSplit(job.invoice_number) ? splitJobs : confirmedJobs).push(job);
      } else if (createdDateStr > endDateStr) {
        allOlderThanRange = false; // still within newer territory, keep paging
      }
    }

    if (allOlderThanRange) break;
    if (jobs.length < PAGE_SIZE) break;
  }

  const toSaleRecord = async (job) => ({
    repName: await getSellingRep(job),
    service: job.job_fields?.job_type?.name || 'Unspecified service',
    amount: (job.subtotal || 0) / 100, // subtotal, not total_amount — total_amount includes tax
    customer: `${job.customer?.first_name || ''} ${job.customer?.last_name || ''}`.trim(),
    dateSold: localDateStr(job.created_at, tz),
    invoiceNumber: job.invoice_number || null,
  });

  const sold = [];
  for (const job of confirmedJobs) sold.push(await toSaleRecord(job));

  const splits = [];
  for (const job of splitJobs) splits.push(await toSaleRecord(job));

  return { sold, splits };
}

// Shared aggregation used by both the scheduled shoutouts and Sophia's Q&A answers.
export function aggregateSold(sold) {
  const byRep = {};
  const byService = {};
  let total = 0;
  for (const s of sold) {
    byRep[s.repName] ??= { total: 0, count: 0 };
    byRep[s.repName].total += s.amount;
    byRep[s.repName].count += 1;

    byService[s.service] ??= { total: 0, count: 0 };
    byService[s.service].total += s.amount;
    byService[s.service].count += 1;

    total += s.amount;
  }
  return { byRep, byService, total, count: sold.length };
}

// Milestones worth an automatic celebration gif — per Nick: $10k+ in a day, or any single sale
// over $5k.
const BIG_DAY_TOTAL = 10000;
const BIG_SINGLE_SALE = 5000;

function formatMessage(sold, splits, gifUrl, label, tz) {
  const dateLabel = new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'long', day: 'numeric' }).format(new Date());

  const splitLines = splits.length
    ? `\n\n*⚠️ Splits needing a look — not counted in the total, check if any are actually add-on sales:*\n` +
      splits.map(s => `   • #${s.invoiceNumber}: ${s.service} — $${s.amount.toFixed(2)} (${s.customer})`).join('\n')
    : '';

  const gifLine = gifUrl ? `\n\n${gifUrl}` : '';

  if (!sold.length) {
    return `📊 *${label} — ${dateLabel}*\n\nNo confirmed sales logged yet today.${splitLines}${gifLine}`;
  }

  const { byService, total, count } = aggregateSold(sold);

  const serviceLines = Object.entries(byService)
    .sort((a, b) => b[1].total - a[1].total)
    .map(([svc, info]) => `   • ${svc} — $${info.total.toFixed(2)} (${info.count})`)
    .join('\n');

  const itemLines = sold
    .map(s => `   • ${s.service} — $${s.amount.toFixed(2)} (${s.customer})`)
    .join('\n');

  return `📊 *${label} — ${dateLabel}*\n\n*By service:*\n${serviceLines}\n\n*All sales:*\n${itemLines}\n\n*Company total: $${total.toFixed(2)}* across ${count} sale${count === 1 ? '' : 's'}${splitLines}${gifLine}`;
}

export async function postToSlack(text, threadTs) {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      channel: SLACK_SALES_CHANNEL_ID,
      text,
      unfurl_links: true, // needed so a celebration gif URL actually renders as an image, not just a link
      ...(threadTs ? { thread_ts: threadTs } : {}),
    }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack post failed: ${data.error}`);
  return data;
}

export async function runShoutout({ label, tz = 'America/Toronto' }) {
  const todayStr = localDateStr(new Date().toISOString(), tz);
  const { sold, splits } = await fetchSoldInRange(todayStr, todayStr, tz);
  const { total } = aggregateSold(sold);
  const bigSale = sold.find(s => s.amount >= BIG_SINGLE_SALE);
  const isMilestone = total >= BIG_DAY_TOTAL || !!bigSale;
  const gifUrl = isMilestone
    ? await fetchGif(bigSale ? 'huge sale celebration money' : 'celebration team success')
    : null;
  const message = formatMessage(sold, splits, gifUrl, label, tz);
  await postToSlack(message);
  return { soldCount: sold.length, splitCount: splits.length, message };
}
