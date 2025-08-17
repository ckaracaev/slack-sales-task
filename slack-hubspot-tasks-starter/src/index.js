import express from 'express';
import Bolt from '@slack/bolt';
const { App, LogLevel, ExpressReceiver } = Bolt;
import axios from 'axios';
import cron from 'node-cron';

const {
  SLACK_BOT_TOKEN,
  SLACK_SIGNING_SECRET,
  HUBSPOT_TOKEN,
  DIGEST_CHANNEL_ID,
  PORT = 3000,
} = process.env;

if (!SLACK_BOT_TOKEN || !SLACK_SIGNING_SECRET || !HUBSPOT_TOKEN) {
  console.error('Missing environment variables. Check SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, HUBSPOT_TOKEN.');
  process.exit(1);
}

// --- ExpressReceiver so we can mount well-known paths ---
const receiver = new ExpressReceiver({
  signingSecret: SLACK_SIGNING_SECRET,
  endpoints: {
    events: '/slack/events',
    commands: '/slack/commands'
  }
});

const app = new (App) ({
  token: SLACK_BOT_TOKEN,
  receiver,
  logLevel: LogLevel.INFO
});

// --- HubSpot client ---
const hs = axios.create({
  baseURL: 'https://api.hubapi.com',
  headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` }
});

async function searchDeals(query) {
  try {
    if (query && query.trim()) {
      const body = {
        filterGroups: [{
          filters: [{ propertyName: 'dealname', operator: 'CONTAINS_TOKEN', value: query }]
        }],
        properties: ['dealname','dealstage','amount'],
        limit: 10
      };
      const res = await hs.post('/crm/v3/objects/deals/search', body);
      return res.data.results ?? [];
    } else {
      const res = await hs.get('/crm/v3/objects/deals', { params: { limit: 10, properties: 'dealname' }});
      return res.data.results ?? [];
    }
  } catch (e) {
    console.error('searchDeals error', e.response?.data || e.message);
    return [];
  }
}

async function listOwners(query) {
  try {
    const res = await hs.get('/crm/v3/owners/');
    let owners = res.data.results ?? [];
    if (query && query.trim()) {
      const q = query.toLowerCase();
      owners = owners.filter(o =>
        (o.firstName && o.firstName.toLowerCase().includes(q)) ||
        (o.lastName && o.lastName.toLowerCase().includes(q)) ||
        (o.email && o.email.toLowerCase().includes(q))
      );
    }
    return owners.slice(0, 20);
  } catch (e) {
    console.error('listOwners error', e.response?.data || e.message);
    return [];
  }
}

async function createHsTask({ title, desc, dueISO, ownerId, dealId }) {
  const props = {
    hs_task_subject: title,
    hs_task_body: desc || '',
    hs_task_status: 'NOT_STARTED',
    hs_task_priority: 'NONE'
  };
  if (dueISO) props.hs_timestamp = new Date(dueISO).getTime();
  if (ownerId) props.hubspot_owner_id = ownerId;

  const created = await hs.post('/crm/v3/objects/tasks', { properties: props });
  const taskId = created.data.id;

  // Associate task to deal
  await hs.put(`/crm/v4/objects/tasks/${taskId}/associations/deals/${dealId}/task_to_deal`, {});

  return taskId;
}

async function completeHsTask(taskId) {
  await hs.patch(`/crm/v3/objects/tasks/${taskId}`, { properties: { hs_task_status: 'COMPLETED' } });
}

// --- Slash command opens modal ---
app.command('/task', async ({ ack, client, body }) => {
  await ack();
  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: 'modal',
      callback_id: 'create_task_modal',
      title: { type: 'plain_text', text: 'New HubSpot Task' },
      submit: { type: 'plain_text', text: 'Create' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        {
          type: 'input',
          block_id: 'deal_block',
          label: { type: 'plain_text', text: 'Deal' },
          element: {
            type: 'external_select',
            action_id: 'deal_select',
            min_query_length: 0,
            placeholder: { type: 'plain_text', text: 'Search deals...' }
          }
        },
        {
          type: 'input',
          block_id: 'title_block',
          label: { type: 'plain_text', text: 'Task title' },
          element: { type: 'plain_text_input', action_id: 'title_input' }
        },
        {
          type: 'input',
          block_id: 'desc_block',
          optional: true,
          label: { type: 'plain_text', text: 'Description' },
          element: { type: 'plain_text_input', multiline: true, action_id: 'desc_input' }
        },
        {
          type: 'input',
          block_id: 'owner_block',
          optional: true,
          label: { type: 'plain_text', text: 'Assignee (HubSpot Owner)' },
          element: {
            type: 'external_select',
            action_id: 'owner_select',
            min_query_length: 0,
            placeholder: { type: 'plain_text', text: 'Search owners...' }
          }
        },
        {
          type: 'input',
          block_id: 'date_block',
          label: { type: 'plain_text', text: 'Due date' },
          element: { type: 'datepicker', action_id: 'due_date' }
        },
        {
          type: 'input',
          block_id: 'time_block',
          optional: true,
          label: { type: 'plain_text', text: 'Due time (optional)' },
          element: { type: 'timepicker', action_id: 'due_time' }
        }
      ]
    }
  });
});

// --- Options handlers for external_selects ---
app.options('deal_select', async ({ options, ack }) => {
  const items = await searchDeals(options.value || '');
  const opts = items.map(d => ({
    text: { type: 'plain_text', text: (d.properties?.dealname || `Deal ${d.id}`).slice(0, 75) },
    value: d.id
  }));
  await ack({ options: opts });
});

app.options('owner_select', async ({ options, ack }) => {
  const owners = await listOwners(options.value || '');
  const opts = owners.map(o => ({
    text: { type: 'plain_text', text: `${o.firstName ?? ''} ${o.lastName ?? ''}`.trim() || o.email },
    value: o.id
  }));
  await ack({ options: opts });
});

// --- View submission: create task and DM confirmation ---
app.view('create_task_modal', async ({ ack, body, view, client }) => {
  await ack();
  const getVal = (block, action) => view.state.values?.[block]?.[action]?.value;
  const getSel = (block, action) => view.state.values?.[block]?.[action]?.selected_option?.value;

  const dealId = getSel('deal_block', 'deal_select');
  const title = getVal('title_block', 'title_input');
  const desc = getVal('desc_block', 'desc_input');
  const ownerId = getSel('owner_block', 'owner_select');
  const dueDate = getVal('date_block', 'due_date'); // YYYY-MM-DD
  const dueTime = getVal('time_block', 'due_time'); // HH:mm (optional)

  const dueISO = dueDate
    ? (dueTime ? `${dueDate}T${dueTime}:00` : `${dueDate}T17:00:00`)
    : undefined;

  try {
    const hsTaskId = await createHsTask({ title, desc, dueISO, ownerId, dealId });

    await client.chat.postMessage({
      channel: body.user.id,
      text: `Task created: ${title}`,
      blocks: [
        { type: 'section',
          text: { type: 'mrkdwn', text: `*${title}*
Linked deal: \`${dealId}\`
${desc || ''}
Due: ${dueDate || '—'} ${dueTime || ''}` }
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: '✅ Mark Complete' },
              value: JSON.stringify({ hsTaskId }),
              action_id: 'complete_task'
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: 'View in HubSpot' },
              url: `https://app.hubspot.com/contacts/tasks/${hsTaskId}`
            }
          ]
        }
      ]
    });
  } catch (e) {
    console.error('create_task_modal error', e.response?.data || e.message);
    await client.chat.postMessage({
      channel: body.user.id,
      text: 'Failed to create HubSpot task. Please check logs and tokens.'
    });
  }
});

// --- Action: complete task ---
app.action('complete_task', async ({ ack, body, client, action }) => {
  await ack();
  try {
    const payload = JSON.parse(action.value);
    await completeHsTask(payload.hsTaskId);
    await client.chat.update({
      channel: body.channel?.id,
      ts: body.message?.ts,
      text: 'Task completed',
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: '✅ *Completed*' } }
      ]
    });
  } catch (e) {
    console.error('complete_task error', e.response?.data || e.message);
  }
});

// --- Daily digest 09:00 Warsaw ---
cron.schedule('0 9 * * *', async () => {
  try {
    const today = new Date(); today.setHours(0,0,0,0);
    const start = today.getTime();
    const end = start + 24*60*60*1000;

    const search = async (filters) => {
      const res = await hs.post('/crm/v3/objects/tasks/search', {
        filterGroups: [{ filters }],
        properties: ['hs_task_subject','hs_task_status','hs_timestamp','hubspot_owner_id'],
        limit: 50
      });
      return res.data.results ?? [];
    };

    const dueToday = await search([
      { propertyName: 'hs_task_status', operator: 'NEQ', value: 'COMPLETED' },
      { propertyName: 'hs_timestamp', operator: 'GTE', value: String(start) },
      { propertyName: 'hs_timestamp', operator: 'LT', value: String(end) }
    ]);

    const overdue = await search([
      { propertyName: 'hs_task_status', operator: 'NEQ', value: 'COMPLETED' },
      { propertyName: 'hs_timestamp', operator: 'LT', value: String(start) }
    ]);

    const fmt = (arr) => arr.map(t => `• ${t.properties?.hs_task_subject || `(Task ${t.id})`}`).join('\n') || '—';

    await app.client.chat.postMessage({
      channel: DIGEST_CHANNEL_ID,
      text: 'Daily Task Digest',
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: 'Daily Task Digest' } },
        { type: 'section', text: { type: 'mrkdwn', text: `*Due Today*\n${fmt(dueToday)}` } },
        { type: 'section', text: { type: 'mrkdwn', text: `*Overdue*\n${fmt(overdue)}` } }
      ]
    });
  } catch (e) {
    console.error('Digest error', e.response?.data || e.message);
  }
}, { timezone: 'Europe/Warsaw' });

// --- Health endpoint ---
receiver.app.get('/', (req, res) => res.send('OK'));

// --- Start ---
(async () => {
  await app.start(PORT);
  console.log(`⚡️ Slack app running on port ${PORT}`);
})();
